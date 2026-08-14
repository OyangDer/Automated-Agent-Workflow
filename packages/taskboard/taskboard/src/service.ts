/**
 * The taskboard domain service: durable five-column ticket storage, the
 * agent-facing workflow tools (list/claim/complete/approve/reject), the
 * browser Remote API, and automatic reviewer spawning when a ticket enters
 * In testing. Tickets persist through the storage-domain seam; every
 * committed mutation emits the forwarded taskboard/changed event.
 * @module @deepseek-ai/dsh-taskboard
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineDomain, DomainError, domainTable,
  type Domain, type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: resolves ctx.get('subagents') through the subagent seam augmentation.
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  TASKBOARD_COLUMNS, TASKBOARD_PRIORITIES,
} from './types.ts'
import type {
  BoardSnapshot, ColumnId, CreateTicketRequest, EditTicketRequest,
  MoveTicketRequest, Priority, RemoveTicketRequest, RemoveTicketResult,
  RequestReviewRequest, TaskboardChanged, TaskboardOperation, TicketAssignee,
  TicketView,
} from './types.ts'
import {
  agentLabel, appendHistory, buildReviewPrompt, reviewerLabel,
  TaskboardError, WORKFLOW_SECTION,
} from './domain.ts'

/** The single stored ticket shape; validated at the durable boundary. */
const ticketSchema = zod.object({
  id: zod.string().min(1),
  title: zod.string().min(1),
  description: zod.string(),
  column: zod.enum(TASKBOARD_COLUMNS),
  priority: zod.enum(TASKBOARD_PRIORITIES),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  position: zod.number(),
  assignee: zod.union([
    zod.object({ agentId: zod.string().min(1), label: zod.string() }),
    zod.null(),
  ]),
  reviewer: zod.union([
    zod.object({ agentId: zod.string().min(1), label: zod.string() }),
    zod.null(),
  ]),
  reviewAttempts: zod.number().int().min(0),
  lastReview: zod.union([
    zod.object({
      outcome: zod.enum(['approved', 'rejected']),
      feedback: zod.string(),
      reviewer: zod.object({ agentId: zod.string().min(1), label: zod.string() }),
      attempt: zod.number().int().min(1),
      at: zod.number(),
    }),
    zod.null(),
  ]),
  devNotes: zod.string(),
  dependsOn: zod.array(zod.string()),
  history: zod.array(zod.object({ at: zod.number(), kind: zod.string(), detail: zod.string() })),
})

/** The taskboard storage domain declaration: one tickets table, no global. */
const TASKBOARD_DOMAIN = defineDomain({
  name: 'taskboard',
  version: 1,
  tables: {
    tickets: domainTable<string, TicketView>(ticketSchema),
  },
})

/** Deployment knobs for the taskboard workflow. */
export interface Config {
  /** How many tickets may be In progress at once (parallel developer cap). */
  maxInProgress?: number
  /** Subagent provider name used to spawn reviewer agents. */
  reviewProvider?: string
}

/** Schemastery configuration for the taskboard consumer. */
export const Config: z<Config> = z.object({
  maxInProgress: z.number().default(4),
  reviewProvider: z.string().default('spawn'),
})

/** One reviewer-spawn outcome. */
export type ReviewSpawnResult =
  | { spawned: true; reviewer: TicketAssignee }
  | { spawned: false; reason: 'unavailable' | 'failed' }

/** Tool payload: the card plus what happened to the review seat. */
export interface CompleteTicketResult {
  ticket: TicketView
  review: 'spawned' | 'unavailable' | 'failed'
  reviewerAgentId: string | null
}

/** The compact row taskboard_list returns per ticket. */
export interface TicketRow {
  id: string
  title: string
  column: ColumnId
  priority: Priority
  position: number
  assignee: TicketAssignee | null
  reviewer: TicketAssignee | null
  reviewAttempts: number
  lastReviewOutcome: 'approved' | 'rejected' | null
  dependsOn: string[]
}

/** Validate one explicit capacity knob. */
function resolveMaxInProgress(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('taskboard: maxInProgress must be a positive safe integer')
  }
  return value
}

/** Column ids as a runtime set for cheap membership checks. */
const COLUMN_SET: ReadonlySet<string> = new Set(TASKBOARD_COLUMNS)

/** True when a value is a known column id. */
function isColumn(value: string): value is ColumnId {
  return COLUMN_SET.has(value)
}

/** Normalize a user-supplied title at the domain boundary. */
function resolveTitle(value: string): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (title.length === 0) {
    throw new TaskboardError('ticket title must be a non-empty string', 'TASKBOARD_INVALID_INPUT')
  }
  return title
}

/**
 * The taskboard service (ctx.taskboard): storage-backed tickets, workflow
 * transitions, the browser Remote surface, and the model-facing tools.
 */
export class TaskboardService extends TypertRemoteService {
  static inject = ['storageDomain', 'systemPrompt', 'tools']

  static Config = Config

  private readonly resolved: { maxInProgress: number; reviewProvider: string }
  private readonly domain: Promise<Domain<typeof TASKBOARD_DOMAIN>>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'taskboard')
    this.resolved = {
      maxInProgress: resolveMaxInProgress(config.maxInProgress ?? 4),
      reviewProvider: config.reviewProvider ?? 'spawn',
    }
    this.domain = ctx.storageDomain.open(TASKBOARD_DOMAIN)
    // The open races shutdown when the host unmounts before it resolves;
    // attaching a handler keeps that rejection from surfacing as an
    // unhandled rejection, while every consumer awaiting this.domain still
    // receives the failure loudly.
    void this.domain.catch(() => {})
    ctx.effect(() => {
      const pending = this.domain
      return () => {
        // The derived chain carries its own rejection: if the open already
        // failed (shutdown race), closing is moot and must not resurface.
        void pending.then((domain) => { void domain.close() }).catch(() => {})
      }
    }, 'taskboard: domain lifetime')
    ctx.systemPrompt.section({ name: 'taskboard:workflow', order: 150, text: WORKFLOW_SECTION })
    this.registerTools()
  }

  /** Resolve the opened tickets table. */
  private async tickets(): Promise<KvTable<string, TicketView>> {
    return (await this.domain).table('tickets')
  }

  /** Translate storage-layer failures into domain errors. */
  private static translate(error: unknown, ticketId: string): never {
    if (error instanceof TaskboardError) throw error
    if (error instanceof DomainError && error.code === 'missing-key') {
      throw new TaskboardError('ticket "' + ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    throw error
  }

  /**
   * Run one validated record transform on the domain write chain, then emit
   * the forwarded change event with the committed post-state.
   */
  private async mutate(
    ticketId: string,
    operation: TaskboardOperation,
    fn: (current: TicketView) => TicketView,
  ): Promise<TicketView> {
    const table = await this.tickets()
    try {
      const next = await table.update(ticketId, fn)
      const change: TaskboardChanged = { operation, ticketId, ticket: next }
      this.ctx.emit('taskboard/changed', change)
      return next
    } catch (error) {
      TaskboardService.translate(error, ticketId)
      /* v8 ignore next -- translate always throws */
      throw error
    }
  }

  /** Compute the position between two anchors inside a column. */
  private positionBetween(
    table: KvTable<string, TicketView>,
    column: ColumnId,
    beforeTicketId: string | null,
    afterTicketId: string | null,
  ): number {
    const rows = [...table.entries()]
      .map(([, ticket]) => ticket)
      .filter(ticket => ticket.column === column)
      .sort((a, b) => a.position - b.position)
    const before = beforeTicketId === null ? undefined : table.get(beforeTicketId)
    const after = afterTicketId === null ? undefined : table.get(afterTicketId)
    if (before !== undefined && before.column !== column) {
      throw new TaskboardError('anchor ticket "' + before.id + '" is not in column "' + column + '"', 'TASKBOARD_INVALID_INPUT')
    }
    if (after !== undefined && after.column !== column) {
      throw new TaskboardError('anchor ticket "' + after.id + '" is not in column "' + column + '"', 'TASKBOARD_INVALID_INPUT')
    }
    if (before !== undefined) {
      const index = rows.findIndex(ticket => ticket.id === before.id)
      const previous = index > 0 ? rows[index - 1] : undefined
      const previousPosition = previous === undefined ? before.position - 2 : previous.position
      return (previousPosition + before.position) / 2
    }
    if (after !== undefined) {
      const index = rows.findIndex(ticket => ticket.id === after.id)
      const next = index >= 0 && index + 1 < rows.length ? rows[index + 1] : undefined
      const nextPosition = next === undefined ? after.position + 2 : next.position
      return (after.position + nextPosition) / 2
    }
    const last = rows[rows.length - 1]
    return last === undefined ? 0 : last.position + 1
  }

  /** Validate the dependency edge set of one request against the live board. */
  private validateDependencies(
    table: KvTable<string, TicketView>,
    selfId: string,
    dependsOn: string[],
  ): void {
    const seen = new Set(dependsOn)
    if (seen.size !== dependsOn.length) {
      throw new TaskboardError('dependsOn lists a ticket more than once', 'TASKBOARD_INVALID_INPUT')
    }
    if (seen.has(selfId)) {
      throw new TaskboardError('a ticket cannot depend on itself', 'TASKBOARD_DEPENDENCY_CYCLE')
    }
    for (const dependencyId of dependsOn) {
      if (table.get(dependencyId) === undefined) {
        throw new TaskboardError('unknown dependency ticket "' + dependencyId + '"', 'TASKBOARD_DEPENDENCY_UNKNOWN')
      }
    }
    // Walk the transitive edge set from each dependency; reaching self = cycle.
    const queue = [...dependsOn]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const current = queue.pop() as string
      if (current === selfId) {
        throw new TaskboardError('dependsOn would create a dependency cycle', 'TASKBOARD_DEPENDENCY_CYCLE')
      }
      if (visited.has(current)) continue
      visited.add(current)
      const ticket = table.get(current)
      if (ticket === undefined) continue
      for (const transitive of ticket.dependsOn) queue.push(transitive)
    }
  }

  /** Spawn the reviewer child for one ticket through the subagent seam. */
  private async spawnReviewer(parent: Agent, ticket: TicketView): Promise<ReviewSpawnResult> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      return { spawned: false, reason: 'unavailable' }
    }
    try {
      const prompt: ContentBlock[] = [{ type: 'text', text: buildReviewPrompt(ticket) }]
      const request: SubagentStartRequest = {
        label: 'review ' + ticket.id,
        prompt,
        parent,
        signal: new AbortController().signal,
      }
      const run: SubagentRun = await subagents.start(this.resolved.reviewProvider, request)
      return { spawned: true, reviewer: { agentId: run.id, label: reviewerLabel(run.id) } }
    } catch {
      return { spawned: false, reason: 'failed' }
    }
  }

  /** Attach the designated reviewer to an In testing ticket. */
  private attachReviewer(
    ticketId: string,
    reviewer: TicketAssignee,
    detail: string,
  ): Promise<TicketView> {
    const now = Date.now()
    return this.mutate(ticketId, 'review-claim', current => appendHistory(
      { ...current, reviewer, updatedAt: now },
      'review-claim',
      detail,
      now,
    ))
  }

  /** One user move with reviewer automation when the target is In testing. */
  private async moveWithReviewer(agent: Agent, request: MoveTicketRequest): Promise<TicketView> {
    if (!isColumn(request.column)) {
      throw new TaskboardError('unknown column "' + String(request.column) + '"', 'TASKBOARD_INVALID_COLUMN')
    }
    const table = await this.tickets()
    const position = this.positionBetween(table, request.column, request.beforeTicketId, request.afterTicketId)
    const ticket = await this.mutate(request.ticketId, 'move', current => appendHistory(
      {
        ...current,
        column: request.column,
        position,
        reviewer: request.column === 'in_testing' ? current.reviewer : null,
        updatedAt: Date.now(),
      },
      'move',
      'moved to ' + request.column,
    ))
    if (request.column === 'in_testing' && ticket.reviewer === null) {
      const spawn = await this.spawnReviewer(agent, ticket)
      if (spawn.spawned) {
        return this.attachReviewer(ticket.id, spawn.reviewer, 'reviewer ' + spawn.reviewer.label + ' started')
      }
    }
    return ticket
  }

  /**
   * Whole-board snapshot, sorted by column then position.
   * @returns the live board snapshot.
   */
  @Remote('snapshot')
  async snapshot(): Promise<BoardSnapshot> {
    const table = await this.openedTable()
    const rows: TicketView[] = []
    for (const [, ticket] of table.entries()) rows.push(ticket)
    const tickets = rows.sort((a, b) => {
      const columnOrder = TASKBOARD_COLUMNS.indexOf(a.column) - TASKBOARD_COLUMNS.indexOf(b.column)
      return columnOrder !== 0 ? columnOrder : a.position - b.position
    })
    return { tickets }
  }

  private openTable: KvTable<string, TicketView> | null = null

  /**
   * Create one ticket in Backlog through the Remote boundary.
   * @param request - title, description, priority, and ordering dependencies.
   * @returns the created ticket.
   */
  @Remote('create')
  createRemote(request: CreateTicketRequest): Promise<TicketView> {
    const title = resolveTitle(request.title)
    const priority = TASKBOARD_PRIORITIES.includes(request.priority) ? request.priority : 'normal'
    const now = Date.now()
    const record = {
      id: 'ticket-' + randomUUID(),
      title,
      description: typeof request.description === 'string' ? request.description : '',
      column: 'backlog' as ColumnId,
      priority,
      createdAt: now,
      updatedAt: now,
      assignee: null,
      reviewer: null,
      reviewAttempts: 0,
      lastReview: null,
      devNotes: '',
      dependsOn: request.dependsOn,
      history: [] as TicketView['history'],
    }
    return this.createRecord(record, now)
  }

  /** Persist a fresh backlog record after dependency validation. */
  private async createRecord(record: Omit<TicketView, 'position'>, now: number): Promise<TicketView> {
    const table = await this.tickets()
    this.validateDependencies(table, record.id, record.dependsOn)
    const open = await this.openedTable()
    let max = 0
    for (const [, ticket] of open.entries()) {
      if (ticket.column === record.column && ticket.position >= max) max = ticket.position + 1
    }
    const stored = appendHistory({ ...record, position: max }, 'create', 'created in backlog', now)
    await table.put(stored.id, stored)
    const change: TaskboardChanged = { operation: 'create', ticketId: stored.id, ticket: stored }
    this.ctx.emit('taskboard/changed', change)
    return stored
  }

  /**
   * Move one ticket through the Remote boundary; entering In testing also
   * assigns a fresh reviewer through the subagent seam.
   * @param agent - the session agent driving the move (reviewer parent).
   * @param request - target column and optional position anchors.
   * @returns the moved ticket.
   */
  @Remote('move')
  moveRemote(agent: Agent, request: MoveTicketRequest): Promise<TicketView> {
    return this.moveWithReviewer(agent, request)
  }

  /**
   * Edit one ticket through the Remote boundary.
   * @param request - replacement content and dependency edges.
   * @returns the edited ticket.
   */
  @Remote('edit')
  async editRemote(request: EditTicketRequest): Promise<TicketView> {
    const title = resolveTitle(request.title)
    const priority = TASKBOARD_PRIORITIES.includes(request.priority) ? request.priority : 'normal'
    const table = await this.openedTable()
    this.validateDependencies(table, request.ticketId, request.dependsOn)
    return this.mutate(request.ticketId, 'edit', current => appendHistory(
      {
        ...current,
        title,
        description: typeof request.description === 'string' ? request.description : current.description,
        priority,
        dependsOn: request.dependsOn,
        updatedAt: Date.now(),
      },
      'edit',
      'content edited',
    ))
  }

  /**
   * Remove one ticket through the Remote boundary.
   * @param request - the ticket to remove.
   * @returns the removal receipt.
   */
  @Remote('delete')
  async removeRemote(request: RemoveTicketRequest): Promise<RemoveTicketResult> {
    const table = await this.tickets()
    const removed = await table.delete(request.ticketId)
    if (!removed) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    const change: TaskboardChanged = { operation: 'remove', ticketId: request.ticketId, ticket: null }
    this.ctx.emit('taskboard/changed', change)
    return { removedId: request.ticketId }
  }

  /**
   * (Re)assign a reviewer for one In testing ticket through the Remote
   * boundary.
   * @param agent - the session agent spawning the reviewer child.
   * @param request - the In testing ticket to review.
   * @returns the ticket with its fresh reviewer attached.
   */
  @Remote('requestReview')
  async requestReviewRemote(agent: Agent, request: RequestReviewRequest): Promise<TicketView> {
    const table = await this.tickets()
    const current = table.get(request.ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    if (current.column !== 'in_testing') {
      throw new TaskboardError('ticket "' + current.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
    }
    const spawn = await this.spawnReviewer(agent, current)
    if (!spawn.spawned) {
      throw new TaskboardError('no reviewer backend is available to assign', 'TASKBOARD_INVALID_TRANSITION')
    }
    return this.attachReviewer(current.id, spawn.reviewer, 'reviewer ' + spawn.reviewer.label + ' started')
  }

  /**
   * Agent claims a Not started ticket and becomes its owner.
   * @param agent - the claiming agent.
   * @param ticketId - the Not started ticket to claim.
   * @returns the claimed ticket, now In progress.
   */
  async claim(agent: Agent, ticketId: string): Promise<TicketView> {
    const table = await this.tickets()
    const label = agentLabel(agent)
    return this.mutate(ticketId, 'claim', (current) => {
      if (current.assignee !== null) {
        throw new TaskboardError('ticket "' + current.id + '" is already claimed', 'TASKBOARD_ALREADY_CLAIMED')
      }
      if (current.column !== 'not_started') {
        throw new TaskboardError(
          'ticket "' + current.id + '" is in "' + current.column + '" (claim requires Not started)',
          'TASKBOARD_INVALID_TRANSITION',
        )
      }
      for (const dependencyId of current.dependsOn) {
        const dependency = table.get(dependencyId)
        if (dependency === undefined) {
          throw new TaskboardError('unknown dependency ticket "' + dependencyId + '"', 'TASKBOARD_DEPENDENCY_UNKNOWN')
        }
        if (dependency.column !== 'done') {
          throw new TaskboardError(
            'ticket "' + current.id + '" is blocked: dependency "' + dependencyId + '" is not Done',
            'TASKBOARD_DEPENDENCY_BLOCKED',
          )
        }
      }
      let inProgress = 0
      for (const [, ticket] of table.entries()) {
        if (ticket.column === 'in_progress') inProgress++
      }
      if (inProgress >= this.resolved.maxInProgress) {
        throw new TaskboardError(
          'in-progress capacity ' + this.resolved.maxInProgress + ' reached; retry when a slot frees up',
          'TASKBOARD_CAPACITY_EXCEEDED',
        )
      }
      return appendHistory(
        {
          ...current,
          column: 'in_progress',
          assignee: { agentId: agent.id, label },
          reviewer: null,
          updatedAt: Date.now(),
        },
        'claim',
        'claimed by ' + label,
      )
    })
  }

  /**
   * Agent takes the empty review seat of one In testing ticket.
   * @param agent - the reviewing agent.
   * @param ticketId - the In testing ticket with no reviewer.
   * @returns the ticket with the reviewer attached.
   */
  async claimReview(agent: Agent, ticketId: string): Promise<TicketView> {
    const label = agentLabel(agent)
    const reviewer: TicketAssignee = { agentId: agent.id, label }
    return this.mutate(ticketId, 'review-claim', (current) => {
      if (current.column !== 'in_testing') {
        throw new TaskboardError('ticket "' + current.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
      }
      if (current.reviewer !== null) {
        throw new TaskboardError('ticket "' + current.id + '" already has a reviewer', 'TASKBOARD_REVIEWER_PRESENT')
      }
      return appendHistory({ ...current, reviewer, updatedAt: Date.now() }, 'review-claim', 'review claimed by ' + label)
    })
  }

  /**
   * Owner marks development done; the ticket enters In testing and gets a
   * reviewer.
   * @param agent - the owning developer agent.
   * @param ticketId - the owned In progress ticket.
   * @param devNotes - what changed and how it was verified.
   * @returns the In testing ticket plus the reviewer-spawn outcome.
   */
  async complete(agent: Agent, ticketId: string, devNotes: string): Promise<CompleteTicketResult> {
    const notes = typeof devNotes === 'string' ? devNotes.trim() : ''
    const ticket = await this.mutate(ticketId, 'complete', (current) => {
      if (current.column !== 'in_progress') {
        throw new TaskboardError(
          'ticket "' + current.id + '" is in "' + current.column + '" (complete requires In progress)',
          'TASKBOARD_INVALID_TRANSITION',
        )
      }
      if (current.assignee === null || current.assignee.agentId !== agent.id) {
        throw new TaskboardError('only the assignee may complete the ticket', 'TASKBOARD_NOT_OWNER')
      }
      return appendHistory(
        { ...current, column: 'in_testing', devNotes: notes, updatedAt: Date.now() },
        'complete',
        'development done, waiting for review',
      )
    })
    const spawn = await this.spawnReviewer(agent, ticket)
    if (!spawn.spawned) {
      return { ticket, review: spawn.reason, reviewerAgentId: null }
    }
    const withReviewer = await this.attachReviewer(ticket.id, spawn.reviewer, 'reviewer ' + spawn.reviewer.label + ' started')
    return { ticket: withReviewer, review: 'spawned', reviewerAgentId: spawn.reviewer.agentId }
  }

  /**
   * The designated reviewer approves; the ticket lands in Done.
   * @param agent - the designated reviewer agent.
   * @param ticketId - the In testing ticket under review.
   * @param summary - what was inspected and why it passes.
   * @returns the approved Done ticket.
   */
  async approve(agent: Agent, ticketId: string, summary: string): Promise<TicketView> {
    return this.mutate(ticketId, 'approve', (current) => {
      if (current.column !== 'in_testing') {
        throw new TaskboardError('ticket "' + current.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
      }
      if (current.reviewer === null || current.reviewer.agentId !== agent.id) {
        throw new TaskboardError('only the designated reviewer may approve', 'TASKBOARD_NOT_REVIEWER')
      }
      return appendHistory(
        {
          ...current,
          column: 'done',
          reviewAttempts: current.reviewAttempts + 1,
          lastReview: {
            outcome: 'approved',
            feedback: typeof summary === 'string' ? summary.trim() : '',
            reviewer: current.reviewer,
            attempt: current.reviewAttempts + 1,
            at: Date.now(),
          },
          updatedAt: Date.now(),
        },
        'approve',
        'review approved',
      )
    })
  }

  /**
   * The designated reviewer rejects; the ticket is returned for rework.
   * @param agent - the designated reviewer agent.
   * @param ticketId - the In testing ticket under review.
   * @param feedback - concrete, actionable rework feedback.
   * @returns the rejected ticket, back In progress.
   */
  async reject(agent: Agent, ticketId: string, feedback: string): Promise<TicketView> {
    const reason = typeof feedback === 'string' ? feedback.trim() : ''
    if (reason.length === 0) {
      throw new TaskboardError('reject feedback must be a non-empty string', 'TASKBOARD_INVALID_INPUT')
    }
    return this.mutate(ticketId, 'reject', (current) => {
      if (current.column !== 'in_testing') {
        throw new TaskboardError('ticket "' + current.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
      }
      if (current.reviewer === null || current.reviewer.agentId !== agent.id) {
        throw new TaskboardError('only the designated reviewer may reject', 'TASKBOARD_NOT_REVIEWER')
      }
      return appendHistory(
        {
          ...current,
          column: 'in_progress',
          reviewAttempts: current.reviewAttempts + 1,
          lastReview: {
            outcome: 'rejected',
            feedback: reason,
            reviewer: current.reviewer,
            attempt: current.reviewAttempts + 1,
            at: Date.now(),
          },
          reviewer: null,
          updatedAt: Date.now(),
        },
        'reject',
        'review rejected, returned for rework',
      )
    })
  }

  /**
   * Edit own-ticket content through the model-facing surface.
   * @param agent - the owning developer agent.
   * @param ticketId - the owned ticket.
   * @param title - replacement title, or undefined to keep it.
   * @param description - replacement description, or undefined to keep it.
   * @param devNotes - replacement notes, or undefined to keep them.
   * @returns the updated ticket.
   */
  async updateOwn(
    agent: Agent,
    ticketId: string,
    title: string | undefined,
    description: string | undefined,
    devNotes: string | undefined,
  ): Promise<TicketView> {
    return this.mutate(ticketId, 'edit', (current) => {
      if (current.assignee === null || current.assignee.agentId !== agent.id) {
        throw new TaskboardError('only the assignee may update the ticket', 'TASKBOARD_NOT_OWNER')
      }
      return appendHistory(
        {
          ...current,
          title: typeof title === 'string' && title.trim() !== '' ? title.trim() : current.title,
          description: typeof description === 'string' ? description : current.description,
          devNotes: typeof devNotes === 'string' ? devNotes : current.devNotes,
          updatedAt: Date.now(),
        },
        'edit',
        'updated by assignee',
      )
    })
  }

  /**
   * Whole-board rows for the model, optionally filtered.
   * @param column - column filter, or null for every column.
   * @param mine - when true, only rows assigned to agentId.
   * @param agentId - the calling agent's id.
   * @returns the matching rows in position order.
   */
  async listRows(column: ColumnId | null, mine: boolean, agentId: string): Promise<TicketRow[]> {
    const table = await this.tickets()
    const rows: TicketRow[] = []
    for (const [, ticket] of table.entries()) {
      if (column !== null && ticket.column !== column) continue
      if (mine && ticket.assignee?.agentId !== agentId) continue
      rows.push({
        id: ticket.id,
        title: ticket.title,
        column: ticket.column,
        priority: ticket.priority,
        position: ticket.position,
        assignee: ticket.assignee,
        reviewer: ticket.reviewer,
        reviewAttempts: ticket.reviewAttempts,
        lastReviewOutcome: ticket.lastReview?.outcome ?? null,
        dependsOn: ticket.dependsOn,
      })
    }
    return rows.sort((a, b) => a.position - b.position)
  }

  /**
   * One full ticket for the model.
   * @param ticketId - the ticket to read.
   * @returns the full ticket view.
   */
  async viewTicket(ticketId: string): Promise<TicketView> {
    const table = await this.tickets()
    const ticket = table.get(ticketId)
    if (ticket === undefined) {
      throw new TaskboardError('ticket "' + ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    return ticket
  }

  /** Capture the opened table handle once the domain resolves. */
  private async openedTable(): Promise<KvTable<string, TicketView>> {
    if (this.openTable !== null) return this.openTable
    const domain = await this.domain
    this.openTable = domain.table('tickets')
    return this.openTable
  }

  /** The caller agent of one tool execution, loud when absent. */
  private static agentOf(exec: { agent?: Agent }): Agent {
    if (exec.agent === undefined) {
      throw new TaskboardError('taskboard tools require an owning agent session', 'TASKBOARD_AGENT_REQUIRED')
    }
    return exec.agent
  }

  /** Shared schemastery row schema for the model-facing card view. */
  private static ticketRowSchema() {
    return {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        id: { type: 'string' as const, required: true as const },
        title: { type: 'string' as const, required: true as const },
        column: { type: 'string' as const, required: true as const, enum: [...TASKBOARD_COLUMNS] },
        priority: { type: 'string' as const, required: true as const, enum: [...TASKBOARD_PRIORITIES] },
        position: { type: 'number' as const, required: true as const },
        assignee: {
          oneOf: [
            { type: 'object' as const, additionalProperties: false, properties: {
              agentId: { type: 'string' as const, required: true as const },
              label: { type: 'string' as const, required: true as const },
            } },
            { type: 'null' as const },
          ] as const, required: true as const,
        },
        reviewer: {
          oneOf: [
            { type: 'object' as const, additionalProperties: false, properties: {
              agentId: { type: 'string' as const, required: true as const },
              label: { type: 'string' as const, required: true as const },
            } },
            { type: 'null' as const },
          ] as const, required: true as const,
        },
        reviewAttempts: { type: 'number' as const, required: true as const },
        lastReviewOutcome: {
          oneOf: [
            { type: 'string' as const, enum: ['approved'] },
            { type: 'string' as const, enum: ['rejected'] },
            { type: 'null' as const },
          ] as const, required: true as const,
        },
        dependsOn: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
      },
    }
  }

  /** Register every model-facing taskboard tool on the global tool registry. */
  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'taskboard_list',
      description: 'List taskboard tickets. Tickets come back sorted by implementation order (position) inside each column; dependsOn names tickets that must be Done before this one may be claimed. Prefer this over taskboard_view when scanning for the next card to pick up.',
      parameters: {
        column: {
          type: 'string' as const,
          enum: [...TASKBOARD_COLUMNS],
          description: 'Only tickets in this column. Omit for the whole board.',
        },
        mine: {
          type: 'boolean' as const,
          description: 'When true, only tickets assigned to the calling agent.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            tickets: { type: 'array', required: true, items: TaskboardService.ticketRowSchema() },
          },
        },
        render: (_args, value: { tickets: TicketRow[] }) => [{
          type: 'text' as const,
          text: String(value.tickets.length) + ' ticket(s)',
        }],
      },
      execute: async (args: { column?: string; mine?: boolean }, exec) => {
        const agent = TaskboardService.agentOf(exec)
        const column = args.column === undefined ? null : args.column as ColumnId
        if (column !== null && !isColumn(column)) {
          throw new TaskboardError('unknown column "' + String(column) + '"', 'TASKBOARD_INVALID_COLUMN')
        }
        const tickets = await this.listRows(column, args.mine === true, agent.id)
        return { tickets }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'List taskboard tickets', kind: 'other' as const, rawInput: args.column ?? null }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_view',
      description: 'Read one full taskboard ticket: description, assignee, review state, rejection feedback, devNotes and history. Use this when you need the ticket details before claiming or reworking it.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket id.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            description: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            priority: { type: 'string', required: true, enum: [...TASKBOARD_PRIORITIES] },
            createdAt: { type: 'number', required: true },
            updatedAt: { type: 'number', required: true },
            position: { type: 'number', required: true },
            assignee: TaskboardService.ticketRowSchema().properties.assignee,
            reviewer: TaskboardService.ticketRowSchema().properties.reviewer,
            reviewAttempts: { type: 'number', required: true },
            lastReview: {
              oneOf: [
                {
                  type: 'object', additionalProperties: false,
                  properties: {
                    outcome: { type: 'string', required: true, enum: ['approved', 'rejected'] },
                    feedback: { type: 'string', required: true },
                    reviewer: { type: 'object', additionalProperties: false, properties: {
                      agentId: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                    } },
                    attempt: { type: 'number', required: true },
                    at: { type: 'number', required: true },
                  },
                },
                { type: 'null' },
              ] as const, required: true,
            },
            devNotes: { type: 'string', required: true },
            dependsOn: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value: TicketView) => [{ type: 'text' as const, text: 'ticket ' + value.id + ': ' + value.title }],
      },
      execute: async (args: { ticketId: string }) => this.viewTicket(args.ticketId),
      presentCall: args => ({ card: 'generic' as const, title: 'View taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_claim',
      description: 'Claim a Not started taskboard ticket for the calling agent: the card moves to In progress and this agent becomes its owner. Rejected when the ticket is claimed by someone else, when a dependsOn ticket is not Done yet, or when the in-progress capacity is full. Claim the oldest (lowest position) ready ticket first; use parallel subagents to claim several independent tickets at once.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The Not started ticket to claim.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            assignee: TaskboardService.ticketRowSchema().properties.assignee,
            reviewAttempts: { type: 'number', required: true },
          },
        },
        render: (_args, value: { id: string }) => [{ type: 'text' as const, text: 'claimed ' + value.id }],
      },
      execute: async (args: { ticketId: string }, exec) => {
        const value = await this.claim(TaskboardService.agentOf(exec), args.ticketId)
        return { id: value.id, title: value.title, column: value.column, assignee: value.assignee, reviewAttempts: value.reviewAttempts }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Claim taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_complete',
      description: 'Mark an owned In progress ticket as development-complete: the card moves to In testing and the board automatically assigns a fresh reviewer agent. Summarize what changed and how it was verified in devNotes — the reviewer reads exactly that. The reviewer decides approve/reject; you never review your own ticket.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket this agent owns.' },
        devNotes: {
          type: 'string' as const, required: true,
          description: 'What was implemented, files/areas touched, and how it was verified (tests run, manual checks). The reviewer reads this.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            review: { type: 'string', required: true, enum: ['spawned', 'unavailable', 'failed'] },
            reviewerAgentId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
          },
        },
        render: (_args, value: { ticketId: string; column: ColumnId; review: 'spawned' | 'unavailable' | 'failed'; reviewerAgentId: string | null }) => [{
          type: 'text' as const,
          text: value.review === 'spawned'
            ? 'ticket ' + value.ticketId + ' is In testing; reviewer ' + String(value.reviewerAgentId) + ' assigned'
            : 'ticket ' + value.ticketId + ' is In testing but reviewer spawn ' + value.review + '; use taskboard_claim_review or tell the user',
        }],
      },
      execute: async (args: { ticketId: string; devNotes: string }, exec) => {
        const result = await this.complete(TaskboardService.agentOf(exec), args.ticketId, args.devNotes)
        return { ticketId: result.ticket.id, column: result.ticket.column, review: result.review, reviewerAgentId: result.reviewerAgentId }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Complete taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_claim_review',
      description: 'Take the empty review seat of an In testing taskboard ticket (used when the automatic reviewer could not be spawned). After claiming, you are its reviewer: inspect the work, then call taskboard_approve or taskboard_reject.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The In testing ticket with no reviewer.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            reviewer: TaskboardService.ticketRowSchema().properties.reviewer,
          },
        },
        render: (_args, value: { id: string }) => [{ type: 'text' as const, text: 'review seat claimed for ' + value.id }],
      },
      execute: async (args: { ticketId: string }, exec) => {
        const value = await this.claimReview(TaskboardService.agentOf(exec), args.ticketId)
        return { id: value.id, column: value.column, reviewer: value.reviewer }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Claim taskboard review', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_approve',
      description: 'Approve an In testing taskboard ticket you are the designated reviewer of: the card moves to Done. Summary states what was verified. Use only after actually inspecting the work; otherwise use taskboard_reject.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The In testing ticket you review.' },
        summary: { type: 'string' as const, required: true, description: 'What you inspected and why it passes.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            reviewAttempts: { type: 'number', required: true },
          },
        },
        render: (_args, value: { id: string }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' approved and Done' }],
      },
      execute: async (args: { ticketId: string; summary: string }, exec) => {
        const value = await this.approve(TaskboardService.agentOf(exec), args.ticketId, args.summary)
        return { id: value.id, column: value.column, reviewAttempts: value.reviewAttempts }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Approve taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_reject',
      description: 'Reject an In testing taskboard ticket you are the designated reviewer of: the card returns to In progress (打回) with your feedback for the developer to rework. Feedback must list concrete, actionable problems. Do not fix the code yourself.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The In testing ticket you review.' },
        feedback: { type: 'string' as const, required: true, description: 'Concrete, actionable rework feedback.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            reviewAttempts: { type: 'number', required: true },
          },
        },
        render: (_args, value: { id: string }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' rejected and returned for rework' }],
      },
      execute: async (args: { ticketId: string; feedback: string }, exec) => {
        const value = await this.reject(TaskboardService.agentOf(exec), args.ticketId, args.feedback)
        return { id: value.id, column: value.column, reviewAttempts: value.reviewAttempts }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Reject taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_update',
      description: 'Update a taskboard ticket this agent owns: title, description, and/or devNotes. Omitted fields stay unchanged.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket this agent owns.' },
        title: { type: 'string' as const, description: 'Replacement title.' },
        description: { type: 'string' as const, description: 'Replacement description.' },
        devNotes: { type: 'string' as const, description: 'Replacement completion notes.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
          },
        },
        render: (_args, value: { id: string }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' updated' }],
      },
      execute: async (args: { ticketId: string; title?: string; description?: string; devNotes?: string }, exec) => {
        const value = await this.updateOwn(TaskboardService.agentOf(exec), args.ticketId, args.title, args.description, args.devNotes)
        return { id: value.id, title: value.title, column: value.column }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Update taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))
  }
}

export default TaskboardService
