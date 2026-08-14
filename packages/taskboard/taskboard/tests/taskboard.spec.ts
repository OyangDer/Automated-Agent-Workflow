/**
 * Domain-level acceptance of the taskboard workflow: creation, board
 * isolation, the master seat (claim/release/transfer/preemption), user
 * moves, the v1 claim path (owner/capacity/dependency rules), the v2
 * dispatch protocol (assign → report → review, fail → blocked, reassign),
 * worker-model injection, failure reclamation, and old-data compatibility.
 * Runs against the real storage-domain facility with a temp JSON backend and
 * a stubbed subagent seam.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TaskboardService, { TASKBOARD_COLUMNS } from '@deepseek-ai/dsh-taskboard'
import type { TaskboardChanged, TicketView } from '@deepseek-ai/dsh-taskboard'

/** Build a registry-compatible agent around one concrete session. */
function stubAgentForSession(session: Session): Agent {
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** A fresh agent with a fresh session. */
function stubAgent(rawId: string): Agent {
  return stubAgentForSession(Session.create(SessionId(rawId)))
}

/** A fresh agent whose session header carries an absolute cwd. */
function stubAgentWithCwd(rawId: string, cwd: string): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd,
  })
  return stubAgentForSession(session)
}

/** One stubbed workspace-registry resolution result. */
function workspaceStub(id: string, path: string): { id: string; path: string } {
  return { id, path }
}

/** How the stubbed subagent seam answers one spawn. */
type SpawnBehavior = 'spawn' | 'fail' | 'absent'

/** A minimal controllable run result for failure-reclamation and review write-back tests. */
interface RunResultStub {
  output: never[]
  stopReason: string
  /** Structured value a report-mode reviewer run settles with. */
  structured?: unknown
}

interface Harness {
  ctx: Context
  service: TaskboardService
  root: string
  changes: TaskboardChanged[]
  devA: Agent
  devB: Agent
  reviewerChild: Agent
  workerChild: Agent
  spawnedReviewerId: string
  spawnedWorkerId: string
  /** The vi.fn backing the stubbed subagents.start seam. */
  subagentsStart: ReturnType<typeof vi.fn>
}

interface HarnessOptions {
  maxInProgress?: number
  spawn?: SpawnBehavior
  masterSeatTimeoutMs?: number
  /** Pre-seeded storage root; a fresh temp root when omitted. */
  root?: string
  /** When set, worker spawns return a run carrying this result promise. */
  workerRunResult?: Promise<RunResultStub>
  /** When set, reviewer spawns return a run carrying this result promise. */
  reviewerRunResult?: Promise<RunResultStub>
  /** The review protocol; defaults to "report". */
  reviewMode?: 'report' | 'direct'
  /** When set, the stubbed subagent seam also exposes followup. */
  followup?: ReturnType<typeof vi.fn>
  /** When set, a stubbed workspace registry archives session ids through this fn. */
  archive?: ReturnType<typeof vi.fn>
  /** When set, the stubbed workspace registry resolves cwds through this fn. */
  resolveByPath?: (path: string) => Promise<{ id: string; path: string } | undefined>
}

/** Compose the real storage chain plus the taskboard service with stubs. */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { maxInProgress = 2, spawn = 'spawn' } = options
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'taskboard-'))
  openRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const spawnedReviewerId = 'reviewer-child-agent'
  const spawnedWorkerId = 'worker-child-agent'
  let subagentsStart: ReturnType<typeof vi.fn>
  if (spawn === 'spawn') {
    subagentsStart = vi.fn(async (_provider: string, request: SubagentStartRequest) => {
      const id = request.label?.startsWith('review ')
        ? spawnedReviewerId
        : spawnedWorkerId
      const result = id === spawnedReviewerId
        ? options.reviewerRunResult
        : options.workerRunResult
      return {
        id,
        ...(result === undefined ? {} : { result }),
      }
    })
    ctx.provide('subagents', {
      start: subagentsStart,
      ...(options.followup === undefined ? {} : { followup: options.followup }),
    } as never)
  } else if (spawn === 'fail') {
    subagentsStart = vi.fn(async () => {
      throw new Error('spawn exploded')
    })
    ctx.provide('subagents', {
      start: subagentsStart,
      ...(options.followup === undefined ? {} : { followup: options.followup }),
    } as never)
  } else {
    subagentsStart = vi.fn()
  }
  if (options.resolveByPath !== undefined || options.archive !== undefined) {
    ctx.provide('workspaceRegistry', {
      ...(options.resolveByPath === undefined ? {} : { resolveByPath: options.resolveByPath }),
      ...(options.archive === undefined ? {} : { archiveSession: options.archive }),
    } as never)
  }
  await ctx.plugin(TaskboardService, {
    maxInProgress,
    ...(options.masterSeatTimeoutMs === undefined ? {} : { masterSeatTimeoutMs: options.masterSeatTimeoutMs }),
    ...(options.reviewMode === undefined ? {} : { reviewMode: options.reviewMode }),
  })
  const service = ctx.taskboard
  const changes: TaskboardChanged[] = []
  ctx.on('taskboard/changed', change => changes.push(change))
  const devA = stubAgent('dev-agent-a')
  const devB = stubAgent('dev-agent-b')
  const reviewerChild = stubAgent(spawnedReviewerId)
  const workerChild = stubAgent(spawnedWorkerId)
  ctx.agents.register(devA)
  ctx.agents.register(devB)
  ctx.agents.register(reviewerChild)
  ctx.agents.register(workerChild)
  return { ctx, service, root, changes, devA, devB, reviewerChild, workerChild, spawnedReviewerId, spawnedWorkerId, subagentsStart }
}

/** Temp storage roots created by the harnesses, cleaned between cases. */
const openRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(openRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createTicket(service: TaskboardService, title: string, dependsOn: string[] = [], boardId = 'default'): Promise<TicketView> {
  return await service.createRemote({ title, description: 'describe ' + title, priority: 'normal', dependsOn, boardId })
}

async function toNotStarted(service: TaskboardService, agent: Agent, ticket: TicketView): Promise<TicketView> {
  return await service.moveRemote(agent, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
}

async function claimTicket(service: TaskboardService, agent: Agent, ticket: TicketView): Promise<TicketView> {
  return await service.claim(agent, ticket.id)
}

/** Complete and assert the reviewer spawn, returning the In testing ticket. */
async function completeTicket(service: TaskboardService, agent: Agent, ticket: TicketView): Promise<TicketView> {
  const result = await service.complete(agent, ticket.id, 'implemented and tested')
  expect(result.review).toBe('spawned')
  expect(result.reviewerAgentId).toBe('reviewer-child-agent')
  return result.ticket
}

describe('TaskboardService workflow', () => {
  it('creates tickets in Backlog and serves a column-sorted snapshot', async () => {
    const { service, devA } = await harness()
    const first = await createTicket(service, 'first feature')
    const second = await createTicket(service, 'second feature')
    const snapshot = await service.snapshot(devA)
    expect(snapshot.boardId).toBe('default')
    expect(snapshot.tickets.map(ticket => ticket.column)).toEqual(['backlog', 'backlog'])
    expect(snapshot.tickets.map(ticket => ticket.id)).toEqual([first.id, second.id])
    expect(first.column).toBe('backlog')
    expect(first.assignee).toBeNull()
    expect(first.status).toBe('ready')
    expect(first.type).toBe('feature')
    expect(first.failure).toBeNull()
  })

  it('isolates tickets per board in the snapshot', async () => {
    const { service, devA } = await harness()
    const onDefault = await createTicket(service, 'default board card')
    const onAlpha = await createTicket(service, 'alpha card', [], 'alpha')
    const onBeta = await createTicket(service, 'beta card', [], 'beta')
    const defaultSnapshot = await service.snapshot(devA)
    expect(defaultSnapshot.tickets.map(ticket => ticket.id)).toEqual([onDefault.id])
    const alphaSnapshot = await service.snapshot(devA, 'alpha')
    expect(alphaSnapshot.boardId).toBe('alpha')
    expect(alphaSnapshot.tickets.map(ticket => ticket.id)).toEqual([onAlpha.id])
    const betaSnapshot = await service.snapshot(devA, 'beta')
    expect(betaSnapshot.tickets.map(ticket => ticket.id)).toEqual([onBeta.id])
    // Legacy endpoints reject a mismatched boardId.
    await expect(service.moveRemote(devAgent(onDefault), { ticketId: onDefault.id, column: 'not_started', beforeTicketId: null, afterTicketId: null, boardId: 'alpha' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_INVALID_INPUT' })
  })

  it('lists, creates and archives boards through the Remote surface', async () => {
    const { service, devA } = await harness()
    const boards = await service.listBoards(devA)
    expect(boards).toHaveLength(1)
    expect(boards[0]!.boardId).toBe('default')
    const created = await service.createBoardRemote(devA, { name: 'Sprint 42', workspaceId: 'ws-1' })
    expect(created.boardId).toMatch(/^board-/)
    expect(created.name).toBe('Sprint 42')
    // The caller's workspace stamps the board; an unowned caller creates unowned boards.
    expect(created.workspaceId).toBe('')
    expect(created.masterAgentId).toBeNull()
    const listed = await service.listBoards(devA)
    expect(listed.map(board => board.boardId).sort()).toEqual([created.boardId, 'default'].sort())
    const archived = await service.archiveBoardRemote({ boardId: created.boardId })
    expect(archived.archivedAt).not.toBeNull()
    await expect(service.archiveBoardRemote({ boardId: 'no-such-board' })).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('claims, holds, preempts and releases the master seat', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { service, devA, devB } = await harness()
      const claimed = await service.claimMaster('default', devA)
      expect(claimed.masterAgentId).toBe(devA.id)
      expect(claimed.masterClaimedAt).not.toBeNull()
      // A second agent cannot steal a live seat.
      await expect(service.claimMaster('default', devB)).rejects.toMatchObject({ code: 'TASKBOARD_MASTER_HELD' })
      // Past the 15-minute lease the seat is stale and can be preempted.
      vi.advanceTimersByTime(900001)
      const preempted = await service.claimMaster('default', devB)
      expect(preempted.masterAgentId).toBe(devB.id)
      // Only the current master may release.
      await expect(service.releaseMaster('default', devA)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
      const released = await service.releaseMaster('default', devB)
      expect(released.masterAgentId).toBeNull()
      expect(released.masterClaimedAt).toBeNull()
      // After release the first agent claims cleanly.
      const again = await service.claimMaster('default', devA)
      expect(again.masterAgentId).toBe(devA.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('transfers the master seat with handover notes', async () => {
    const { service, devA, devB } = await harness()
    await service.claimMaster('default', devA)
    const transferred = await service.transferMaster('default', devA, devB.id, 'board is yours now')
    expect(transferred.masterAgentId).toBe(devB.id)
    expect(transferred.handoverNotes).toBe('board is yours now')
    await expect(service.transferMaster('default', devA, devB.id, 'nope')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
  })

  it('assign dispatches a flash worker; report flows into review with a flash reviewer', async () => {
    const { service, devA, workerChild, reviewerChild, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'dispatch me')
    await toNotStarted(service, devA, ticket)
    const result = await service.assign(devA, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(result.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.column).toBe('in_progress')
    expect(result.ticket.status).toBe('running')
    expect(result.ticket.assignee?.agentId).toBe(devA.id)
    expect(result.ticket.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.workerSessionId).toBe('worker-child-agent')
    // The worker spawn carries the flash model and the administrative tool filter.
    const workerCall = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    expect(workerCall[0]).toBe('spawn')
    expect(workerCall[1].agentOptions?.model).toBe('deepseek-v4-flash')
    expect(workerCall[1].toolFilter?.deny).toContain('taskboard_claim')
    expect(workerCall[1].toolFilter?.deny).toContain('taskboard_assign')
    // Only the assigned worker may report.
    await expect(service.report(devA, ticket.id, 'not the worker')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_WORKER' })
    const reported = await service.report(workerChild, ticket.id, 'implemented the feature')
    expect(reported.review).toBe('spawned')
    expect(reported.ticket.column).toBe('in_testing')
    expect(reported.ticket.status).toBe('claimed')
    expect(reported.ticket.reviewer?.agentId).toBe(reviewerChild.id)
    // The reviewer spawn also uses the flash model.
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    expect(reviewCall[0]).toBe('spawn')
    expect(reviewCall[1].agentOptions?.model).toBe('deepseek-v4-flash')
    const done = await service.approve(reviewerChild, reported.ticket.id, 'verified')
    expect(done.column).toBe('done')
  })

  it('fail marks the card blocked in place; only the assigned worker may fail', async () => {
    const { service, devA, devB, workerChild } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'doomed card')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    await expect(service.fail(devB, ticket.id, 'not mine')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_WORKER' })
    const blocked = await service.fail(workerChild, ticket.id, 'dependency service is down')
    expect(blocked.column).toBe('in_progress')
    expect(blocked.status).toBe('blocked')
    expect(blocked.failure).toMatchObject({ reason: 'dependency service is down' })
    expect(typeof blocked.failure?.at).toBe('number')
  })

  it('reassign retry spawns a fresh worker and backlog returns to Not started', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'flaky card')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    await service.fail(workerChild, ticket.id, 'exploded')
    // Backlog returns the card to Not started, fully reset.
    const backlogged = await service.reassign(devA, ticket.id, 'backlog')
    expect(backlogged.worker).toBeNull()
    expect(backlogged.ticket.column).toBe('not_started')
    expect(backlogged.ticket.status).toBe('ready')
    expect(backlogged.ticket.assignee).toBeNull()
    expect(backlogged.ticket.workerAgentId).toBeUndefined()
    expect(backlogged.ticket.workerSessionId).toBeUndefined()
    expect(backlogged.ticket.failure).toBeNull()
    // Re-dispatch and retry spawns a second worker.
    await toNotStarted(service, devA, backlogged.ticket)
    const second = await service.assign(devA, backlogged.ticket.id)
    expect(second.ticket.status).toBe('running')
    await service.fail(workerChild, second.ticket.id, 'still broken')
    const retried = await service.reassign(devA, second.ticket.id, 'retry')
    expect(retried.worker).toBe('spawned')
    expect(retried.ticket.status).toBe('running')
    expect(retried.ticket.failure).toBeNull()
    expect(retried.ticket.workerSessionId).toBe('worker-child-agent')
    expect(subagentsStart.mock.calls).toHaveLength(3)
  })

  it('requires the master seat for assign and reassign', async () => {
    const { service, devA, devB } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'guarded card')
    await toNotStarted(service, devA, ticket)
    await expect(service.assign(devB, ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    await expect(service.reassign(devB, ticket.id, 'backlog')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
  })

  it('reclaims a card whose worker run settles without reporting', async () => {
    let settle!: (result: RunResultStub) => void
    const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
    const { service, devA } = await harness({ workerRunResult: runResult })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'vanishing worker')
    await toNotStarted(service, devA, ticket)
    const assigned = await service.assign(devA, ticket.id)
    expect(assigned.ticket.status).toBe('running')
    settle({ output: [], stopReason: 'error' })
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ticket.id)
      expect(current.status).toBe('blocked')
      expect(current.failure?.reason).toContain('worker terminated')
    })
  })

  it('reclaims a card when the worker run infrastructure rejects', async () => {
    const runResult = Promise.reject(new Error('transport broke'))
    void runResult.catch(() => {})
    const { service, devA } = await harness({ workerRunResult: runResult })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'crashing worker')
    await toNotStarted(service, devA, ticket)
    const assigned = await service.assign(devA, ticket.id)
    expect(assigned.ticket.status).toBe('running')
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ticket.id)
      expect(current.status).toBe('blocked')
      expect(current.failure?.reason).toContain('worker terminated (error)')
    })
  })

  it('emits a forwarded change per mutation and a tombstone on removal', async () => {
    const { service, changes } = await harness()
    const ticket = await createTicket(service, 'to remove')
    expect(changes.at(-1)).toMatchObject({ operation: 'create', ticketId: ticket.id, boardId: 'default' })
    const result = await service.removeRemote({ ticketId: ticket.id })
    expect(result.removedId).toBe(ticket.id)
    expect(changes.at(-1)).toEqual({ operation: 'remove', ticketId: ticket.id, boardId: 'default', ticket: null })
    await expect(service.removeRemote({ ticketId: ticket.id })).rejects.toMatchObject({ code: 'TASKBOARD_TICKET_NOT_FOUND' })
  })

  it('claims a Not started ticket and enforces ownership and capacity', async () => {
    const { service, devA, devB } = await harness()
    const ticket = await createTicket(service, 'parallel one')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    expect(claimed.column).toBe('in_progress')
    expect(claimed.assignee?.agentId).toBe(devA.id)
    expect(claimed.status).toBe('claimed')
    // A second agent cannot steal the claim.
    await expect(claimTicket(service, devB, claimed)).rejects.toMatchObject({ code: 'TASKBOARD_ALREADY_CLAIMED' })
    // Capacity: with maxInProgress 2, two more claims exhaust the board.
    const second = await createTicket(service, 'parallel two')
    await toNotStarted(service, devA, second)
    const third = await createTicket(service, 'parallel three')
    await toNotStarted(service, devB, third)
    await claimTicket(service, devB, second)
    await expect(claimTicket(service, devA, third)).rejects.toMatchObject({ code: 'TASKBOARD_CAPACITY_EXCEEDED' })
  })

  it('gates claims on dependency order', async () => {
    const { service, devA, reviewerChild } = await harness()
    const base = await createTicket(service, 'base task')
    const dependent = await createTicket(service, 'dependent task', [base.id])
    await toNotStarted(service, devA, base)
    await toNotStarted(service, devA, dependent)
    await expect(claimTicket(service, devA, dependent)).rejects.toMatchObject({ code: 'TASKBOARD_DEPENDENCY_BLOCKED' })
    const claimedBase = await claimTicket(service, devA, base)
    const inTesting = await completeTicket(service, devA, claimedBase)
    await service.approve(reviewerChild, inTesting.id, 'verified')
    const claimedDependent = await claimTicket(service, devA, dependent)
    expect(claimedDependent.column).toBe('in_progress')
  })

  it('complete spawns a reviewer; the designated reviewer approves into Done', async () => {
    const { service, devA, reviewerChild, changes } = await harness()
    const ticket = await createTicket(service, 'ship it')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    const inTesting = await completeTicket(service, devA, claimed)
    expect(inTesting.column).toBe('in_testing')
    expect(inTesting.reviewer?.agentId).toBe(reviewerChild.id)
    // Only the designated reviewer may decide.
    await expect(service.approve(devA, inTesting.id, 'looks good')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_REVIEWER' })
    const done = await service.approve(reviewerChild, inTesting.id, 'looks good')
    expect(done.column).toBe('done')
    expect(done.reviewAttempts).toBe(1)
    expect(done.lastReview).toMatchObject({ outcome: 'approved', feedback: 'looks good' })
    expect(changes.filter(change => change.operation === 'approve').length).toBe(1)
  })

  it('reject returns the ticket for rework with feedback, then a second round passes', async () => {
    const { service, devA, reviewerChild } = await harness()
    const ticket = await createTicket(service, 'flaky feature')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    const inTesting = await completeTicket(service, devA, claimed)
    const rejected = await service.reject(reviewerChild, inTesting.id, 'missing error handling in parse()')
    expect(rejected.column).toBe('in_progress')
    expect(rejected.reviewAttempts).toBe(1)
    expect(rejected.lastReview).toMatchObject({ outcome: 'rejected', feedback: 'missing error handling in parse()' })
    expect(rejected.reviewer).toBeNull()
    // Rework and resubmit; the second round approves.
    const again = await completeTicket(service, devA, rejected)
    expect(again.column).toBe('in_testing')
    const done = await service.approve(reviewerChild, again.id, 'fixed and verified')
    expect(done.column).toBe('done')
    expect(done.reviewAttempts).toBe(2)
  })

  it('falls back to claimReview when the reviewer seam is unavailable', async () => {
    const { service, devA, devB } = await harness({ spawn: 'absent' })
    const ticket = await createTicket(service, 'manual review')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    const result = await service.complete(devA, claimed.id, 'done, no auto reviewer')
    expect(result.review).toBe('unavailable')
    expect(result.ticket.reviewer).toBeNull()
    const reviewed = await service.claimReview(devB, result.ticket.id)
    expect(reviewed.reviewer?.agentId).toBe(devB.id)
    const done = await service.approve(devB, result.ticket.id, 'manual approval')
    expect(done.column).toBe('done')
  })

  it('leaves the review seat empty when the reviewer spawn fails', async () => {
    const { service, devA, devB } = await harness({ spawn: 'fail' })
    const ticket = await createTicket(service, 'fragile review')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    const result = await service.complete(devA, claimed.id, 'done')
    expect(result.review).toBe('failed')
    expect(result.ticket.reviewer).toBeNull()
    await service.claimReview(devB, result.ticket.id)
    await expect(service.claimReview(devA, result.ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_REVIEWER_PRESENT' })
  })

  it('rejects dependency cycles and unknown dependencies on create/edit', async () => {
    const { service } = await harness()
    const a = await createTicket(service, 'node a')
    const b = await createTicket(service, 'node b')
    // Duplicate entries are invalid input.
    await expect(createTicket(service, 'dup', [a.id, a.id])).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_INPUT' })
    // A depends on B; editing B to depend on A closes the cycle.
    await service.editRemote({ ticketId: a.id, title: 'node a', description: '', priority: 'normal', dependsOn: [b.id] })
    await expect(service.editRemote({ ticketId: b.id, title: 'node b', description: '', priority: 'normal', dependsOn: [a.id] }))
      .rejects.toMatchObject({ code: 'TASKBOARD_DEPENDENCY_CYCLE' })
    await expect(service.editRemote({ ticketId: b.id, title: 'node b', description: '', priority: 'normal', dependsOn: ['missing-ticket'] }))
      .rejects.toMatchObject({ code: 'TASKBOARD_DEPENDENCY_UNKNOWN' })
  })

  it('anchors moved tickets between neighbors by position', async () => {
    const { service, devA } = await harness()
    const first = await createTicket(service, 'first')
    const second = await createTicket(service, 'second')
    const third = await createTicket(service, 'third')
    await toNotStarted(service, devA, second)
    await toNotStarted(service, devA, third)
    const moved = await service.moveRemote(devA, {
      ticketId: first.id, column: 'not_started', beforeTicketId: third.id, afterTicketId: null,
    })
    expect(moved.column).toBe('not_started')
    const rows = (await service.snapshot(devA)).tickets.filter(ticket => ticket.column === 'not_started')
    expect(rows.map(ticket => ticket.id)).toEqual([second.id, first.id, third.id])
    expect(rows[1]!.position).toBeGreaterThan(rows[0]!.position)
    expect(rows[1]!.position).toBeLessThan(rows[2]!.position)
  })

  it('report mode spawns a reporting reviewer with outputSchema, tool filter and the flash model', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness({ reviewMode: 'report' })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'report-mode card')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    expect(reported.review).toBe('spawned')
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    expect(reviewCall[1].agentOptions?.model).toBe('deepseek-v4-flash')
    expect(reviewCall[1].outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['approve', 'reject'] },
        summary: { type: 'string' },
        problems: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'problems'],
    })
    expect(reviewCall[1].toolFilter?.deny).toContain('taskboard_approve')
    expect(reviewCall[1].toolFilter?.deny).toContain('taskboard_reject')
  })

  it('direct mode keeps the v1 reviewer contract without structured output', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness({ reviewMode: 'direct' })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'direct-mode card')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    await service.report(workerChild, ticket.id, 'implemented')
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    expect(reviewCall[1].outputSchema).toBeUndefined()
    expect(reviewCall[1].toolFilter).toBeUndefined()
  })

  it('writes back the structured reviewer report onto the card', async () => {
    let settle!: (result: RunResultStub) => void
    const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
    const { service, devA, workerChild, changes } = await harness({ reviewerRunResult: runResult })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'structured review')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    expect(reported.ticket.reviewer?.agentId).toBe('reviewer-child-agent')
    expect(reported.ticket.reviewOutcome).toBeNull()
    settle({
      output: [],
      stopReason: 'completed',
      structured: { verdict: 'reject', summary: 'inspected the changes', problems: ['parse() lacks error handling'] },
    })
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ticket.id)
      expect(current.reviewOutcome).toMatchObject({
        verdict: 'reject',
        summary: 'inspected the changes',
        problems: ['parse() lacks error handling'],
      })
    })
    expect(changes.some(change => change.operation === 'review-claim' && change.ticket?.reviewOutcome !== null)).toBe(true)
  })

  it('ignores a settled reviewer run without a valid structured report', async () => {
    let settle!: (result: RunResultStub) => void
    const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
    const { service, devA, workerChild } = await harness({ reviewerRunResult: runResult })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'no structured report')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    await service.report(workerChild, ticket.id, 'implemented')
    settle({ output: [], stopReason: 'completed', structured: { verdict: 'maybe' } })
    await new Promise(resolve => setTimeout(resolve, 25))
    const current = await service.viewTicket(ticket.id)
    expect(current.reviewOutcome).toBeNull()
  })

  it('resolveReview approve lands in Done and archives the worker session', async () => {
    const archive = vi.fn(async () => {})
    const { service, devA, workerChild } = await harness({ archive })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'approve me')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    const result = await service.resolveReview(devA, reported.ticket.id, 'approve', 'verified the implementation', [])
    expect(result.action).toBe('approved')
    expect(result.archived).toBe(true)
    expect(result.ticket.column).toBe('done')
    expect(result.ticket.reviewAttempts).toBe(1)
    expect(result.ticket.lastReview).toMatchObject({ outcome: 'approved', feedback: 'verified the implementation', attempt: 1 })
    expect(result.ticket.lastReview?.reviewer.agentId).toBe('reviewer-child-agent')
    expect(archive).toHaveBeenCalledWith('worker-child-agent')
  })

  it('requires the master seat for resolveReview', async () => {
    const { service, devA, devB, workerChild } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'guarded review')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    await expect(service.resolveReview(devB, reported.ticket.id, 'approve', 'ok', []))
      .rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
  })

  it('resolveReview reject returns the card for rework with the reviewer problems', async () => {
    const { service, devA, workerChild } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'rework me')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    const result = await service.resolveReview(devA, reported.ticket.id, 'reject', 'reviewed the change', [
      'missing error handling in parse()',
      'tests do not cover the edge case',
    ])
    expect(result.action).toBe('rejected')
    // A one-shot worker session cannot receive a continuation followup.
    expect(result.followup).toBe('unavailable')
    expect(result.blockedAfterReject).toBe(false)
    expect(result.ticket.column).toBe('in_progress')
    expect(result.ticket.status).toBe('running')
    expect(result.ticket.reviewAttempts).toBe(1)
    expect(result.ticket.lastReview).toMatchObject({ outcome: 'rejected', attempt: 1 })
    expect(result.ticket.lastReview?.feedback).toContain('missing error handling in parse()')
    expect(result.ticket.lastReview?.feedback).toContain('tests do not cover the edge case')
    expect(result.ticket.reviewer).toBeNull()
    expect(result.ticket.failure).toBeNull()
  })

  it('follows up the original worker when the subagent seam supports it', async () => {
    const followup = vi.fn(async () => 'msg-1')
    const { service, devA, workerChild } = await harness({ followup })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'rework window')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    const result = await service.resolveReview(devA, reported.ticket.id, 'reject', 'reviewed', ['fix the parse() path'])
    expect(result.followup).toBe('sent')
    expect(followup).toHaveBeenCalledTimes(1)
    const call = followup.mock.calls[0] as unknown[]
    expect((call[0] as { id: string }).id).toBe(devA.id)
    expect(call[1]).toBe('worker-child-agent')
    const text = (call[2] as { type: string; text: string }[])[0]!.text
    expect(text).toContain(ticket.id)
    expect(text).toContain('fix the parse() path')
  })

  it('marks the card blocked after the third consecutive reject', async () => {
    const { service, devA, workerChild } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'three strikes')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const first = await service.report(workerChild, ticket.id, 'attempt one')
    await service.resolveReview(devA, first.ticket.id, 'reject', 'reviewed', ['problem one'])
    const second = await service.report(workerChild, ticket.id, 'attempt two')
    await service.resolveReview(devA, second.ticket.id, 'reject', 'reviewed', ['problem two'])
    const third = await service.report(workerChild, ticket.id, 'attempt three')
    const result = await service.resolveReview(devA, third.ticket.id, 'reject', 'reviewed', ['problem three'])
    expect(result.blockedAfterReject).toBe(true)
    expect(result.ticket.column).toBe('in_progress')
    expect(result.ticket.status).toBe('blocked')
    expect(result.ticket.failure).toMatchObject({ reason: 'rejected 3 times, awaiting user decision' })
    expect(result.ticket.reviewAttempts).toBe(3)
    expect(result.ticket.lastReview?.outcome).toBe('rejected')
  })

  it('reserves create/move/plan for the master of the board', async () => {
    const { service, devA, devB } = await harness()
    await service.claimMaster('default', devA)
    // create: non-master rejected, master lands a Backlog card.
    await expect(service.createAsMaster(devB, { title: 'no', description: '', priority: 'normal', dependsOn: [] }))
      .rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    const ticket = await service.createAsMaster(devA, { title: 'master card', description: 'planned', priority: 'high', dependsOn: [] })
    expect(ticket.column).toBe('backlog')
    expect(ticket.type).toBe('feature')
    // move: non-master rejected, master schedules between columns.
    await expect(service.moveAsMaster(devB, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null }))
      .rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    const moved = await service.moveAsMaster(devA, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    expect(moved.column).toBe('not_started')
    // plan: non-master rejected, master adjusts priority/dependencies/position.
    await expect(service.planAsMaster(devB, ticket.id, [], undefined, undefined))
      .rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    const planned = await service.planAsMaster(devA, ticket.id, [], 'low', 0)
    expect(planned.priority).toBe('low')
    expect(planned.dependsOn).toEqual([])
    expect(planned.position).toBe(0)
  })

  it('plan rewires dependencies and the claim gate follows', async () => {
    const { service, devA, reviewerChild } = await harness()
    await service.claimMaster('default', devA)
    const base = await service.createAsMaster(devA, { title: 'base', description: '', priority: 'normal', dependsOn: [] })
    const dependent = await service.createAsMaster(devA, { title: 'dependent', description: '', priority: 'normal', dependsOn: [] })
    // The master adds the dependency edge through plan.
    const planned = await service.planAsMaster(devA, dependent.id, [base.id], undefined, undefined)
    expect(planned.dependsOn).toEqual([base.id])
    await service.moveAsMaster(devA, { ticketId: base.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await service.moveAsMaster(devA, { ticketId: dependent.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await expect(service.claim(devA, dependent.id)).rejects.toMatchObject({ code: 'TASKBOARD_DEPENDENCY_BLOCKED' })
    const claimedBase = await service.claim(devA, base.id)
    const inTesting = await completeTicket(service, devA, claimedBase)
    await service.approve(reviewerChild, inTesting.id, 'verified')
    // Once the dependency is Done the gate opens.
    const claimedDependent = await service.claim(devA, dependent.id)
    expect(claimedDependent.column).toBe('in_progress')
    // Removing the edge re-opens the gate even while the dependency is open.
    const second = await service.createAsMaster(devA, { title: 'second', description: '', priority: 'normal', dependsOn: [] })
    await service.planAsMaster(devA, second.id, [dependent.id], undefined, undefined)
    await service.moveAsMaster(devA, { ticketId: second.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await expect(service.claim(devA, second.id)).rejects.toMatchObject({ code: 'TASKBOARD_DEPENDENCY_BLOCKED' })
    await service.planAsMaster(devA, second.id, [], undefined, undefined)
    const claimedSecond = await service.claim(devA, second.id)
    expect(claimedSecond.column).toBe('in_progress')
  })

  it('requires a master-confirmed target branch before approving a merge ticket', async () => {
    const { service, devA, workerChild } = await harness()
    await service.claimMaster('default', devA)
    const merge = await service.createAsMaster(devA, { title: 'merge the branch', description: '', priority: 'normal', dependsOn: [], type: 'merge' })
    expect(merge.type).toBe('merge')
    expect(merge.targetBranch).toBe('')
    await service.moveAsMaster(devA, { ticketId: merge.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await service.assign(devA, merge.id)
    const reported = await service.report(workerChild, merge.id, 'merged cleanly')
    // Approve without a confirmed target branch is refused.
    await expect(service.resolveReview(devA, reported.ticket.id, 'approve', 'verified', []))
      .rejects.toMatchObject({ code: 'TASKBOARD_INVALID_INPUT' })
    // Record the master-confirmed target branch, then the approve lands.
    await service.editRemote({ ticketId: merge.id, title: 'merge the branch', description: '', priority: 'normal', dependsOn: [], targetBranch: 'main' })
    const result = await service.resolveReview(devA, reported.ticket.id, 'approve', 'verified', [])
    expect(result.action).toBe('approved')
    expect(result.ticket.column).toBe('done')
    expect(result.ticket.targetBranch).toBe('main')
  })

  it('merge review prompts demand conflict, CI and target-branch checks', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const merge = await service.createAsMaster(devA, { title: 'merge me', description: '', priority: 'normal', dependsOn: [], type: 'merge' })
    await service.moveAsMaster(devA, { ticketId: merge.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await service.assign(devA, merge.id)
    await service.report(workerChild, merge.id, 'done')
    // Report mode: the reviewer prompt carries the merge specifics.
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    const prompt = (reviewCall[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('merge conflicts')
    expect(prompt).toContain('CI results')
    expect(prompt).toContain('target branch')
    // A non-merge ticket gets no merge specifics.
    const feature = await service.createAsMaster(devA, { title: 'feature', description: '', priority: 'normal', dependsOn: [] })
    await service.moveAsMaster(devA, { ticketId: feature.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await service.assign(devA, feature.id)
    await service.report(workerChild, feature.id, 'done')
    const featureCall = subagentsStart.mock.calls[3] as [string, SubagentStartRequest]
    const featurePrompt = (featureCall[1].prompt as { type: string; text: string }[])[0]!.text
    expect(featurePrompt).not.toContain('Merge ticket specifics')
    // Direct mode keeps the same merge checks.
    const direct = await harness({ reviewMode: 'direct' })
    await direct.service.claimMaster('default', direct.devA)
    const directMerge = await direct.service.createAsMaster(direct.devA, { title: 'direct merge', description: '', priority: 'normal', dependsOn: [], type: 'merge' })
    await direct.service.moveAsMaster(direct.devA, { ticketId: directMerge.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await direct.service.assign(direct.devA, directMerge.id)
    await direct.service.report(direct.workerChild, directMerge.id, 'done')
    const directCall = direct.subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    const directPrompt = (directCall[1].prompt as { type: string; text: string }[])[0]!.text
    expect(directPrompt).toContain('merge conflicts')
    expect(directPrompt).toContain('CI results')
    expect(directPrompt).toContain('target branch')
  })

  it('records handover notes on transfer and reads them back', async () => {
    const { service, devA, devB } = await harness()
    await service.claimMaster('default', devA)
    await service.transferMaster('default', devA, devB.id, 'board state: 3 cards; worker w1 on card A, worker w2 on card B; review pending on card C')
    const boards = await service.listBoards(devA)
    const board = boards.find(candidate => candidate.boardId === 'default')!
    expect(board.masterAgentId).toBe(devB.id)
    expect(board.handoverNotes).toContain('worker w1 on card A')
    // The new master transfers onward, overwriting the notes.
    const again = await service.transferMaster('default', devB, devA.id, 'round two')
    expect(again.masterAgentId).toBe(devA.id)
    expect(again.handoverNotes).toBe('round two')
  })

  it('isolates boards and tickets per workspace through the Remote surface', async () => {
    const cwdA = 'C:\\work\\project-alpha'
    const cwdB = 'C:\\work\\project-beta'
    const wsA = workspaceStub('ws-alpha', cwdA)
    const wsB = workspaceStub('ws-beta', cwdB)
    const resolveByPath = vi.fn(async (path: string) => path === cwdA ? wsA : path === cwdB ? wsB : undefined)
    const { service } = await harness({ resolveByPath })
    const agentA = stubAgentWithCwd('ws-agent-a', cwdA)
    const agentB = stubAgentWithCwd('ws-agent-b', cwdB)
    // First access auto-creates a per-workspace default board named after the directory basename.
    const boardsA = await service.listBoards(agentA)
    expect(boardsA).toHaveLength(1)
    expect(boardsA[0]).toMatchObject({ boardId: 'default', workspaceId: 'ws-alpha', name: 'project-alpha' })
    const boardsB = await service.listBoards(agentB)
    expect(boardsB).toHaveLength(1)
    expect(boardsB[0]).toMatchObject({ workspaceId: 'ws-beta', name: 'project-beta' })
    expect(boardsB[0]!.boardId).not.toBe('default')
    // Tickets created on a workspace's default board stay invisible to the other workspace.
    const ticketA = await service.createRemote({ title: 'alpha card', description: '', priority: 'normal', dependsOn: [], boardId: boardsA[0]!.boardId })
    const ticketB = await service.createRemote({ title: 'beta card', description: '', priority: 'normal', dependsOn: [], boardId: boardsB[0]!.boardId })
    const snapA = await service.snapshot(agentA, boardsA[0]!.boardId)
    expect(snapA.tickets.map(ticket => ticket.id)).toEqual([ticketA.id])
    const snapB = await service.snapshot(agentB, boardsB[0]!.boardId)
    expect(snapB.tickets.map(ticket => ticket.id)).toEqual([ticketB.id])
    // Cross-workspace boards are denied as not found and never listed.
    await expect(service.snapshot(agentA, boardsB[0]!.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.snapshot(agentB, boardsA[0]!.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    expect((await service.listBoards(agentA)).map(board => board.boardId)).not.toContain(boardsB[0]!.boardId)
    expect((await service.listBoards(agentB)).map(board => board.boardId)).not.toContain(boardsA[0]!.boardId)
    // createBoard stamps the caller's workspace over any requested value.
    const createdA = await service.createBoardRemote(agentA, { name: 'Sprint A', workspaceId: 'ws-beta' })
    expect(createdA.workspaceId).toBe('ws-alpha')
    expect((await service.listBoards(agentB)).map(board => board.boardId)).not.toContain(createdA.boardId)
    await expect(service.snapshot(agentB, createdA.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('lazily adopts the legacy unowned default board to the first real workspace', async () => {
    const cwdA = 'C:\\work\\legacy-project'
    const cwdB = 'C:\\work\\other-project'
    const wsA = workspaceStub('ws-legacy', cwdA)
    const wsB = workspaceStub('ws-other', cwdB)
    const resolveByPath = vi.fn(async (path: string) => path === cwdA ? wsA : path === cwdB ? wsB : undefined)
    const { service } = await harness({ resolveByPath })
    // v1-shaped data lives on the unowned default board before any real-workspace access.
    const unowned = stubAgent('legacy-unowned')
    const legacyTicket = await service.createRemote({ title: 'legacy card', description: '', priority: 'normal', dependsOn: [], boardId: 'default' })
    expect((await service.snapshot(unowned, 'default')).tickets.map(ticket => ticket.id)).toEqual([legacyTicket.id])
    // The first real-workspace access adopts the default board and names it after the directory.
    const owner = stubAgentWithCwd('legacy-owner', cwdA)
    const boards = await service.listBoards(owner)
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({ boardId: 'default', workspaceId: 'ws-legacy', name: 'legacy-project' })
    // The adopted board still serves the legacy tickets.
    expect((await service.snapshot(owner, 'default')).tickets.map(ticket => ticket.id)).toEqual([legacyTicket.id])
    // The unowned session loses the adopted board.
    await expect(service.snapshot(unowned, 'default')).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    expect((await service.listBoards(unowned)).map(board => board.boardId)).not.toContain('default')
    // A second real workspace cannot see the adopted default board either.
    const other = stubAgentWithCwd('legacy-other', cwdB)
    const boardsB = await service.listBoards(other)
    expect(boardsB).toHaveLength(1)
    expect(boardsB[0]).toMatchObject({ workspaceId: 'ws-other', name: 'other-project' })
    expect(boardsB[0]!.boardId).not.toBe('default')
    await expect(service.snapshot(other, 'default')).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('falls back to unowned when the session cwd cannot be resolved to a workspace', async () => {
    const resolveByPath = vi.fn(async () => { throw new Error('path does not exist') })
    const { service } = await harness({ resolveByPath })
    const agent = stubAgentWithCwd('unresolved-agent', 'C:\\work\\missing-project')
    // A resolving failure falls back to unowned: the legacy default board remains shared.
    const boards = await service.listBoards(agent)
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({ boardId: 'default', workspaceId: '' })
    // createBoard stamps the unowned caller with the empty workspace id.
    const created = await service.createBoardRemote(agent, { name: 'Unowned board' })
    expect(created.workspaceId).toBe('')
    // A session without any cwd sees the same unowned boards.
    const other = stubAgent('no-cwd-agent')
    expect((await service.listBoards(other)).map(board => board.boardId)).toContain(created.boardId)
    await expect(service.snapshot(other, created.boardId)).resolves.toMatchObject({ boardId: created.boardId })
  })

  it('loads v1-shaped records from a seeded storage root with zod defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-v1-'))
    const now = Date.now()
    const v1Ticket = {
      id: 'ticket-v1-legacy',
      title: 'legacy card',
      description: 'written by v1',
      column: 'in_progress',
      priority: 'high',
      createdAt: now,
      updatedAt: now,
      position: 0,
      assignee: { agentId: 'legacy-agent', label: 'agent legacy-a' },
      reviewer: null,
      reviewAttempts: 0,
      lastReview: null,
      devNotes: '',
      dependsOn: [],
      history: [],
    }
    await writeFile(
      join(root, 'taskboard.json'),
      JSON.stringify({
        unit: { name: 'taskboard', version: 1 },
        global: null,
        tables: { tickets: { [v1Ticket.id]: v1Ticket } },
      }, null, 2),
    )
    const { service, devA } = await harness({ root })
    const snapshot = await service.snapshot(devA)
    expect(snapshot.tickets).toHaveLength(1)
    const loaded = snapshot.tickets[0]!
    expect(loaded.id).toBe('ticket-v1-legacy')
    expect(loaded.boardId).toBe('default')
    expect(loaded.type).toBe('feature')
    expect(loaded.status).toBe('claimed')
    expect(loaded.failure).toBeNull()
    expect(loaded.workerAgentId).toBeUndefined()
  })
})

describe('column vocabulary', () => {
  it('exposes the five canonical columns in order', () => {
    expect(TASKBOARD_COLUMNS).toEqual(['backlog', 'not_started', 'in_progress', 'in_testing', 'done'])
  })
})

/** A throwaway agent used for move calls that only need a session. */
function devAgent(ticket: TicketView): Agent {
  return stubAgent('move-agent-' + ticket.id)
}
