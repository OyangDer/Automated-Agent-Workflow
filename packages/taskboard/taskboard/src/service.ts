/**
 * The taskboard domain service: durable five-column ticket storage across
 * multiple boards, the master seat, the agent-facing workflow tools
 * (list/claim/assign/report/fail/reassign/complete/approve/reject), the
 * browser Remote API, automatic worker/reviewer spawning with a fixed worker
 * model, and failure reclamation when a worker session ends without
 * reporting. Tickets persist through the storage-domain seam; every
 * committed mutation emits the forwarded taskboard/changed event.
 * @module @deepseek-ai/dsh-taskboard
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineDomain, DomainError, domainTable,
  type Domain, type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: resolves ctx.get('subagents') through the subagent seam augmentation.
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  TASKBOARD_COLUMNS, TASKBOARD_PRIORITIES, TASKBOARD_TYPES, TASKBOARD_WORKER_STATUSES,
} from './types.ts'
import type {
  ArchiveBoardRequest, BoardSnapshot, BoardView, ColumnId, CreateBoardRequest,
  CreateTicketRequest, EditTicketRequest, MasterHistoryEntry, MoveTicketRequest, Priority,
  RemoveTicketRequest, RemoveTicketResult, RequestReviewRequest, TaskboardChanged,
  TaskboardOperation, TicketAssignee, TicketFailure, TicketType, TicketView, TicketWorkerStatus,
} from './types.ts'
import {
  agentLabel, appendHistory, buildReviewPrompt, buildReviewReportPrompt, buildWorkerPrompt,
  MASTER_SECTION, reviewerLabel, TaskboardError, WORKFLOW_SECTION,
} from './domain.ts'

/** The single stored ticket shape; validated at the durable boundary. */
const ticketSchema = zod.object({
  id: zod.string().min(1),
  title: zod.string().min(1),
  description: zod.string(),
  column: zod.enum(TASKBOARD_COLUMNS),
  priority: zod.enum(TASKBOARD_PRIORITIES),
  boardId: zod.string().default('default'),
  type: zod.enum(TASKBOARD_TYPES).default('feature'),
  status: zod.enum(TASKBOARD_WORKER_STATUSES).default('claimed'),
  workerAgentId: zod.string().optional(),
  workerSessionId: zod.string().optional(),
  failure: zod.object({ reason: zod.string(), at: zod.number() }).nullable().default(null),
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
  reviewOutcome: zod.union([
    zod.object({
      verdict: zod.enum(['approve', 'reject']),
      summary: zod.string(),
      problems: zod.array(zod.string()),
      at: zod.number(),
    }),
    zod.null(),
  ]).default(null),
  devNotes: zod.string(),
  targetBranch: zod.string().default(''),
  dependsOn: zod.array(zod.string()),
  history: zod.array(zod.object({ at: zod.number(), kind: zod.string(), detail: zod.string() })),
})

/** The stored board record shape; validated at the durable boundary. */
const boardSchema = zod.object({
  boardId: zod.string().min(1),
  name: zod.string(),
  workspaceId: zod.string(),
  scope: zod.enum(['session', 'project'] as const).default('session'),
  ownerSessionId: zod.string().nullable().default(null),
  masterAgentId: zod.string().nullable().default(null),
  masterClaimedAt: zod.number().nullable().default(null),
  handoverNotes: zod.string().default(''),
  masterHistory: zod.array(zod.object({
    fromAgentId: zod.string().nullable(),
    toAgentId: zod.string(),
    at: zod.number(),
    notes: zod.string(),
  })).default([]),
  archivedAt: zod.number().nullable().default(null),
})

/**
 * The structured report a report-mode reviewer must return through the
 * structured-output tool: { verdict, summary, problems }. Within
 * assertObjectJsonSchema's enforced subset (object root, required as an array
 * of property names, no per-property required flag).
 */
const REVIEW_OUTCOME_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    summary: { type: 'string' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'problems'],
}

/** True when a settled run's structured value matches the review-report shape. */
function isReviewOutcome(value: unknown): value is { verdict: 'approve' | 'reject'; summary: string; problems: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.verdict !== 'approve' && record.verdict !== 'reject') return false
  if (typeof record.summary !== 'string') return false
  return Array.isArray(record.problems) && record.problems.every(problem => typeof problem === 'string')
}

/** The taskboard storage domain declaration: tickets plus boards tables. */
const TASKBOARD_DOMAIN = defineDomain({
  name: 'taskboard',
  version: 1,
  tables: {
    tickets: domainTable<string, TicketView>(ticketSchema),
    boards: domainTable<string, BoardView>(boardSchema),
  },
})

/** Deployment knobs for the taskboard workflow. */
export interface Config {
  /** How many tickets may be In progress at once (parallel developer cap for the v1 claim path). */
  maxInProgress?: number
  /** Subagent provider name used to spawn reviewer agents. */
  reviewProvider?: string
  /** Model id for the master session (informational knob; the session's own model is authoritative). */
  masterModel?: string
  /** Model id used for every spawned worker and reviewer child. */
  workerModel?: string
  /** Subagent provider name used to spawn worker agents. */
  workerProvider?: string
  /** Master seat lease in milliseconds; a stale seat can be preempted. */
  masterSeatTimeoutMs?: number
  /** Review protocol: "report" has the reviewer return a structured verdict (master resolves); "direct" keeps the v1 reviewer tools. */
  reviewMode?: 'report' | 'direct'
}

/** Schemastery configuration for the taskboard consumer. */
export const Config: z<Config> = z.object({
  maxInProgress: z.number().default(4),
  reviewProvider: z.string().default('spawn'),
  masterModel: z.string().default('deepseek-v4-pro-max'),
  workerModel: z.string().default('deepseek-v4-flash'),
  workerProvider: z.string().default('spawn'),
  masterSeatTimeoutMs: z.number().default(900000),
  reviewMode: z.union(['report', 'direct'] as const).default('report'),
})

/** One worker-spawn outcome. */
export type WorkerSpawnResult =
  | { ok: true; sessionId: string; run: SubagentRun }
  | { ok: false; reason: 'unavailable' | 'failed' }

/** One reviewer-spawn outcome. */
export type ReviewSpawnResult =
  | { spawned: true; reviewer: TicketAssignee; run: SubagentRun }
  | { spawned: false; reason: 'unavailable' | 'failed' }

/** Tool payload: the card plus what happened to the review seat. */
export interface CompleteTicketResult {
  ticket: TicketView
  review: 'spawned' | 'unavailable' | 'failed'
  reviewerAgentId: string | null
}

/** Tool payload: the card plus what happened to the worker spawn. */
export interface AssignTicketResult {
  ticket: TicketView
  worker: 'spawned' | 'unavailable' | 'failed'
  workerAgentId: string | null
}

/** Tool payload: the card plus what happened to a re-dispatch worker spawn. */
export interface ReassignTicketResult {
  ticket: TicketView
  worker: 'spawned' | 'unavailable' | 'failed' | null
  workerAgentId: string | null
}

/** Tool payload: the card plus the followup/archive outcomes of a resolved review. */
export interface ResolveReviewResult {
  ticket: TicketView
  action: 'approved' | 'rejected'
  /** reject: whether the original worker session received the rework feedback. */
  followup: 'sent' | 'unavailable' | 'none'
  /** approve: whether the worker session was archived by the host. */
  archived: boolean
  /** reject: true when the third consecutive reject marked the card blocked. */
  blockedAfterReject: boolean
}

/** The compact row taskboard_list returns per ticket. */
export interface TicketRow {
  id: string
  title: string
  column: ColumnId
  priority: Priority
  boardId: string
  type: TicketType
  status: TicketWorkerStatus
  workerAgentId: string | null
  failure: TicketFailure | null
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

/** Validate one explicit master-seat lease. */
function resolveMasterSeatTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('taskboard: masterSeatTimeoutMs must be a non-negative safe integer')
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

/** Normalize a user-supplied board name at the domain boundary. */
function resolveBoardName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length === 0) {
    throw new TaskboardError('board name must be a non-empty string', 'TASKBOARD_INVALID_INPUT')
  }
  return name
}

/** Normalize a required free-text input at the domain boundary. */
function resolveRequiredText(value: string, subject: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    throw new TaskboardError(subject + ' must be a non-empty string', 'TASKBOARD_INVALID_INPUT')
  }
  return text
}

/**
 * The taskboard service (ctx.taskboard): storage-backed tickets and boards,
 * the master seat, workflow transitions, the browser Remote surface, and the
 * model-facing tools.
 */
export class TaskboardService extends TypertRemoteService {
  static inject = ['storageDomain', 'systemPrompt', 'tools']

  static Config = Config

  private readonly resolved: {
    maxInProgress: number
    reviewProvider: string
    masterModel: string
    workerModel: string
    workerProvider: string
    masterSeatTimeoutMs: number
    reviewMode: 'report' | 'direct'
  }
  private readonly domain: Promise<Domain<typeof TASKBOARD_DOMAIN>>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'taskboard')
    this.resolved = {
      maxInProgress: resolveMaxInProgress(config.maxInProgress ?? 4),
      reviewProvider: config.reviewProvider ?? 'spawn',
      masterModel: config.masterModel ?? 'deepseek-v4-pro-max',
      workerModel: config.workerModel ?? 'deepseek-v4-flash',
      workerProvider: config.workerProvider ?? 'spawn',
      masterSeatTimeoutMs: resolveMasterSeatTimeout(config.masterSeatTimeoutMs ?? 900000),
      reviewMode: config.reviewMode === 'direct' ? 'direct' : 'report',
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
    ctx.systemPrompt.section({ name: 'taskboard:master', order: 149, text: MASTER_SECTION })
    ctx.systemPrompt.section({ name: 'taskboard:workflow', order: 150, text: WORKFLOW_SECTION })
    this.registerTools()
  }

  /** Resolve the opened tickets table. */
  private async tickets(): Promise<KvTable<string, TicketView>> {
    return (await this.domain).table('tickets')
  }

  /** Resolve the opened boards table. */
  private async boards(): Promise<KvTable<string, BoardView>> {
    return (await this.domain).table('boards')
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
      const change: TaskboardChanged = { operation, ticketId, boardId: next.boardId, ticket: next }
      this.ctx.emit('taskboard/changed', change)
      return next
    } catch (error) {
      TaskboardService.translate(error, ticketId)
      /* v8 ignore next -- translate always throws */
      throw error
    }
  }

  /** Atomically transform one board record; a missing board fails loudly. */
  private async mutateBoard(boardId: string, fn: (current: BoardView) => BoardView): Promise<BoardView> {
    const table = await this.boards()
    try {
      return await table.update(boardId, fn)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        throw new TaskboardError('board "' + boardId + '" does not exist', 'TASKBOARD_BOARD_NOT_FOUND')
      }
      throw error
    }
  }

  /**
   * Read one board record, lazily materializing the implicit record when the
   * board is absent (the "default" board always exists implicitly). An
   * unseeded materialization lands as a project-shaped unowned board: shared
   * among unowned sessions until the legacy default board is adopted by a
   * real workspace.
   */
  private async ensureBoard(
    boardId: string,
    seed?: { name?: string; workspaceId?: string; scope?: 'session' | 'project' },
  ): Promise<BoardView> {
    const table = await this.boards()
    const existing = table.get(boardId)
    if (existing !== undefined) return existing
    const record: BoardView = {
      boardId,
      name: seed?.name ?? boardId,
      workspaceId: seed?.workspaceId ?? '',
      scope: seed?.scope ?? 'project',
      ownerSessionId: null,
      masterAgentId: null,
      masterClaimedAt: null,
      handoverNotes: '',
      archivedAt: null,
      masterHistory: [],
    }
    await table.put(boardId, record)
    return record
  }

  /**
   * Ensure the caller's session-private default board exists, materializing
   * it idempotently under the deterministic id "session-<sessionId>" on the
   * session's first board-surface access. The board is visible only to its
   * owner session; its name is the workspace directory basename when the
   * session resolves one, "session board" otherwise.
   * @param agent - the calling session agent.
   * @param workspace - the caller's resolved workspace, or undefined when unowned.
   * @returns the session's private default board.
   */
  private async ensureSessionDefaultBoard(
    agent: Agent,
    workspace: { id: string; path: string } | undefined,
  ): Promise<BoardView> {
    const table = await this.boards()
    const boardId = 'session-' + agent.id
    const existing = table.get(boardId)
    if (existing !== undefined) return existing
    const record: BoardView = {
      boardId,
      name: workspace === undefined ? 'session board' : basename(workspace.path),
      workspaceId: workspace === undefined ? '' : workspace.id,
      scope: 'session',
      ownerSessionId: agent.id,
      masterAgentId: null,
      masterClaimedAt: null,
      handoverNotes: '',
      archivedAt: null,
      masterHistory: [],
    }
    await table.put(boardId, record)
    return record
  }

  /** The display name of one board (the boardId itself while implicit). */
  private async boardName(boardId: string): Promise<string> {
    const table = await this.boards()
    return table.get(boardId)?.name ?? boardId
  }

  /**
   * Resolve the calling session's workspace from its header cwd through the
   * host workspace registry (resolveByPath). A missing registry, a missing
   * cwd, an unresolvable path, or any registry failure falls back to unowned
   * (undefined).
   * @param agent - the calling session agent.
   * @returns the resolved workspace id and canonical path, or undefined when unowned.
   */
  private async workspaceOf(agent: Agent): Promise<{ id: string; path: string } | undefined> {
    const cwd = agent.session.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const registry = this.ctx.get('workspaceRegistry') as
      | { resolveByPath?: (path: string) => Promise<{ id: string; path: string } | undefined> }
      | undefined
    if (registry === undefined || typeof registry.resolveByPath !== 'function') return undefined
    try {
      const workspace = await registry.resolveByPath(cwd)
      return workspace === undefined ? undefined : { id: workspace.id, path: workspace.path }
    } catch {
      return undefined
    }
  }

  /**
   * Ensure the caller's default board exists, materializing it per workspace:
   * the first real-workspace access lazily adopts the legacy unowned "default"
   * board (renamed to the workspace directory basename); every later workspace
   * gets a deterministic "default-<workspaceId>" board with the same naming.
   * An unowned caller keeps the legacy implicit "default" board while it stays
   * unowned, and has no default board of its own once a real workspace adopted
   * it (undefined).
   * @param workspaceId - the caller's workspace id, or '' when unowned.
   * @param name - the directory basename to use for a materialized default board.
   * @returns the caller's default board, or undefined when the caller has none.
   */
  private async ensureDefaultBoard(
    workspaceId: string,
    name: string | undefined,
  ): Promise<BoardView | undefined> {
    const table = await this.boards()
    if (workspaceId === '') {
      const legacy = table.get('default')
      if (legacy === undefined) return this.ensureBoard('default')
      return legacy.workspaceId === '' ? legacy : undefined
    }
    const legacy = table.get('default')
    if (legacy === undefined || legacy.workspaceId === '') {
      await this.ensureBoard('default')
      return this.mutateBoard('default', current => ({
        ...current,
        workspaceId,
        scope: 'project',
        ownerSessionId: null,
        ...(name === undefined ? {} : { name }),
      }))
    }
    // The legacy default board already belongs to this workspace.
    if (legacy.workspaceId === workspaceId) return legacy
    return this.ensureBoard('default-' + workspaceId, {
      workspaceId,
      scope: 'project',
      ...(name === undefined ? {} : { name }),
    })
  }

  /**
   * Materialize one board for a master verb, seeding the implicit "default"
   * board with the caller's workspace when the record is absent. An unseeded
   * materialization would land as a project-shaped ''-workspace board that a
   * workspace session cannot see (TASKBOARD_BOARD_NOT_FOUND), breaking the
   * very next master verb after a fresh-store claim. An existing record is
   * returned untouched, so an adopted or v1 legacy default is never
   * re-stamped.
   * @param boardId - the board to ensure.
   * @param agent - the calling session agent; its workspace seeds a materialized 'default'.
   * @returns the ensured board record.
   */
  private async ensureMasterBoard(boardId: string, agent: Agent): Promise<BoardView> {
    if (boardId !== 'default') return this.ensureBoard(boardId)
    const workspace = await this.workspaceOf(agent)
    return this.ensureBoard('default', workspace === undefined
      ? undefined
      : { workspaceId: workspace.id, scope: 'project', name: basename(workspace.path) })
  }

  /**
   * True when one board row is visible to a caller. Session-scoped boards are
   * private to their owner session; a session-scoped row WITHOUT an owner is
   * a v1-shaped legacy record and follows the v1 workspace rule (the unowned
   * legacy default is shared everywhere, workspace-tagged rows share within
   * that workspace). A stray ''-workspace legacy row that is NOT the default
   * board is visible to unowned callers only, so it never leaks into any real
   * workspace. Project-scoped boards are shared within their owning workspace
   * ('' matches unowned callers only, so a new unowned project board never
   * leaks into every workspace).
   * @param board - the board row to check.
   * @param sessionId - the caller's session id.
   * @param workspaceId - the caller's workspace id, or '' when unowned.
   */
  private isBoardVisible(board: BoardView, sessionId: string, workspaceId: string): boolean {
    if (board.scope === 'session') {
      if (board.ownerSessionId === null) {
        // v1-shaped legacy row. The legacy default keeps its v1 "shared
        // everywhere" semantics; any other ''-workspace row is confined to
        // unowned callers (a real workspace never sees it).
        if (board.workspaceId === '' && board.boardId !== 'default') return workspaceId === ''
        return board.workspaceId === '' || board.workspaceId === workspaceId
      }
      return board.ownerSessionId === sessionId
    }
    return board.workspaceId === workspaceId
  }

  /**
   * Require one board to be visible to a caller: a record-less board (the
   * implicit default or a legacy implicit board) is unowned and shared, and a
   * recorded board must be visible under the dual-scope rule (session boards
   * only to their owner, project boards only within their workspace). A board
   * outside the caller's scope is denied as not found so its existence is not
   * leaked.
   * @param boardId - the board to check.
   * @param agent - the calling session agent.
   */
  private async assertBoardAccessible(boardId: string, agent: Agent): Promise<void> {
    const table = await this.boards()
    const board = table.get(boardId)
    if (board === undefined) return
    const workspace = await this.workspaceOf(agent)
    const workspaceId = workspace === undefined ? '' : workspace.id
    if (this.isBoardVisible(board, agent.id, workspaceId)) return
    throw new TaskboardError('board "' + boardId + '" does not exist', 'TASKBOARD_BOARD_NOT_FOUND')
  }

  /**
   * Validate the board context of one ticket operation: the requested board
   * (default "default") must be the ticket's own board.
   */
  private static boardContextOf(requestBoardId: string | undefined, ticket: TicketView): string {
    const requested = requestBoardId ?? 'default'
    if (ticket.boardId !== requested) {
      throw new TaskboardError(
        'ticket "' + ticket.id + '" is on board "' + ticket.boardId + '", not "' + requested + '"',
        'TASKBOARD_INVALID_INPUT',
      )
    }
    return ticket.boardId
  }

  /** Require the caller to be the current master of the ticket's board. */
  private async assertMasterOfTicket(ticket: TicketView, agent: Agent): Promise<void> {
    const table = await this.boards()
    const board = table.get(ticket.boardId)
    if (board === undefined || board.masterAgentId !== agent.id) {
      throw new TaskboardError(
        'only the master of board "' + ticket.boardId + '" may perform this action',
        'TASKBOARD_NOT_MASTER',
      )
    }
  }

  /** Require the caller to be the current master of one board (by id). */
  private async assertMasterOfBoard(boardId: string, agent: Agent): Promise<void> {
    await this.ensureMasterBoard(boardId, agent)
    const table = await this.boards()
    const board = table.get(boardId)
    if (board === undefined || board.masterAgentId !== agent.id) {
      throw new TaskboardError(
        'only the master of board "' + boardId + '" may perform this action',
        'TASKBOARD_NOT_MASTER',
      )
    }
  }

  /**
   * Compute the position of an index inside a column following the same
   * halving semantics as {@link positionBetween}: the target slot sits
   * between the (index-1)-th and the index-th neighbors of the column.
   */
  private positionAtIndex(
    table: KvTable<string, TicketView>,
    column: ColumnId,
    selfId: string,
    index: number,
  ): number {
    const rows = [...table.entries()]
      .map(([, ticket]) => ticket)
      .filter(ticket => ticket.column === column && ticket.id !== selfId)
      .sort((a, b) => a.position - b.position)
    const target = Math.min(index, rows.length)
    const before = target > 0 ? rows[target - 1] : undefined
    const after = target < rows.length ? rows[target] : undefined
    if (before !== undefined && after !== undefined) return (before.position + after.position) / 2
    if (before !== undefined) return before.position + 1
    if (after !== undefined) return after.position - 1
    return 0
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

  /**
   * Spawn the reviewer child for one ticket through the subagent seam. In
   * "report" mode the child only inspects and returns a structured verdict
   * ({ verdict, summary, problems }) — it is denied the card-mutating review
   * tools and the master resolves the review with taskboard_resolve_review.
   * In "direct" mode the v1 contract holds: the reviewer itself calls
   * taskboard_approve / taskboard_reject.
   */
  private async spawnReviewer(parent: Agent, ticket: TicketView): Promise<ReviewSpawnResult> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      return { spawned: false, reason: 'unavailable' }
    }
    try {
      const reportMode = this.resolved.reviewMode === 'report'
      const prompt: ContentBlock[] = [{
        type: 'text',
        text: reportMode ? buildReviewReportPrompt(ticket) : buildReviewPrompt(ticket),
      }]
      const request: SubagentStartRequest = {
        label: 'review ' + ticket.id,
        prompt,
        parent,
        signal: new AbortController().signal,
        agentOptions: { model: this.resolved.workerModel },
        // Report mode: the reviewer returns a structured conclusion only and
        // never decides on the card; direct mode keeps the v1 reviewer tools.
        ...(reportMode ? {
          outputSchema: REVIEW_OUTCOME_SCHEMA,
          toolFilter: { deny: REVIEWER_DENIED_TOOLS },
        } : {}),
      }
      const run: SubagentRun = await subagents.start(this.resolved.reviewProvider, request)
      return { spawned: true, reviewer: { agentId: run.id, label: reviewerLabel(run.id) }, run }
    } catch {
      return { spawned: false, reason: 'failed' }
    }
  }

  /**
   * Attach the reviewer-run settlement listener: when the report-mode child
   * settles with a structured verdict, write it back onto the card. Only the
   * reviewer the card currently names may write; the run never rejects (a
   * model error resolves with stopReason "error"), so the rejection arm is a
   * defensive no-op.
   */
  private trackReviewerRun(ticketId: string, sessionId: string, run: SubagentRun): void {
    const result: Promise<SubagentResult> | undefined = run.result
    if (result === undefined) return
    void result.then(
      (outcome) => { void this.recordReviewOutcome(ticketId, sessionId, outcome).catch(() => {}) },
      () => {},
    )
  }

  /** Persist the structured reviewer report when the settled run produced one. */
  private async recordReviewOutcome(ticketId: string, sessionId: string, outcome: SubagentResult): Promise<void> {
    const structured = outcome.structured
    if (structured === undefined || !isReviewOutcome(structured)) return
    await this.mutate(ticketId, 'review-claim', (current) => {
      // The card must still name this reviewer and remain under review;
      // a resolved or re-reviewed card no longer accepts the report.
      if (current.reviewer === null || current.reviewer.agentId !== sessionId) return current
      if (current.column !== 'in_testing') return current
      return {
        ...current,
        reviewOutcome: {
          verdict: structured.verdict,
          summary: structured.summary,
          problems: structured.problems,
          at: Date.now(),
        },
        updatedAt: Date.now(),
      }
    })
  }

  /**
   * Follow up the original worker after a rejection (打回原窗口). The worker
   * was spawned one-shot by V2-1's assign, and the continuation manager only
   * accepts continuable children, so this is best-effort: when the followup
   * cannot be delivered the master re-dispatches with taskboard_reassign.
   */
  private async followupWorker(master: Agent, ticket: TicketView, feedback: string): Promise<'sent' | 'unavailable' | 'none'> {
    if (ticket.workerSessionId === undefined) return 'none'
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined || typeof subagents.followup !== 'function') return 'unavailable'
    try {
      const content: ContentBlock[] = [{
        type: 'text',
        text: [
          'The reviewer rejected taskboard ticket ' + ticket.id + ' ("' + ticket.title + '").',
          '',
          'Rework feedback:',
          feedback,
          '',
          'Fix the issues above, then finish with EXACTLY ONE call to taskboard_report with ticketId "' + ticket.id + '" and devNotes summarizing the rework.',
        ].join('\n'),
      }]
      await subagents.followup(
        master,
        ticket.workerSessionId as SessionId,
        content,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: master.id },
          signal: new AbortController().signal,
        },
      )
      return 'sent'
    } catch {
      return 'unavailable'
    }
  }

  /**
   * Best-effort worker-session archive when a card lands in Done: the host's
   * workspace registry hides archived sessions from the grouping surfaces. A
   * missing registry, an unknown session, or a storage fault is not an error
   * — the resolution still succeeds and the result reports archived=false.
   */
  private async archiveWorkerSession(ticket: TicketView): Promise<boolean> {
    if (ticket.workerSessionId === undefined) return false
    const registry = this.ctx.get('workspaceRegistry') as { archiveSession?: (sessionId: SessionId) => Promise<void> } | undefined
    if (registry === undefined || typeof registry.archiveSession !== 'function') return false
    try {
      await registry.archiveSession(ticket.workerSessionId as SessionId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Spawn the worker child for one ticket and attach termination
   * reclamation to its run result.
   */
  private async spawnWorker(parent: Agent, ticket: TicketView, workerLabel?: string): Promise<WorkerSpawnResult> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      return { ok: false, reason: 'unavailable' }
    }
    try {
      const cwd = parent.session.header.cwd
      const request: SubagentStartRequest = {
        label: workerLabel ?? ticket.title,
        prompt: [{ type: 'text', text: buildWorkerPrompt(ticket, cwd) }],
        parent,
        signal: new AbortController().signal,
        agentOptions: { model: this.resolved.workerModel },
        toolFilter: { deny: WORKER_DENIED_TOOLS },
      }
      const run: SubagentRun = await subagents.start(this.resolved.workerProvider, request)
      return { ok: true, sessionId: run.id, run }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }

  /**
   * Reclaim a card whose worker session settled without reporting: the card
   * is still In progress and still owned by that session, so the worker was
   * terminated mid-flight.
   */
  private trackWorkerRun(ticketId: string, sessionId: string, run: SubagentRun): void {
    const result: Promise<SubagentResult> | undefined = run.result
    if (result === undefined) return
    void result.then(
      (outcome) => { void this.reclaimTerminatedWorker(ticketId, sessionId, outcome.stopReason).catch(() => {}) },
      () => { void this.reclaimTerminatedWorker(ticketId, sessionId, 'error').catch(() => {}) },
    )
  }

  /** Mark a card blocked when its worker session ended without reporting. */
  private async reclaimTerminatedWorker(ticketId: string, sessionId: string, stopReason: string): Promise<void> {
    await this.mutate(ticketId, 'fail', (current) => {
      if (current.workerSessionId !== sessionId) return current
      if (current.column !== 'in_progress' || current.status !== 'running') return current
      const detail = 'worker terminated (' + stopReason + ')'
      return appendHistory(
        {
          ...current,
          status: 'blocked',
          failure: { reason: detail, at: Date.now() },
          updatedAt: Date.now(),
        },
        'fail',
        detail,
      )
    })
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
    const current = table.get(request.ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertBoardAccessible(current.boardId, agent)
    TaskboardService.boardContextOf(request.boardId, current)
    const position = this.positionBetween(table, request.column, request.beforeTicketId, request.afterTicketId)
    const ticket = await this.mutate(request.ticketId, 'move', moved => appendHistory(
      {
        ...moved,
        column: request.column,
        position,
        reviewer: request.column === 'in_testing' ? moved.reviewer : null,
        updatedAt: Date.now(),
      },
      'move',
      'moved to ' + request.column,
    ))
    if (request.column === 'in_testing' && ticket.reviewer === null) {
      const spawn = await this.spawnReviewer(agent, ticket)
      if (spawn.spawned) {
        const withReviewer = await this.attachReviewer(ticket.id, spawn.reviewer, 'reviewer ' + spawn.reviewer.label + ' started')
        this.trackReviewerRun(ticket.id, spawn.reviewer.agentId, spawn.run)
        return withReviewer
      }
    }
    return ticket
  }

  /**
   * Whole-board snapshot, sorted by column then position, scoped to one
   * board the caller may see: its own session-private boards plus its
   * workspace's project boards and the unowned legacy ones. A board outside
   * the caller's scope is denied as not found so its existence is not leaked.
   * @param agent - the calling session agent; its session and workspace scope the board.
   * @param boardId - the board to snapshot, or undefined for the caller's default board.
   * @returns the live board snapshot.
   */
  @Remote('snapshot')
  async snapshot(agent: Agent, boardId?: string): Promise<BoardSnapshot> {
    const workspace = await this.workspaceOf(agent)
    const workspaceId = workspace === undefined ? '' : workspace.id
    await this.ensureSessionDefaultBoard(agent, workspace)
    const defaultBoard = await this.ensureDefaultBoard(
      workspaceId,
      workspace === undefined ? undefined : basename(workspace.path),
    )
    const board = boardId ?? defaultBoard?.boardId ?? 'default'
    await this.assertBoardAccessible(board, agent)
    const table = await this.openedTable()
    const rows: TicketView[] = []
    for (const [, ticket] of table.entries()) {
      if (ticket.boardId === board) rows.push(ticket)
    }
    const tickets = rows.sort((a, b) => {
      const columnOrder = TASKBOARD_COLUMNS.indexOf(a.column) - TASKBOARD_COLUMNS.indexOf(b.column)
      return columnOrder !== 0 ? columnOrder : a.position - b.position
    })
    return { boardId: board, name: await this.boardName(board), tickets }
  }

  private openTable: KvTable<string, TicketView> | null = null

  /**
   * List every board the caller may see: its session-private boards (scope
   * 'session' owned by this session), its workspace's project boards (scope
   * 'project' with a matching workspaceId), and the unowned legacy default
   * board awaiting adoption. Boards outside those scopes never appear, so a
   * foreign session-private board or a cross-workspace project board is not
   * leaked. The implicit unowned "default" board row is reported first when
   * no record exists for it yet (v1 compatibility).
   * @param agent - the calling session agent; its session and workspace scope the listing.
   * @returns the visible board rows.
   */
  @Remote('listBoards')
  async listBoards(agent: Agent): Promise<BoardView[]> {
    const workspace = await this.workspaceOf(agent)
    const workspaceId = workspace === undefined ? '' : workspace.id
    await this.ensureSessionDefaultBoard(agent, workspace)
    await this.ensureDefaultBoard(
      workspaceId,
      workspace === undefined ? undefined : basename(workspace.path),
    )
    const table = await this.boards()
    const boards: BoardView[] = []
    for (const [, board] of table.entries()) {
      if (this.isBoardVisible(board, agent.id, workspaceId)) boards.push(board)
    }
    if (table.get('default') === undefined) {
      boards.unshift({
        boardId: 'default',
        name: 'default',
        workspaceId: '',
        scope: 'project',
        ownerSessionId: null,
        masterAgentId: null,
        masterClaimedAt: null,
        handoverNotes: '',
        masterHistory: [],
        archivedAt: null,
      })
    }
    return boards
  }

  /**
   * Create one board through the Remote boundary. A 'project' scope stamps
   * the board with the caller's workspace ('' when unowned) and shares it
   * with every session of that workspace; the default 'session' scope records
   * the creating session as the owner and keeps the board private to it. The
   * boardId is always a fresh unique id; any workspaceId in the request is
   * ignored. An unowned caller (no resolvable cwd) is forced into 'session'
   * scope regardless of the request: a 'project' request from an unowned
   * session would otherwise mint a workspaceId-'' board shared with every
   * unowned session (the unowned leak).
   * @param agent - the calling session agent; it owns session boards and its workspace owns project boards.
   * @param request - the board name and visibility scope.
   * @returns the created board.
   */
  @Remote('createBoard')
  async createBoardRemote(agent: Agent, request: CreateBoardRequest): Promise<BoardView> {
    const workspace = await this.workspaceOf(agent)
    const workspaceId = workspace === undefined ? '' : workspace.id
    const scope = workspaceId === ''
      ? 'session' as const
      : request.scope === 'project' ? 'project' as const : 'session' as const
    await this.ensureSessionDefaultBoard(agent, workspace)
    await this.ensureDefaultBoard(
      workspaceId,
      workspace === undefined ? undefined : basename(workspace.path),
    )
    const record: BoardView = {
      boardId: 'board-' + randomUUID(),
      name: resolveBoardName(request.name),
      workspaceId,
      scope,
      ownerSessionId: scope === 'session' ? agent.id : null,
      masterAgentId: null,
      masterClaimedAt: null,
      handoverNotes: '',
      archivedAt: null,
      masterHistory: [],
    }
    await (await this.boards()).put(record.boardId, record)
    return record
  }

  /**
   * Archive one board through the Remote boundary. A board the caller cannot
   * see is denied as not found (no existence leak).
   * @param agent - the calling session agent.
   * @param request - the board to archive.
   * @returns the archived board.
   */
  @Remote('archiveBoard')
  async archiveBoardRemote(agent: Agent, request: ArchiveBoardRequest): Promise<BoardView> {
    await this.assertBoardAccessible(request.boardId, agent)
    return this.mutateBoard(request.boardId, current => ({ ...current, archivedAt: Date.now() }))
  }

  /**
   * Create one ticket in Backlog through the Remote boundary. The target
   * board must be visible to the caller; an invisible board is denied as not
   * found (no existence leak).
   * @param agent - the calling session agent.
   * @param request - title, description, priority, ordering dependencies, and optional boardId.
   * @returns the created ticket.
   */
  @Remote('create')
  createRemote(agent: Agent, request: CreateTicketRequest): Promise<TicketView> {
    return this.createRecordForBoard(agent, request)
  }

  /**
   * Shared Backlog creation used by the Remote surface and the master-only
   * taskboard_create tool. The Remote surface leaves type/targetBranch at
   * their defaults; the master tool supplies them explicitly.
   */
  private async createRecordForBoard(
    agent: Agent,
    request: CreateTicketRequest & { type?: TicketType; targetBranch?: string },
  ): Promise<TicketView> {
    await this.assertBoardAccessible(request.boardId ?? 'default', agent)
    const title = resolveTitle(request.title)
    const priority = TASKBOARD_PRIORITIES.includes(request.priority) ? request.priority : 'normal'
    const type = request.type !== undefined && TASKBOARD_TYPES.includes(request.type) ? request.type : 'feature'
    const now = Date.now()
    const record = {
      id: 'ticket-' + randomUUID(),
      title,
      description: typeof request.description === 'string' ? request.description : '',
      column: 'backlog' as ColumnId,
      priority,
      boardId: request.boardId ?? 'default',
      type,
      status: 'ready' as TicketWorkerStatus,
      failure: null,
      createdAt: now,
      updatedAt: now,
      assignee: null,
      reviewer: null,
      reviewAttempts: 0,
      lastReview: null,
      reviewOutcome: null,
      devNotes: '',
      targetBranch: typeof request.targetBranch === 'string' ? request.targetBranch : '',
      dependsOn: Array.isArray(request.dependsOn) ? request.dependsOn : [],
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
    const change: TaskboardChanged = { operation: 'create', ticketId: stored.id, boardId: stored.boardId, ticket: stored }
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
   * Edit one ticket through the Remote boundary. The ticket's board must be
   * visible to the caller; an invisible board is denied as not found (no
   * existence leak).
   * @param agent - the calling session agent.
   * @param request - replacement content and dependency edges.
   * @returns the edited ticket.
   */
  @Remote('edit')
  async editRemote(agent: Agent, request: EditTicketRequest): Promise<TicketView> {
    const title = resolveTitle(request.title)
    const priority = TASKBOARD_PRIORITIES.includes(request.priority) ? request.priority : 'normal'
    const table = await this.openedTable()
    const current = table.get(request.ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertBoardAccessible(current.boardId, agent)
    TaskboardService.boardContextOf(request.boardId, current)
    this.validateDependencies(table, request.ticketId, request.dependsOn)
    return this.mutate(request.ticketId, 'edit', edited => appendHistory(
      {
        ...edited,
        title,
        description: typeof request.description === 'string' ? request.description : edited.description,
        priority,
        dependsOn: request.dependsOn,
        targetBranch: typeof request.targetBranch === 'string' ? request.targetBranch : edited.targetBranch,
        updatedAt: Date.now(),
      },
      'edit',
      'content edited',
    ))
  }

  /**
   * Remove one ticket through the Remote boundary. The ticket's board must be
   * visible to the caller; an invisible board is denied as not found (no
   * existence leak).
   * @param agent - the calling session agent.
   * @param request - the ticket to remove.
   * @returns the removal receipt.
   */
  @Remote('delete')
  async removeRemote(agent: Agent, request: RemoveTicketRequest): Promise<RemoveTicketResult> {
    const table = await this.tickets()
    const current = table.get(request.ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertBoardAccessible(current.boardId, agent)
    const boardId = TaskboardService.boardContextOf(request.boardId, current)
    const removed = await table.delete(request.ticketId)
    if (!removed) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    const change: TaskboardChanged = { operation: 'remove', ticketId: request.ticketId, boardId, ticket: null }
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
    await this.assertBoardAccessible(current.boardId, agent)
    TaskboardService.boardContextOf(request.boardId, current)
    if (current.column !== 'in_testing') {
      throw new TaskboardError('ticket "' + current.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
    }
    const spawn = await this.spawnReviewer(agent, current)
    if (!spawn.spawned) {
      throw new TaskboardError('no reviewer backend is available to assign', 'TASKBOARD_INVALID_TRANSITION')
    }
    const withReviewer = await this.attachReviewer(current.id, spawn.reviewer, 'reviewer ' + spawn.reviewer.label + ' started')
    this.trackReviewerRun(current.id, spawn.reviewer.agentId, spawn.run)
    return withReviewer
  }

  /**
   * Claim the master seat of one board; a stale seat (past the lease) can be
   * preempted, and an unclaimed board is claimed by this agent. A board the
   * caller cannot see is denied as not found (no existence leak), so the
   * master seat of a foreign session-private board cannot be seized.
   * @param boardId - the board to claim.
   * @param agent - the claiming session agent.
   * @returns the board with its fresh master.
   */
  async claimMaster(boardId: string, agent: Agent): Promise<BoardView> {
    await this.assertBoardAccessible(boardId, agent)
    await this.ensureMasterBoard(boardId, agent)
    const now = Date.now()
    return this.mutateBoard(boardId, (current) => {
      if (current.masterAgentId !== null && current.masterAgentId !== agent.id) {
        const stale = current.masterClaimedAt !== null
          && now - current.masterClaimedAt >= this.resolved.masterSeatTimeoutMs
        if (!stale) {
          throw new TaskboardError(
            'board "' + boardId + '" master seat is held by ' + current.masterAgentId,
            'TASKBOARD_MASTER_HELD',
          )
        }
      }
      // A same-owner re-claim is a no-op: the seat and its history stay untouched.
      if (current.masterAgentId === agent.id) return current
      const entry: MasterHistoryEntry = {
        fromAgentId: current.masterAgentId,
        toAgentId: agent.id,
        at: now,
        notes: '',
      }
      return {
        ...current,
        masterAgentId: agent.id,
        masterClaimedAt: now,
        masterHistory: [...(current.masterHistory ?? []), entry],
      }
    })
  }

  /**
   * Release the master seat of one board; only the current master may. A
   * board the caller cannot see is denied as not found (no existence leak).
   * @param boardId - the board to release.
   * @param agent - the current master.
   * @returns the board with an empty seat.
   */
  async releaseMaster(boardId: string, agent: Agent): Promise<BoardView> {
    await this.assertBoardAccessible(boardId, agent)
    return this.mutateBoard(boardId, (current) => {
      if (current.masterAgentId !== agent.id) {
        throw new TaskboardError('only the current master may release the seat', 'TASKBOARD_NOT_MASTER')
      }
      return { ...current, masterAgentId: null, masterClaimedAt: null }
    })
  }

  /**
   * Transfer the master seat to another session agent with handover notes.
   * A board the caller cannot see is denied as not found (no existence leak).
   * @param boardId - the board to transfer.
   * @param fromAgent - the current master.
   * @param toAgentId - the receiving session agent id.
   * @param handoverNotes - notes for the next master.
   * @returns the board with the new master.
   */
  async transferMaster(boardId: string, fromAgent: Agent, toAgentId: string, handoverNotes: string): Promise<BoardView> {
    await this.assertBoardAccessible(boardId, fromAgent)
    return this.mutateBoard(boardId, (current) => {
      if (current.masterAgentId !== fromAgent.id) {
        throw new TaskboardError('only the current master may transfer the seat', 'TASKBOARD_NOT_MASTER')
      }
      if (typeof toAgentId !== 'string' || toAgentId.trim() === '') {
        throw new TaskboardError('transfer target agent id must be a non-empty string', 'TASKBOARD_INVALID_INPUT')
      }
      const notes = typeof handoverNotes === 'string' ? handoverNotes : ''
      const now = Date.now()
      const entry: MasterHistoryEntry = {
        fromAgentId: current.masterAgentId,
        toAgentId,
        at: now,
        notes,
      }
      return {
        ...current,
        masterAgentId: toAgentId,
        masterClaimedAt: now,
        handoverNotes: notes,
        masterHistory: [...(current.masterHistory ?? []), entry],
      }
    })
  }

  /**
   * Master assigns a Not started ticket to a freshly spawned worker: the
   * card moves to In progress, status running, and a worker subagent is
   * spawned immediately; on success its id is recorded on the card.
   * @param agent - the master session agent.
   * @param ticketId - the Not started ticket to dispatch.
   * @param workerLabel - optional display label for the worker child.
   * @returns the card plus the worker-spawn outcome.
   */
  async assign(agent: Agent, ticketId: string, workerLabel?: string): Promise<AssignTicketResult> {
    const table = await this.tickets()
    const current = table.get(ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertMasterOfTicket(current, agent)
    const running = await this.mutate(ticketId, 'assign', (ticket) => {
      if (ticket.column !== 'not_started') {
        throw new TaskboardError(
          'ticket "' + ticket.id + '" is in "' + ticket.column + '" (assign requires Not started)',
          'TASKBOARD_INVALID_TRANSITION',
        )
      }
      return appendHistory(
        {
          ...ticket,
          column: 'in_progress',
          status: 'running',
          assignee: { agentId: agent.id, label: agentLabel(agent) },
          failure: null,
          updatedAt: Date.now(),
        },
        'assign',
        'assigned to a worker by master ' + agentLabel(agent),
      )
    })
    const spawn = await this.spawnWorker(agent, running, workerLabel)
    if (!spawn.ok) {
      const blocked = await this.mutate(ticketId, 'fail', ticket => ({
        ...ticket,
        status: 'blocked',
        failure: { reason: 'worker spawn ' + spawn.reason, at: Date.now() },
        updatedAt: Date.now(),
      })).catch(() => running)
      return { ticket: blocked, worker: spawn.reason, workerAgentId: null }
    }
    const withWorker = await this.mutate(ticketId, 'assign', ticket => ({
      ...ticket,
      workerAgentId: spawn.sessionId,
      workerSessionId: spawn.sessionId,
      updatedAt: Date.now(),
    }))
    // Attach termination reclamation only after the worker identity is durable:
    // an already-settled run (e.g. an infrastructure rejection) fires its
    // settlement callback immediately, and the reclaim must see the card's
    // workerSessionId to avoid a spurious no-op.
    this.trackWorkerRun(ticketId, spawn.sessionId, spawn.run)
    return { ticket: withWorker, worker: 'spawned', workerAgentId: spawn.sessionId }
  }

  /**
   * The assigned worker reports development done; the ticket enters In
   * testing and a reviewer (same worker model) is spawned.
   * @param agent - the assigned worker session agent.
   * @param ticketId - the owned In progress ticket.
   * @param devNotes - what changed and how it was verified.
   * @returns the In testing ticket plus the reviewer-spawn outcome.
   */
  async report(agent: Agent, ticketId: string, devNotes: string): Promise<CompleteTicketResult> {
    const notes = resolveRequiredText(devNotes, 'report devNotes')
    const ticket = await this.mutate(ticketId, 'report', (current) => {
      if (current.workerAgentId !== agent.id) {
        throw new TaskboardError('only the assigned worker may report the ticket', 'TASKBOARD_NOT_WORKER')
      }
      if (current.column !== 'in_progress') {
        throw new TaskboardError(
          'ticket "' + current.id + '" is in "' + current.column + '" (report requires In progress)',
          'TASKBOARD_INVALID_TRANSITION',
        )
      }
      return appendHistory(
        { ...current, column: 'in_testing', status: 'claimed', devNotes: notes, updatedAt: Date.now() },
        'report',
        'worker reported development done, waiting for review',
      )
    })
    const spawn = await this.spawnReviewer(agent, ticket)
    if (!spawn.spawned) {
      return { ticket, review: spawn.reason, reviewerAgentId: null }
    }
    const withReviewer = await this.attachReviewer(ticket.id, spawn.reviewer, 'reviewer ' + spawn.reviewer.label + ' started')
    this.trackReviewerRun(ticket.id, spawn.reviewer.agentId, spawn.run)
    return { ticket: withReviewer, review: 'spawned', reviewerAgentId: spawn.reviewer.agentId }
  }

  /**
   * The assigned worker reports failure; the card stays In progress but is
   * marked blocked with a durable failure record.
   * @param agent - the assigned worker session agent.
   * @param ticketId - the owned In progress ticket.
   * @param reason - the concrete failure reason.
   * @returns the blocked ticket.
   */
  async fail(agent: Agent, ticketId: string, reason: string): Promise<TicketView> {
    const notes = resolveRequiredText(reason, 'fail reason')
    return this.mutate(ticketId, 'fail', (current) => {
      if (current.workerAgentId !== agent.id) {
        throw new TaskboardError('only the assigned worker may report failure', 'TASKBOARD_NOT_WORKER')
      }
      if (current.column !== 'in_progress') {
        throw new TaskboardError(
          'ticket "' + current.id + '" is in "' + current.column + '" (fail requires In progress)',
          'TASKBOARD_INVALID_TRANSITION',
        )
      }
      return appendHistory(
        { ...current, status: 'blocked', failure: { reason: notes, at: Date.now() }, updatedAt: Date.now() },
        'fail',
        'worker reported failure',
      )
    })
  }

  /**
   * Master re-dispatches one card: "retry" spawns a fresh worker (card back
   * to running, failure cleared), "backlog" returns the card to Not started.
   * @param agent - the master session agent.
   * @param ticketId - the In progress card to re-dispatch.
   * @param action - retry or backlog.
   * @param workerLabel - optional display label for a retry worker.
   * @returns the re-dispatched card plus the worker-spawn outcome.
   */
  async reassign(agent: Agent, ticketId: string, action: 'retry' | 'backlog', workerLabel?: string): Promise<ReassignTicketResult> {
    const table = await this.tickets()
    const current = table.get(ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertMasterOfTicket(current, agent)
    if (action === 'backlog') {
      const ticket = await this.mutate(ticketId, 'reassign', (returned) => {
        if (returned.column !== 'in_progress') {
          throw new TaskboardError(
            'ticket "' + returned.id + '" is in "' + returned.column + '" (backlog requires In progress)',
            'TASKBOARD_INVALID_TRANSITION',
          )
        }
        const reset: TicketView = {
          ...returned,
          column: 'not_started',
          status: 'ready',
          assignee: null,
          failure: null,
          reviewer: null,
          updatedAt: Date.now(),
        }
        delete reset.workerAgentId
        delete reset.workerSessionId
        return appendHistory(
          reset,
          'reassign',
          'returned to Not started by master',
        )
      })
      return { ticket, worker: null, workerAgentId: null }
    }
    const running = await this.mutate(ticketId, 'reassign', (retried) => {
      if (retried.column !== 'in_progress') {
        throw new TaskboardError(
          'ticket "' + retried.id + '" is in "' + retried.column + '" (retry requires In progress)',
          'TASKBOARD_INVALID_TRANSITION',
        )
      }
      return appendHistory(
        { ...retried, status: 'running', failure: null, updatedAt: Date.now() },
        'reassign',
        're-dispatched by master',
      )
    })
    const spawn = await this.spawnWorker(agent, running, workerLabel)
    if (!spawn.ok) {
      const blocked = await this.mutate(ticketId, 'fail', ticket => ({
        ...ticket,
        status: 'blocked',
        failure: { reason: 'worker spawn ' + spawn.reason, at: Date.now() },
        updatedAt: Date.now(),
      })).catch(() => running)
      return { ticket: blocked, worker: spawn.reason, workerAgentId: null }
    }
    const withWorker = await this.mutate(ticketId, 'reassign', ticket => ({
      ...ticket,
      workerAgentId: spawn.sessionId,
      workerSessionId: spawn.sessionId,
      updatedAt: Date.now(),
    }))
    this.trackWorkerRun(ticketId, spawn.sessionId, spawn.run)
    return { ticket: withWorker, worker: 'spawned', workerAgentId: spawn.sessionId }
  }

  /**
   * Master records a new ticket on a board's Backlog (the discussion
   * whiteboard: the plan the master agreed with the user is written down).
   * Unlike the Remote create surface, the master tool also sets the ticket
   * type and may target any board the caller masters.
   * @param agent - the master session agent.
   * @param request - title, description, type, priority, dependencies, boardId and optional targetBranch.
   * @returns the created Backlog ticket.
   */
  async createAsMaster(
    agent: Agent,
    request: CreateTicketRequest & { type?: TicketType; targetBranch?: string },
  ): Promise<TicketView> {
    const boardId = request.boardId ?? 'default'
    await this.assertMasterOfBoard(boardId, agent)
    return this.createRecordForBoard(agent, { ...request, boardId })
  }

  /**
   * Master schedules a ticket to another column, optionally next to an
   * anchor; entering In testing still auto-assigns a fresh reviewer. The
   * caller must hold the master seat of the ticket's board.
   * @param agent - the master session agent.
   * @param request - target column and optional position anchors.
   * @returns the moved ticket.
   */
  async moveAsMaster(agent: Agent, request: MoveTicketRequest): Promise<TicketView> {
    const table = await this.tickets()
    const current = table.get(request.ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + request.ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertMasterOfTicket(current, agent)
    // The master tool carries no boardId: resolve it from the ticket itself
    // so any board the caller masters can be scheduled. An explicit
    // boardId in the request is still honored and validated.
    const boardId = request.boardId ?? current.boardId
    return this.moveWithReviewer(agent, { ...request, boardId })
  }

  /**
   * Master adjusts the planning attributes of one ticket: dependency edges,
   * priority, and ordering position inside the ticket's column. Dependencies
   * are validated against the live board; position is an index in the column
   * ordering (halving semantics, like an anchor move).
   * @param agent - the master session agent.
   * @param ticketId - the ticket to plan.
   * @param dependsOn - replacement dependency edges, or undefined to keep them.
   * @param priority - replacement priority, or undefined to keep it.
   * @param position - the desired index in the ticket's column, or undefined to keep it.
   * @returns the planned ticket.
   */
  async planAsMaster(
    agent: Agent,
    ticketId: string,
    dependsOn: string[] | undefined,
    priority: Priority | undefined,
    position: number | undefined,
  ): Promise<TicketView> {
    const table = await this.tickets()
    const current = table.get(ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertMasterOfTicket(current, agent)
    const nextDependsOn = dependsOn === undefined ? current.dependsOn : dependsOn
    this.validateDependencies(table, ticketId, nextDependsOn)
    if (priority !== undefined && !TASKBOARD_PRIORITIES.includes(priority)) {
      throw new TaskboardError('unknown priority "' + String(priority) + '"', 'TASKBOARD_INVALID_INPUT')
    }
    let nextPosition = current.position
    if (position !== undefined) {
      if (!Number.isSafeInteger(position) || position < 0) {
        throw new TaskboardError('plan position must be a non-negative safe integer', 'TASKBOARD_INVALID_INPUT')
      }
      nextPosition = this.positionAtIndex(table, current.column, ticketId, position)
    }
    return this.mutate(ticketId, 'edit', planned => appendHistory(
      {
        ...planned,
        priority: priority === undefined ? planned.priority : priority,
        dependsOn: nextDependsOn,
        position: nextPosition,
        updatedAt: Date.now(),
      },
      'edit',
      'planned by master',
    ))
  }

  /**
   * Agent claims a Not started ticket and becomes its owner (v1 path, kept
   * for boards without a master seat).
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
          status: 'claimed',
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
   * reviewer (v1 path).
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
    this.trackReviewerRun(ticket.id, spawn.reviewer.agentId, spawn.run)
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
          status: 'claimed',
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
          status: 'claimed',
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
   * The master resolves a report-mode review against the reviewer-reported
   * verdict (taskboard_resolve_review). Approve lands the card in Done and
   * archives the worker session; reject returns the card for rework, tries to
   * follow up the original worker, and marks the card blocked on the third
   * consecutive reject for the user to decide. The master may not overturn a
   * rejection into an approval — the verdict is applied as reported.
   * @param agent - the master session agent.
   * @param ticketId - the In testing ticket under review.
   * @param verdict - the reviewer-reported conclusion to apply.
   * @param summary - what the reviewer inspected and concluded.
   * @param problems - concrete rework items (empty on approval).
   * @returns the resolved card plus the followup/archive outcomes.
   */
  async resolveReview(
    agent: Agent,
    ticketId: string,
    verdict: string,
    summary: string,
    problems: string[],
  ): Promise<ResolveReviewResult> {
    const table = await this.tickets()
    const current = table.get(ticketId)
    if (current === undefined) {
      throw new TaskboardError('ticket "' + ticketId + '" does not exist', 'TASKBOARD_TICKET_NOT_FOUND')
    }
    await this.assertMasterOfTicket(current, agent)
    if (current.column !== 'in_testing') {
      throw new TaskboardError('ticket "' + current.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
    }
    // Runtime guard: the tool schema enforces the enum, but a direct domain
    // caller must not silently turn an unknown verdict into a rejection.
    if (verdict !== 'approve' && verdict !== 'reject') {
      throw new TaskboardError('verdict must be "approve" or "reject"', 'TASKBOARD_INVALID_INPUT')
    }
    const cleanSummary = typeof summary === 'string' ? summary.trim() : ''
    const cleanProblems = Array.isArray(problems)
      ? problems
        .filter(problem => typeof problem === 'string')
        .map(problem => problem.trim())
        .filter(problem => problem.length > 0)
      : []
    // The reviewer identity comes from the attached review seat; a resolution
    // without a reviewer seat attributes the decision to the master.
    const reviewer: TicketAssignee = current.reviewer ?? { agentId: agent.id, label: agentLabel(agent) }
    const attempt = current.reviewAttempts + 1

    if (verdict === 'approve') {
      // Merge tickets land only against a master-confirmed target branch
      // (recorded in the ticket's targetBranch field or devNotes).
      if (current.type === 'merge' && current.targetBranch.trim() === '') {
        throw new TaskboardError(
          'merge ticket "' + ticketId + '" has no confirmed target branch; record it in targetBranch before approving',
          'TASKBOARD_INVALID_INPUT',
        )
      }
      const approved = await this.mutate(ticketId, 'approve', (ticket) => {
        if (ticket.column !== 'in_testing') {
          throw new TaskboardError('ticket "' + ticket.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
        }
        return appendHistory(
          {
            ...ticket,
            column: 'done',
            status: 'claimed',
            reviewAttempts: attempt,
            lastReview: {
              outcome: 'approved',
              feedback: cleanSummary,
              reviewer,
              attempt,
              at: Date.now(),
            },
            updatedAt: Date.now(),
          },
          'approve',
          'review approved by master',
        )
      })
      const archived = await this.archiveWorkerSession(approved)
      return { ticket: approved, action: 'approved', followup: 'none', archived, blockedAfterReject: false }
    }

    const feedback = cleanProblems.length > 0 ? cleanProblems.join('\n') : cleanSummary
    if (feedback.length === 0) {
      throw new TaskboardError('reject requires problems or a summary', 'TASKBOARD_INVALID_INPUT')
    }
    const blockedAfterReject = attempt >= 3
    const rejected = await this.mutate(ticketId, 'reject', (ticket) => {
      if (ticket.column !== 'in_testing') {
        throw new TaskboardError('ticket "' + ticket.id + '" is not In testing', 'TASKBOARD_INVALID_TRANSITION')
      }
      return appendHistory(
        {
          ...ticket,
          column: 'in_progress',
          status: blockedAfterReject ? 'blocked' : 'running',
          failure: blockedAfterReject ? { reason: 'rejected 3 times, awaiting user decision', at: Date.now() } : null,
          reviewAttempts: attempt,
          lastReview: {
            outcome: 'rejected',
            feedback,
            reviewer,
            attempt,
            at: Date.now(),
          },
          reviewer: null,
          updatedAt: Date.now(),
        },
        'reject',
        blockedAfterReject
          ? 'review rejected 3 times; awaiting user decision'
          : 'review rejected, returned for rework',
      )
    })
    const followup = await this.followupWorker(agent, rejected, feedback)
    return { ticket: rejected, action: 'rejected', followup, archived: false, blockedAfterReject }
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
        boardId: ticket.boardId,
        type: ticket.type,
        status: ticket.status,
        workerAgentId: ticket.workerAgentId ?? null,
        failure: ticket.failure,
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
        boardId: { type: 'string' as const, required: true as const },
        type: { type: 'string' as const, required: true as const, enum: [...TASKBOARD_TYPES] },
        status: { type: 'string' as const, required: true as const, enum: [...TASKBOARD_WORKER_STATUSES] },
        workerAgentId: {
          oneOf: [
            { type: 'string' as const },
            { type: 'null' as const },
          ] as const, required: true as const,
        },
        failure: {
          oneOf: [
            { type: 'object' as const, additionalProperties: false, properties: {
              reason: { type: 'string' as const, required: true as const },
              at: { type: 'number' as const, required: true as const },
            } },
            { type: 'null' as const },
          ] as const, required: true as const,
        },
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
            boardId: { type: 'string', required: true },
            type: { type: 'string', required: true, enum: [...TASKBOARD_TYPES] },
            status: { type: 'string', required: true, enum: [...TASKBOARD_WORKER_STATUSES] },
            workerAgentId: TaskboardService.ticketRowSchema().properties.workerAgentId,
            failure: TaskboardService.ticketRowSchema().properties.failure,
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
            reviewOutcome: {
              oneOf: [
                {
                  type: 'object', additionalProperties: false,
                  properties: {
                    verdict: { type: 'string', required: true, enum: ['approve', 'reject'] },
                    summary: { type: 'string', required: true },
                    problems: { type: 'array', required: true, items: { type: 'string' } },
                    at: { type: 'number', required: true },
                  },
                },
                { type: 'null' },
              ] as const, required: true,
            },
            devNotes: { type: 'string', required: true },
            targetBranch: { type: 'string', required: true },
            dependsOn: { type: 'array', required: true, items: { type: 'string' } },
            history: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  at: { type: 'number', required: true },
                  kind: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value: { id: string; title: string }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ': ' + value.title }],
      },
      execute: async (args: { ticketId: string }) => {
        const ticket = await this.viewTicket(args.ticketId)
        return {
          id: ticket.id,
          title: ticket.title,
          description: ticket.description,
          column: ticket.column,
          priority: ticket.priority,
          boardId: ticket.boardId,
          type: ticket.type,
          status: ticket.status,
          workerAgentId: ticket.workerAgentId ?? null,
          failure: ticket.failure,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          position: ticket.position,
          assignee: ticket.assignee,
          reviewer: ticket.reviewer,
          reviewAttempts: ticket.reviewAttempts,
          lastReview: ticket.lastReview,
          reviewOutcome: ticket.reviewOutcome,
          devNotes: ticket.devNotes,
          targetBranch: ticket.targetBranch,
          dependsOn: ticket.dependsOn,
          history: ticket.history,
        }
      },
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

    this.ctx.tools.register(defineTool({
      name: 'taskboard_claim_master',
      description: 'Claim the master seat of a taskboard board: the caller becomes the master of that board (default board "default") and gains the exclusive right to taskboard_assign/taskboard_reassign. A stale seat (past the master-seat lease) can be preempted.',
      parameters: {
        boardId: {
          type: 'string' as const,
          description: 'The board to claim. Omit for the default board.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            boardId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            masterAgentId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
          },
        },
        render: (_args, value: { boardId: string; masterAgentId: string | null }) => [{
          type: 'text' as const,
          text: 'master seat of board ' + value.boardId + ' claimed by ' + String(value.masterAgentId),
        }],
      },
      execute: async (args: { boardId?: string }, exec) => {
        const board = await this.claimMaster(args.boardId ?? 'default', TaskboardService.agentOf(exec))
        return { boardId: board.boardId, name: board.name, masterAgentId: board.masterAgentId }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Claim taskboard master seat', kind: 'other' as const, rawInput: args.boardId ?? 'default' }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_release_master',
      description: 'Release the master seat of a taskboard board (default board "default"); only the current master may release. After release, another agent may claim the seat.',
      parameters: {
        boardId: {
          type: 'string' as const,
          description: 'The board to release. Omit for the default board.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            boardId: { type: 'string', required: true },
            masterAgentId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
          },
        },
        render: (_args, value: { boardId: string }) => [{ type: 'text' as const, text: 'master seat of board ' + value.boardId + ' released' }],
      },
      execute: async (args: { boardId?: string }, exec) => {
        const board = await this.releaseMaster(args.boardId ?? 'default', TaskboardService.agentOf(exec))
        return { boardId: board.boardId, masterAgentId: board.masterAgentId }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Release taskboard master seat', kind: 'other' as const, rawInput: args.boardId ?? 'default' }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_assign',
      description: 'Dispatch a Not started taskboard ticket (master only): the card moves to In progress with status running and a fresh worker subagent (DeepSeek v4 flash) is spawned immediately with the ticket content. The worker finishes with taskboard_report (done) or taskboard_fail (blocked); the card records the worker identity.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The Not started ticket to dispatch.' },
        workerLabel: {
          type: 'string' as const,
          description: 'Optional display label for the worker subagent; defaults to the ticket title.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            status: { type: 'string', required: true, enum: [...TASKBOARD_WORKER_STATUSES] },
            worker: { type: 'string', required: true, enum: ['spawned', 'unavailable', 'failed'] },
            workerAgentId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
          },
        },
        render: (_args, value: { ticketId: string; worker: string; workerAgentId: string | null }) => [{
          type: 'text' as const,
          text: value.worker === 'spawned'
            ? 'ticket ' + value.ticketId + ' dispatched; worker ' + String(value.workerAgentId) + ' started'
            : 'ticket ' + value.ticketId + ' moved In progress but worker spawn ' + value.worker,
        }],
      },
      execute: async (args: { ticketId: string; workerLabel?: string }, exec) => {
        const result = await this.assign(TaskboardService.agentOf(exec), args.ticketId, args.workerLabel)
        return {
          ticketId: result.ticket.id,
          column: result.ticket.column,
          status: result.ticket.status,
          worker: result.worker,
          workerAgentId: result.workerAgentId,
        }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Assign taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_report',
      description: 'Report taskboard ticket development as complete (assigned worker only): the card moves to In testing and the board automatically assigns a fresh reviewer agent. devNotes summarizes what changed, which files were touched, and how it was verified — the reviewer reads exactly that.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket this worker was assigned.' },
        devNotes: {
          type: 'string' as const, required: true,
          description: 'What was implemented, files/areas touched, and how it was verified (tests run, manual checks).',
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
        render: (_args, value: { ticketId: string; review: string; reviewerAgentId: string | null }) => [{
          type: 'text' as const,
          text: value.review === 'spawned'
            ? 'ticket ' + value.ticketId + ' reported done; reviewer ' + String(value.reviewerAgentId) + ' assigned'
            : 'ticket ' + value.ticketId + ' reported done but reviewer spawn ' + value.review,
        }],
      },
      execute: async (args: { ticketId: string; devNotes: string }, exec) => {
        const result = await this.report(TaskboardService.agentOf(exec), args.ticketId, args.devNotes)
        return { ticketId: result.ticket.id, column: result.ticket.column, review: result.review, reviewerAgentId: result.reviewerAgentId }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Report taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_fail',
      description: 'Report a taskboard ticket as failed (assigned worker only): the card stays In progress but is marked blocked with your failure reason so the master can re-dispatch it.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket this worker was assigned.' },
        reason: { type: 'string' as const, required: true, description: 'Concrete failure reason (blocked, missing access, irrecoverable error).' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            status: { type: 'string', required: true, enum: [...TASKBOARD_WORKER_STATUSES] },
            failure: TaskboardService.ticketRowSchema().properties.failure,
          },
        },
        render: (_args, value: { id: string }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' marked blocked' }],
      },
      execute: async (args: { ticketId: string; reason: string }, exec) => {
        const value = await this.fail(TaskboardService.agentOf(exec), args.ticketId, args.reason)
        return { id: value.id, column: value.column, status: value.status, failure: value.failure }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Fail taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_reassign',
      description: 'Re-dispatch one taskboard ticket (master only): action "retry" clears the failure and spawns a fresh worker on the same In progress card (status back to running); action "backlog" returns the card to Not started with status ready, clearing assignee and worker identity.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The In progress card to re-dispatch.' },
        action: {
          type: 'string' as const, required: true, enum: ['retry', 'backlog'],
          description: 'retry spawns a new worker; backlog returns the card to Not started.',
        },
        workerLabel: {
          type: 'string' as const,
          description: 'Optional display label for a retry worker subagent.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            status: { type: 'string', required: true, enum: [...TASKBOARD_WORKER_STATUSES] },
            worker: { oneOf: [{ type: 'string', enum: ['spawned', 'unavailable', 'failed'] }, { type: 'null' }] as const, required: true },
            workerAgentId: { oneOf: [{ type: 'string' }, { type: 'null' }] as const, required: true },
          },
        },
        render: (_args, value: { ticketId: string; worker: string | null }) => [{
          type: 'text' as const,
          text: value.worker === 'spawned'
            ? 'ticket ' + value.ticketId + ' re-dispatched; new worker started'
            : 'ticket ' + value.ticketId + ' re-dispatched; worker spawn ' + String(value.worker),
        }],
      },
      execute: async (args: { ticketId: string; action: 'retry' | 'backlog'; workerLabel?: string }, exec) => {
        const result = await this.reassign(TaskboardService.agentOf(exec), args.ticketId, args.action, args.workerLabel)
        return {
          ticketId: result.ticket.id,
          column: result.ticket.column,
          status: result.ticket.status,
          worker: result.worker,
          workerAgentId: result.workerAgentId,
        }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Reassign taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_resolve_review',
      description: 'Resolve a report-mode review (master only): apply the reviewer-reported verdict for an In testing taskboard ticket. approve moves the card to Done and archives the worker session; reject returns the card for rework with the reviewer\'s problems as feedback. The master applies the verdict as reported and may not overturn a rejection. After the third consecutive reject the card is marked blocked, awaiting the user\'s decision.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The In testing ticket under review.' },
        verdict: {
          type: 'string' as const, required: true, enum: ['approve', 'reject'],
          description: 'The reviewer-reported conclusion to apply.',
        },
        summary: {
          type: 'string' as const, required: true,
          description: 'What the reviewer inspected and concluded.',
        },
        problems: {
          type: 'array' as const, required: true, items: { type: 'string' as const },
          description: 'Concrete rework items reported by the reviewer (empty when approving).',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ticketId: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            status: { type: 'string', required: true, enum: [...TASKBOARD_WORKER_STATUSES] },
            action: { type: 'string', required: true, enum: ['approved', 'rejected'] },
            followup: { type: 'string', required: true, enum: ['sent', 'unavailable', 'none'] },
            archived: { type: 'boolean', required: true },
            blockedAfterReject: { type: 'boolean', required: true },
          },
        },
        render: (_args, value: { ticketId: string; action: 'approved' | 'rejected'; followup: string; blockedAfterReject: boolean }) => [{
          type: 'text' as const,
          text: value.action === 'approved'
            ? 'ticket ' + value.ticketId + ' approved and Done'
            : 'ticket ' + value.ticketId + ' rejected for rework (worker followup ' + value.followup + (value.blockedAfterReject ? '; blocked after 3 rejects' : '') + ')',
        }],
      },
      execute: async (args: { ticketId: string; verdict: 'approve' | 'reject'; summary: string; problems: string[] }, exec) => {
        const result = await this.resolveReview(TaskboardService.agentOf(exec), args.ticketId, args.verdict, args.summary, args.problems)
        return {
          ticketId: result.ticket.id,
          column: result.ticket.column,
          status: result.ticket.status,
          action: result.action,
          followup: result.followup,
          archived: result.archived,
          blockedAfterReject: result.blockedAfterReject,
        }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Resolve taskboard review', kind: 'other' as const, rawInput: args.ticketId }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_create',
      description: 'Create a taskboard ticket on a board\'s Backlog (master only): the plan you agreed with the user is written down as a card. The ticket lands in Backlog with the given type, priority and dependencies.',
      parameters: {
        boardId: {
          type: 'string' as const,
          description: 'The board to create the ticket on. Omit for the default board.',
        },
        title: { type: 'string' as const, required: true, description: 'Ticket title.' },
        description: { type: 'string' as const, required: true, description: 'Ticket description / acceptance criteria.' },
        type: {
          type: 'string' as const,
          enum: [...TASKBOARD_TYPES],
          description: 'Ticket kind badge. Omit for "feature".',
        },
        priority: {
          type: 'string' as const,
          enum: [...TASKBOARD_PRIORITIES],
          description: 'Ticket priority. Omit for "normal".',
        },
        dependsOn: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Ticket ids this ticket waits for; all must exist and be open to completion.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            type: { type: 'string', required: true, enum: [...TASKBOARD_TYPES] },
            boardId: { type: 'string', required: true },
          },
        },
        render: (_args, value: { id: string; title: string; column: ColumnId }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' ("' + value.title + '") created in ' + value.column }],
      },
      execute: async (args: {
        boardId?: string
        title: string
        description: string
        type?: TicketType
        priority?: Priority
        dependsOn?: string[]
      }, exec) => {
        const agent = TaskboardService.agentOf(exec)
        const ticket = await this.createAsMaster(agent, {
          title: args.title,
          description: args.description,
          priority: args.priority ?? 'normal',
          dependsOn: args.dependsOn ?? [],
          ...(args.boardId === undefined ? {} : { boardId: args.boardId }),
          ...(args.type === undefined ? {} : { type: args.type }),
        })
        return { id: ticket.id, title: ticket.title, column: ticket.column, type: ticket.type, boardId: ticket.boardId }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Create taskboard ticket', kind: 'other' as const, rawInput: args.title }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_move',
      description: 'Move a taskboard ticket between columns (master only): schedules the card, optionally next to an anchor ticket. Moving into In testing keeps the automatic reviewer assignment.',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket to move.' },
        column: {
          type: 'string' as const, required: true, enum: [...TASKBOARD_COLUMNS],
          description: 'The target column.',
        },
        beforeTicketId: {
          type: 'string' as const,
          description: 'Insert immediately before this ticket in the target column.',
        },
        afterTicketId: {
          type: 'string' as const,
          description: 'Insert immediately after this ticket in the target column (used when before is omitted).',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            reviewer: TaskboardService.ticketRowSchema().properties.reviewer,
          },
        },
        render: (_args, value: { id: string; title: string; column: ColumnId }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' ("' + value.title + '") moved to ' + value.column }],
      },
      execute: async (args: { ticketId: string; column: ColumnId; beforeTicketId?: string; afterTicketId?: string }, exec) => {
        const ticket = await this.moveAsMaster(TaskboardService.agentOf(exec), {
          ticketId: args.ticketId,
          column: args.column,
          beforeTicketId: args.beforeTicketId ?? null,
          afterTicketId: args.afterTicketId ?? null,
        })
        return { id: ticket.id, title: ticket.title, column: ticket.column, reviewer: ticket.reviewer }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Move taskboard ticket', kind: 'other' as const, rawInput: args.ticketId + ' -> ' + args.column }),
    }))

    this.ctx.tools.register(defineTool({
      name: 'taskboard_plan',
      description: 'Plan a taskboard ticket (master only): adjust dependency edges, priority, and the card\'s ordering position inside its column. Dependency changes take effect immediately on claim gates; position is an index in the column ordering (0 = first).',
      parameters: {
        ticketId: { type: 'string' as const, required: true, description: 'The ticket to plan.' },
        dependsOn: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Replacement dependency edges (tickets that must be Done first). Omit to keep the current edges.',
        },
        priority: {
          type: 'string' as const,
          enum: [...TASKBOARD_PRIORITIES],
          description: 'Replacement priority. Omit to keep the current priority.',
        },
        position: {
          type: 'number' as const,
          description: 'Desired index in the ticket\'s column ordering (0 = first). Omit to keep the current position.',
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            column: { type: 'string', required: true, enum: [...TASKBOARD_COLUMNS] },
            priority: { type: 'string', required: true, enum: [...TASKBOARD_PRIORITIES] },
            dependsOn: { type: 'array', required: true, items: { type: 'string' } },
            position: { type: 'number', required: true },
          },
        },
        render: (_args, value: { id: string; title: string; position: number }) => [{ type: 'text' as const, text: 'ticket ' + value.id + ' ("' + value.title + '") planned at position ' + String(value.position) }],
      },
      execute: async (args: { ticketId: string; dependsOn?: string[]; priority?: Priority; position?: number }, exec) => {
        const ticket = await this.planAsMaster(
          TaskboardService.agentOf(exec),
          args.ticketId,
          args.dependsOn,
          args.priority,
          args.position,
        )
        return {
          id: ticket.id,
          title: ticket.title,
          column: ticket.column,
          priority: ticket.priority,
          dependsOn: ticket.dependsOn,
          position: ticket.position,
        }
      },
      presentCall: args => ({ card: 'generic' as const, title: 'Plan taskboard ticket', kind: 'other' as const, rawInput: args.ticketId }),
    }))
  }
}

/**
 * Administrative taskboard tools denied to spawned workers: the worker only
 * reports (taskboard_report) or fails (taskboard_fail); everything else on
 * the board belongs to the master. Only names registered in the global tool
 * registry may be denied — tools.restrict() rejects unknown names loudly, so
 * future administrative tools must be appended here when they land. The
 * master-only whiteboard tools (create/move/plan) are registered before this
 * list is consulted, so denying them here is safe.
 */
const WORKER_DENIED_TOOLS = [
  'taskboard_claim', 'taskboard_list', 'taskboard_view', 'taskboard_complete',
  'taskboard_claim_review', 'taskboard_approve', 'taskboard_reject', 'taskboard_update',
  'taskboard_assign', 'taskboard_reassign', 'taskboard_claim_master', 'taskboard_release_master',
  'taskboard_create', 'taskboard_move', 'taskboard_plan',
] as const

/**
 * Administrative review tools denied to report-mode reviewers: the reviewer
 * only inspects and returns a structured verdict — the master resolves the
 * card with taskboard_resolve_review. Names must be registered in the global
 * tool registry (tools.restrict() rejects unknown names loudly).
 */
const REVIEWER_DENIED_TOOLS = ['taskboard_approve', 'taskboard_reject'] as const

export default TaskboardService
