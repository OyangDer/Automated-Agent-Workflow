/**
 * Domain-level acceptance of the taskboard workflow: creation, board
 * isolation, the master seat (claim/release/transfer/preemption), user
 * moves, the v1 claim path (owner/dependency rules), the v2
 * dispatch protocol (assign → report → review, fail → blocked, reassign),
 * worker-model injection, failure reclamation, worker-liveness
 * reconciliation (startup scan + periodic scanner), and old-data
 * compatibility. Runs against the real storage-domain facility with a temp
 * JSON backend and a stubbed subagent seam.
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
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import TaskboardService, { TASKBOARD_COLUMNS } from '@deepseek-ai/dsh-taskboard'
import type { TaskboardChanged, TicketView } from '@deepseek-ai/dsh-taskboard'
import {
  branchNameFor, buildHandoverNotes, buildReviewPrompt, buildReviewReportPrompt, buildWorkerPrompt,
  DISPATCH_TURN_END, MASTER_SECTION, masterModelNote, WORKFLOW_SECTION,
} from '../src/domain.ts'
import {
  compileReviewerCapsule, compileWorkerCapsule, parseSections, parseWorkerClaims,
  reviewerDepthFromDescription, reviewerFactsFromPreflight,
} from '../src/capsule.ts'
import type { ReviewerGitFacts } from '../src/capsule.ts'
import type { PreflightReport } from '../src/types.ts'

/** Build a registry-compatible agent around one concrete session. */
function stubAgentForSession(session: Session): Agent {
  const nextTurn: Parameters<Inbox['append']>[1][] = []
  const nextStep: Parameters<Inbox['append']>[1][] = []
  const inbox: Inbox = {
    nextTurn,
    nextStep,
    clear() { nextTurn.splice(0); nextStep.splice(0) },
    append(target, message) { (target === 'next-turn' ? nextTurn : nextStep).push(message) },
    prepend(target, message) { (target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
    replace(messageId, message) {
      for (const pending of [nextTurn, nextStep]) {
        const index = pending.findIndex(candidate => candidate.id === messageId)
        if (index >= 0) { pending.splice(index, 1, message); return true }
      }
      return false
    },
    remove(messageId) {
      for (const pending of [nextTurn, nextStep]) {
        const index = pending.findIndex(candidate => candidate.id === messageId)
        if (index >= 0) { pending.splice(index, 1); return true }
      }
      return false
    },
    splice(target, start, deleteCount, inserted) {
      return (target === 'next-turn' ? nextTurn : nextStep).splice(start, deleteCount, ...inserted)
    },
  }
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
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd,
  })
  return stubAgentForSession(session)
}

/** One stubbed workspace-registry resolution result. */
function workspaceStub(id: string, path: string): { id: string; path: string } {
  return { id, path }
}

/**
 * A minimal in-memory session-persistence double mirroring the coordinator's
 * append/inspect contract: append validates contiguous seq and records the
 * batch; inspect serves the stored log (rejecting unknown sessions, as the
 * real backends do). The recorded log is exactly what a resumed agent-loop
 * session replays through its Inbox projection.
 */
function fakeSessionPersistence() {
  const stored = new Map<string, SessionEvent[]>()
  return {
    stored,
    append: vi.fn(async (id: string, events: SessionEvent[]) => {
      const log = stored.get(id) ?? []
      for (const event of events) {
        if (event.seq !== log.length) throw new Error('append seq mismatch')
      }
      log.push(...events)
      stored.set(id, log)
    }),
    inspect: vi.fn(async (id: string) => {
      const log = stored.get(id)
      if (log === undefined) throw new Error('session "' + id + '" has no persisted log')
      return { meta: { id }, events: [...log] }
    }),
  }
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
  /** The vi.fn backing the stubbed subagents.startContinuable seam (V3-28). */
  subagentsStartContinuable: ReturnType<typeof vi.fn>
  /** The vi.fn backing the stubbed subagents.sendMessage seam (V3-28 wake-ups). */
  subagentsSendMessage: ReturnType<typeof vi.fn>
  /** The request signals of every worker spawn, in spawn order (taskboard_pause aborts the latest one). */
  workerSignals: AbortSignal[]
  /** The request signals of every reviewer spawn, in spawn order. */
  reviewerSignals: AbortSignal[]
  /** Remove the harness worker child from the live agent registry (simulates the worker session vanishing, e.g. a host restart). */
  unregisterWorker: () => void
  /** Remove the harness reviewer child from the live agent registry (simulates the reviewer session vanishing, e.g. a host restart). */
  unregisterReviewer: () => void
  /** Remove the harness master agent (devA) from the live agent registry (simulates the master session vanishing, e.g. a host restart). */
  unregisterMaster: () => void
  /** Remove the second harness agent (devB) from the live agent registry. */
  unregisterDevB: () => void
}

interface HarnessOptions {
  spawn?: SpawnBehavior
  /** V3-25 master-seat idle-arm timeout passed to the plugin (0 disables the idle arm). */
  masterIdleTimeoutMs?: number
  /** Pre-seeded storage root; a fresh temp root when omitted. */
  root?: string
  /** When set, worker spawns return a run carrying this result promise. */
  workerRunResult?: Promise<RunResultStub>
  /**
   * Per-spawn worker run results, consumed in order; a trailing undefined
   * keeps that worker alive (no settlement). Falls back to workerRunResult.
   */
  workerRunResults?: Array<Promise<RunResultStub> | undefined>
  /** Per-spawn worker session ids, consumed in order; falls back to the default id. */
  workerSpawnIds?: string[]
  /** When set, reviewer spawns return a run carrying this result promise. */
  reviewerRunResult?: Promise<RunResultStub>
  /** The review protocol; defaults to "report". */
  reviewMode?: 'report' | 'direct'
  /** When set, a stubbed workspace registry archives session ids through this fn. */
  archive?: ReturnType<typeof vi.fn>
  /** When set, the stubbed workspace registry resolves cwds through this fn. */
  resolveByPath?: (path: string) => Promise<{ id: string; path: string } | undefined>
  /** Advertised provider capabilities the stubbed subagent seam exposes through getProvider. */
  providerCapabilities?: {
    outputSchema: boolean
    depthLimit: boolean
    toolFilter: boolean
    persona: boolean
    agentOptions: boolean
  }
  /** Host workerModel passed to the service (default deepseek-v4-flash). */
  workerModel?: string
  /** Host workerEffort passed to the service (default unset). */
  workerEffort?: string
  /** Host reviewerModel passed to the service (defaults along the workerModel). */
  reviewerModel?: string
  /** Host reviewerEffort passed to the service (defaults along the workerEffort). */
  reviewerEffort?: string
  /** Host masterEffort passed to the service (informational note only). */
  masterEffort?: string
  /** When set, only reviewer-label spawns throw; worker spawns still succeed. */
  failReviewerSpawn?: boolean
  /** Worker-liveness reconciliation interval passed to the plugin (0 disables the periodic scan). */
  reconcileIntervalMs?: number
  /** Master-notice dedupe window passed to the plugin (defaults to 10000). */
  noticeDedupeWindowMs?: number
  /** Idle-staleness timeout passed to the plugin (defaults to 600000). */
  lostWorkerTimeoutMs?: number
  /** Per-card auto-redispatch cap passed to the plugin (defaults to 2). */
  workerAutoRetryLimit?: number
  /** Reviewer-staleness timeout passed to the plugin (defaults to 900000). */
  reviewerStaleTimeoutMs?: number
  /** When set, a fake session-persistence seam (append/inspect) is provided to the service. */
  sessionPersistence?: ReturnType<typeof fakeSessionPersistence>
  /**
   * V3-28: when true the stubbed subagent seam exposes the continuable surface
   * (startContinuable + sendMessage) and its provider advertises
   * prepareContinuable, so dispatch/serve go through the durable child path.
   */
  continuable?: boolean
  /**
   * When false the stubbed provider advertises no prepareContinuable even with
   * `continuable` (capability downgrade); defaults to `continuable`.
   */
  providerSupportsContinuable?: boolean
  /** When set, the stubbed continuable sendMessage rejects with this message (a refused wake). */
  sendMessageError?: string
}

/** Compose the real storage chain plus the taskboard service with stubs. */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { spawn = 'spawn' } = options
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
  const workerIds = options.workerSpawnIds ?? ['worker-child-agent']
  let workerSpawnCount = 0
  let continuableSpawnCount = 0
  const workerSignals: AbortSignal[] = []
  const reviewerSignals: AbortSignal[] = []
  // V3-28 continuable surface: startContinuable resolves a durable child id
  // (never a run handle — structured output and run.result are one-shot-only)
  // and sendMessage is the wake channel the recovery uses.
  const continuableProvider = options.providerSupportsContinuable ?? options.continuable === true
  const subagentsStartContinuable = vi.fn(async (spec: { provider: string; label: string }) => {
    if (options.failReviewerSpawn === true && spec.label.startsWith('review ')) {
      throw new Error('reviewer spawn exploded')
    }
    if (spec.label.startsWith('review ')) return { childId: spawnedReviewerId, messageId: 'continuable-reviewer' }
    const id = workerIds[Math.min(continuableSpawnCount, workerIds.length - 1)]!
    continuableSpawnCount += 1
    return { childId: id, messageId: `continuable-worker-${continuableSpawnCount}` }
  })
  const subagentsSendMessage = vi.fn(async (_sender: Agent, target: string) => {
    if (options.sendMessageError !== undefined) throw new Error(options.sendMessageError)
    // Faithful to the seam: a provider that mints no continuable descriptor
    // leaves a child with no continuation state, and a cold resume of such a
    // child is refused exactly this way.
    if (!continuableProvider) {
      throw new Error('subagent "' + target + '" has no supported continuation state and cannot be resumed')
    }
    return 'wake-message-1'
  })
  let subagentsStart: ReturnType<typeof vi.fn>
  if (spawn === 'spawn') {
    subagentsStart = vi.fn(async (_provider: string, request: SubagentStartRequest) => {
      if (options.failReviewerSpawn === true && request.label?.startsWith('review ')) {
        throw new Error('reviewer spawn exploded')
      }
      if (request.label?.startsWith('review ')) {
        reviewerSignals.push(request.signal)
        const result = options.reviewerRunResult
        return {
          id: spawnedReviewerId,
          ...(result === undefined ? {} : { result }),
        }
      }
      workerSignals.push(request.signal)
      const id = workerIds[Math.min(workerSpawnCount, workerIds.length - 1)]!
      const perSpawn = options.workerRunResults?.[workerSpawnCount]
      workerSpawnCount += 1
      const result = perSpawn === undefined ? options.workerRunResult : perSpawn
      return {
        id,
        ...(result === undefined ? {} : { result }),
      }
    })
    ctx.provide('subagents', {
      start: subagentsStart,
      ...(options.continuable === true ? {
        startContinuable: subagentsStartContinuable,
        sendMessage: subagentsSendMessage,
      } : {}),
      ...(options.providerCapabilities === undefined && options.continuable !== true ? {} : {
        getProvider: () => ({
          name: 'spawn',
          capabilities: options.providerCapabilities,
          ...(continuableProvider ? { prepareContinuable: () => undefined } : {}),
        }),
      }),
    } as never)
  } else if (spawn === 'fail') {
    subagentsStart = vi.fn(async () => {
      throw new Error('spawn exploded')
    })
    ctx.provide('subagents', {
      start: subagentsStart,
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
  if (options.sessionPersistence !== undefined) {
    ctx.provide('sessionPersistence', options.sessionPersistence as never)
  }
  // The periodic worker-liveness scanner stays off by default in tests: the
  // startup pass still runs (harmless on a fresh board), and the scan itself
  // is exercised explicitly or with a short explicit interval.
  await ctx.plugin(TaskboardService, {
    ...(options.masterIdleTimeoutMs === undefined ? {} : { masterIdleTimeoutMs: options.masterIdleTimeoutMs }),
    ...(options.reviewMode === undefined ? {} : { reviewMode: options.reviewMode }),
    ...(options.workerModel === undefined ? {} : { workerModel: options.workerModel }),
    ...(options.workerEffort === undefined ? {} : { workerEffort: options.workerEffort }),
    ...(options.reviewerModel === undefined ? {} : { reviewerModel: options.reviewerModel }),
    ...(options.reviewerEffort === undefined ? {} : { reviewerEffort: options.reviewerEffort }),
    ...(options.masterEffort === undefined ? {} : { masterEffort: options.masterEffort }),
    ...(options.reconcileIntervalMs === undefined ? { reconcileIntervalMs: 0 } : { reconcileIntervalMs: options.reconcileIntervalMs }),
    ...(options.noticeDedupeWindowMs === undefined ? {} : { noticeDedupeWindowMs: options.noticeDedupeWindowMs }),
    ...(options.lostWorkerTimeoutMs === undefined ? {} : { lostWorkerTimeoutMs: options.lostWorkerTimeoutMs }),
    ...(options.workerAutoRetryLimit === undefined ? {} : { workerAutoRetryLimit: options.workerAutoRetryLimit }),
    ...(options.reviewerStaleTimeoutMs === undefined ? {} : { reviewerStaleTimeoutMs: options.reviewerStaleTimeoutMs }),
  })
  const service = ctx.taskboard
  const changes: TaskboardChanged[] = []
  ctx.on('taskboard/changed', change => changes.push(change))
  const devA = stubAgent('dev-agent-a')
  const devB = stubAgent('dev-agent-b')
  const reviewerChild = stubAgent(spawnedReviewerId)
  const workerChild = stubAgent(spawnedWorkerId)
  const unregisterMaster = ctx.agents.register(devA)
  const unregisterDevB = ctx.agents.register(devB)
  const unregisterReviewer = ctx.agents.register(reviewerChild)
  const unregisterWorker = ctx.agents.register(workerChild)
  // Register every configured worker spawn id as a live stub agent so an
  // auto-redispatched worker (which the real seam would register) is live.
  for (const id of (options.workerSpawnIds ?? [])) {
    if (id !== spawnedWorkerId) ctx.agents.register(stubAgent(id))
  }
  return {
    ctx, service, root, changes, devA, devB, reviewerChild, workerChild,
    spawnedReviewerId, spawnedWorkerId, subagentsStart, subagentsStartContinuable, subagentsSendMessage,
    workerSignals, reviewerSignals,
    unregisterWorker, unregisterReviewer, unregisterMaster, unregisterDevB,
  }
}

/** Temp storage roots created by the harnesses, cleaned between cases. */
const openRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(openRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A throwaway unowned agent for ticket creation that does not care about the caller. */
const helperAgent = stubAgent('ticket-helper-agent')

async function createTicket(
  service: TaskboardService,
  title: string,
  dependsOn: string[] = [],
  boardId = 'default',
  agent: Agent = helperAgent,
): Promise<TicketView> {
  return await service.createRemote(agent, { title, description: 'describe ' + title, priority: 'normal', dependsOn, boardId })
}

async function toNotStarted(service: TaskboardService, agent: Agent, ticket: TicketView): Promise<TicketView> {
  return await service.moveRemote(agent, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
}

/**
 * Schedule a card into Not started as the board master (the taskboard_move
 * origin). Unlike the user drag (toNotStarted), a master-origin move never
 * emits the user-scheduled master notice, so worker/report/reconcile tests
 * can set up a Not started card without an extra notice polluting their
 * followup/notice-count assertions.
 */
async function scheduleToNotStarted(service: TaskboardService, agent: Agent, ticket: TicketView): Promise<TicketView> {
  return await service.moveAsMaster(agent, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
}

async function claimTicket(service: TaskboardService, agent: Agent, ticket: TicketView): Promise<TicketView> {
  return await service.claim(agent, ticket.id)
}

/** Extract the text of one injected notice message. */
function textOf(message: { content: { type: string; text: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
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

  it('accepts requestReview without a boardId for a ticket on a non-default board', async () => {
    const { service } = await harness()
    // A ticket living on its own board (not the legacy default) with a real
    // reviewer backend available; the caller omits boardId like the v1 UI.
    const onAlpha = await createTicket(service, 'alpha review card', [], 'alpha')
    const moved = await service.moveRemote(devAgent(onAlpha), {
      ticketId: onAlpha.id, column: 'in_testing', beforeTicketId: null, afterTicketId: null,
    })
    expect(moved.boardId).toBe('alpha')
    expect(moved.reviewer?.agentId).toBe('reviewer-child-agent')
    const reviewed = await service.requestReviewRemote(devAgent(onAlpha), { ticketId: onAlpha.id })
    expect(reviewed.boardId).toBe('alpha')
    expect(reviewed.reviewer?.agentId).toBe('reviewer-child-agent')
    // An explicit wrong board is still rejected: the fallback never forgives
    // a caller that names a different board than the ticket lives on.
    await expect(service.requestReviewRemote(devAgent(onAlpha), { ticketId: onAlpha.id, boardId: 'default' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_INVALID_INPUT' })
  })

  it('lists, creates and archives boards through the Remote surface', async () => {
    const { service, devA } = await harness()
    // First access materializes the session-private default board and the legacy default.
    const boards = await service.listBoards(devA)
    expect(boards).toHaveLength(2)
    expect(boards.find(board => board.boardId === 'default')).toMatchObject({ boardId: 'default', workspaceId: '' })
    expect(boards.find(board => board.scope === 'session')).toMatchObject({
      boardId: 'session-' + devA.id,
      scope: 'session',
      ownerSessionId: devA.id,
    })
    const created = await service.createBoardRemote(devA, { name: 'Sprint 42', workspaceId: 'ws-1' })
    expect(created.boardId).toMatch(/^board-/)
    expect(created.name).toBe('Sprint 42')
    // An unowned caller's new board defaults to session scope: it carries no
    // workspace and is owned by the creating session.
    expect(created.workspaceId).toBe('')
    expect(created.scope).toBe('session')
    expect(created.ownerSessionId).toBe(devA.id)
    expect(created.masterAgentId).toBeNull()
    const listed = await service.listBoards(devA)
    expect(listed.map(board => board.boardId).sort())
      .toEqual([created.boardId, 'session-' + devA.id, 'default'].sort())
    const archived = await service.archiveBoardRemote(devA, { boardId: created.boardId })
    expect(archived.archivedAt).not.toBeNull()
    await expect(service.archiveBoardRemote(devA, { boardId: 'no-such-board' })).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('claims, holds and releases the master seat with no clock lease (V3-25)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { service, devA, devB } = await harness()
      const claimed = await service.claimMaster('default', devA)
      expect(claimed.masterAgentId).toBe(devA.id)
      expect(claimed.masterClaimedAt).not.toBeNull()
      // The retired lease field never carries a deadline any more.
      expect(claimed.masterExpiresAt).toBeNull()
      // A second agent cannot steal a live seat, and no amount of elapsed time
      // changes that: there is no lease left to expire.
      await expect(service.claimMaster('default', devB)).rejects.toMatchObject({ code: 'TASKBOARD_MASTER_HELD' })
      vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
      await expect(service.claimMaster('default', devB)).rejects.toMatchObject({ code: 'TASKBOARD_MASTER_HELD' })
      // Only the current master may release.
      await expect(service.releaseMaster('default', devB)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
      const released = await service.releaseMaster('default', devA)
      expect(released.masterAgentId).toBeNull()
      expect(released.masterClaimedAt).toBeNull()
      expect(released.masterExpiresAt).toBeNull()
      // After release the next agent claims cleanly.
      const again = await service.claimMaster('default', devB)
      expect(again.masterAgentId).toBe(devB.id)
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

  it('assign dispatches a Backlog card directly without moving it (V3-6); other columns still reject', async () => {
    const { service, devA, workerChild } = await harness()
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    // A fresh Backlog card: dispatch straight from Backlog, no move first.
    const ticket = await createTicket(service, 'backlog dispatch')
    const result = await service.assign(devA, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(result.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.column).toBe('in_progress')
    expect(result.ticket.status).toBe('running')
    expect(result.ticket.assignee?.agentId).toBe(devA.id)
    expect(result.ticket.workerAgentId).toBe('worker-child-agent')
    // The assign transition records an 'assign' history row like any assign.
    expect(result.ticket.history.at(-1)).toMatchObject({ kind: 'assign' })
    // Direct-from-Backlog dispatch never emits the user-scheduled notice:
    // the card goes straight to In progress, not through the Not started wake-up.
    expect(followup).not.toHaveBeenCalled()
    // The worker flow completes end to end from the Backlog origin.
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    expect(reported.ticket.column).toBe('in_testing')
    // Assign from In progress / In testing / Done still rejects.
    await expect(service.assign(devA, ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_TRANSITION' })
    await expect(service.assign(devA, reported.ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_TRANSITION' })
    // A card already Done also rejects (assign requires Not started or Backlog).
    const doneCard = await service.moveRemote(devA, { ticketId: reported.ticket.id, column: 'done', beforeTicketId: null, afterTicketId: null })
    await expect(service.assign(devA, doneCard.id)).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_TRANSITION' })
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

  it('requires the master seat for assign, reassign and claim (V3-7)', async () => {
    const { service, devA, devB } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'guarded card')
    await toNotStarted(service, devA, ticket)
    await expect(service.assign(devB, ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    await expect(service.reassign(devB, ticket.id, 'backlog')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    // The free claim is closed (V3-7): a non-master may not claim either,
    // even though the ticket is ready and unowned.
    await expect(service.claim(devB, ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    // The master still claims directly.
    const claimed = await service.claim(devA, ticket.id)
    expect(claimed.column).toBe('in_progress')
    expect(claimed.assignee?.agentId).toBe(devA.id)
    // After a claim the non-master is still rejected at the master gate.
    await expect(service.claim(devB, claimed.id)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
  })

  it('taskboard_pause aborts the in-flight worker run, marks the card paused and notifies the master', async () => {
    const { service, devA, devB, workerSignals } = await harness()
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    const ticket = await createTicket(service, 'pause me')
    await scheduleToNotStarted(service, devA, ticket)
    const assigned = await service.assign(devA, ticket.id)
    expect(assigned.ticket.status).toBe('running')
    expect(workerSignals).toHaveLength(1)
    // The master pauses the card: the recorded run handle aborts the worker.
    const paused = await service.pause(devA, ticket.id, 'user asked to stop the run')
    expect(paused.status).toBe('paused')
    expect(paused.column).toBe('in_progress')
    expect(paused.failure).toBeNull()
    expect(workerSignals[0]!.aborted).toBe(true)
    // History names the pauser and the reason.
    const pauseRow = paused.history.at(-1)
    expect(pauseRow?.kind).toBe('pause')
    expect(pauseRow?.detail).toContain('paused by')
    expect(pauseRow?.detail).toContain('dev-agen')
    expect(pauseRow?.detail).toContain('user asked to stop the run')
    // The master is notified with the worker-paused notice kind.
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
    expect(message.source.kind).toBe('taskboard')
    expect(textOf(message)).toContain(ticket.id)
    expect(textOf(message)).toContain('taskboard_reassign')
    const snapshot = await service.snapshot(devA)
    const notice = snapshot.notices?.at(-1)
    expect(notice).toMatchObject({ kind: 'worker-paused', ticketId: ticket.id })
    // A second pause is rejected: the card is no longer running.
    await expect(service.pause(devA, ticket.id, 'again')).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_TRANSITION' })
    // A non-master cannot pause.
    await expect(service.pause(devB, ticket.id, 'not my board')).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
  })

  it('paused cards are never mislabeled blocked: aborted settlement and liveness reconciliation both skip them', async () => {
    let settle!: (result: RunResultStub) => void
    const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
    const { service, devA, workerSignals, unregisterWorker } = await harness({ workerRunResults: [runResult] })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'paused survivor')
    await scheduleToNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    // Pause first, then let the aborted run settle with a non-report reason:
    // the settlement callback must see status paused and skip reclamation.
    const paused = await service.pause(devA, ticket.id, 'stop the world')
    expect(paused.status).toBe('paused')
    expect(workerSignals[0]!.aborted).toBe(true)
    settle({ output: [], stopReason: 'aborted' })
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ticket.id)
      expect(current.status).toBe('paused')
      expect(current.failure).toBeNull()
      expect(current.autoRetries).toBe(0)
    })
    // The liveness reconciliation also skips paused cards: even with the
    // worker absent from the registry, nothing is recovered or blocked.
    unregisterWorker()
    const recovered = await service.reconcileLostWorkers()
    expect(recovered).toBe(0)
    const current = await service.viewTicket(ticket.id)
    expect(current.status).toBe('paused')
    expect(current.failure).toBeNull()
  })

  it('reassign retry resumes a paused card with a fresh worker; backlog returns it to Not started', async () => {
    const { service, devA, workerSignals, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'paused then resumed')
    await scheduleToNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    await service.pause(devA, ticket.id, 'hold on')
    // Backlog still works on a paused card: it returns to Not started ready.
    const backlogged = await service.reassign(devA, ticket.id, 'backlog')
    expect(backlogged.ticket.column).toBe('not_started')
    expect(backlogged.ticket.status).toBe('ready')
    // Re-dispatch, pause again, then retry: a fresh worker spawns and the
    // paused status is cleared with a resume-annotated history row.
    await scheduleToNotStarted(service, devA, backlogged.ticket)
    await service.assign(devA, backlogged.ticket.id)
    expect(workerSignals).toHaveLength(2)
    const paused = await service.pause(devA, ticket.id, 'wait for review')
    expect(paused.status).toBe('paused')
    const retried = await service.reassign(devA, ticket.id, 'retry')
    expect(retried.worker).toBe('spawned')
    expect(retried.ticket.status).toBe('running')
    expect(retried.ticket.failure).toBeNull()
    expect(retried.ticket.workerSessionId).toBe('worker-child-agent')
    expect(workerSignals).toHaveLength(3)
    const resumeRow = retried.ticket.history.at(-1)
    expect(resumeRow?.kind).toBe('reassign')
    expect(resumeRow?.detail).toContain('resumed from pause')
    expect(subagentsStart.mock.calls.length).toBe(3)
  })

  it('pause rejects cards that are not In progress running (edge paths)', async () => {
    const { service, devA } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'not running card')
    await expect(service.pause(devA, ticket.id, 'backlog card')).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_TRANSITION' })
    await toNotStarted(service, devA, ticket)
    // A Not started card is not In progress.
    await expect(service.pause(devA, ticket.id, 'not started card')).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_TRANSITION' })
    await expect(service.pause(devA, ticket.id, '')).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_INPUT' })
    await expect(service.pause(devA, 'ticket-missing', 'gone')).rejects.toMatchObject({ code: 'TASKBOARD_TICKET_NOT_FOUND' })
  })

  it('auto-redispatches a card whose worker run settles without reporting', async () => {
    let settle!: (result: RunResultStub) => void
    const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
    const { service, devA } = await harness({ workerRunResults: [runResult] })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'vanishing worker')
    await toNotStarted(service, devA, ticket)
    const assigned = await service.assign(devA, ticket.id)
    expect(assigned.ticket.status).toBe('running')
    settle({ output: [], stopReason: 'error' })
    // Mid-flight death: the settlement callback auto-redispatches a fresh
    // worker (budget 1 of 2) and the card stays running.
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ticket.id)
      expect(current.status).toBe('running')
      expect(current.autoRetries).toBe(1)
      expect(current.failure).toBeNull()
    })
    const current = await service.viewTicket(ticket.id)
    expect(current.description).toContain('续做勿回滚')
    expect(current.history.some(row => row.kind === 'reassign' && row.detail.includes('auto-redispatched'))).toBe(true)
  })

  it('auto-redispatches a card when the worker run infrastructure rejects', async () => {
    const runResult = Promise.reject(new Error('transport broke'))
    void runResult.catch(() => {})
    const { service, devA } = await harness({ workerRunResults: [runResult] })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'crashing worker')
    await toNotStarted(service, devA, ticket)
    const assigned = await service.assign(devA, ticket.id)
    expect(assigned.ticket.status).toBe('running')
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ticket.id)
      expect(current.status).toBe('running')
      expect(current.autoRetries).toBe(1)
    })
  })

  it('reconciles a running card whose worker session is missing from the live registry on startup and notifies the master', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-restart-'))
    const now = Date.now()
    // A durable card from the previous process: In progress/running, its
    // worker session id can never be live in this process (session ids are
    // process-local), and the in-memory run settlement callback is gone.
    const orphan = {
      id: 'ticket-restart-orphan',
      title: 'restart orphan',
      description: 'worker died with the old process',
      column: 'in_progress',
      priority: 'normal',
      boardId: 'default',
      type: 'bugfix',
      status: 'running',
      workerAgentId: 'ghost-worker-session',
      workerSessionId: 'ghost-worker-session',
      failure: null,
      createdAt: now,
      updatedAt: now,
      position: 0,
      assignee: { agentId: 'dev-agent-a', label: 'agent dev-agen' },
      reviewer: null,
      reviewAttempts: 0,
      lastReview: null,
      devNotes: '',
      dependsOn: [],
      history: [],
    }
    const masterBoard = {
      boardId: 'default',
      name: 'default',
      workspaceId: '',
      scope: 'project',
      ownerSessionId: null,
      masterAgentId: 'dev-agent-a',
      masterClaimedAt: now,
      handoverNotes: '',
      masterHistory: [],
      archivedAt: null,
    }
    await writeFile(
      join(root, 'taskboard.json'),
      JSON.stringify({
        unit: { name: 'taskboard', version: 1 },
        global: null,
        tables: {
          tickets: { [orphan.id]: orphan },
          boards: { [masterBoard.boardId]: masterBoard },
        },
      }, null, 2),
    )
    const { service, devA, changes } = await harness({ root })
    const followup = vi.spyOn(devA, 'followup')
    // The startup pass (scheduled once the domain is open) recovers the card:
    // the master session (devA) is live in the registry, so the lost worker
    // is auto-redispatched — the card stays running with a fresh worker and
    // the auto-retry budget incremented, instead of being blocked outright.
    await vi.waitFor(async () => {
      const current = await service.viewTicket(orphan.id)
      expect(current.status).toBe('running')
      expect(current.autoRetries).toBe(1)
      expect(current.failure).toBeNull()
      expect(current.workerSessionId).toBe('worker-child-agent')
    })
    const recovered = await service.viewTicket(orphan.id)
    expect(recovered.history.some(row => row.kind === 'reassign' && row.detail.includes('auto-redispatched'))).toBe(true)
    expect(recovered.description).toContain('续做勿回滚')
    // The master inbox received exactly one notice naming the card.
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
    expect(message.source.kind).toBe('taskboard')
    expect(textOf(message)).toContain(orphan.id)
    expect(textOf(message)).toContain('auto-redispatched')
    // The forwarded change event carries the recovery mutation.
    expect(changes.some(change => change.operation === 'reassign' && change.ticketId === orphan.id)).toBe(true)
  })

  it('blocks a running card on restart when no live master session exists to auto-redispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-restart-nomaster-'))
    const now = Date.now()
    const orphan = {
      id: 'ticket-restart-orphan-no-master',
      title: 'restart orphan no master',
      description: 'worker died with the old process',
      column: 'in_progress',
      priority: 'normal',
      boardId: 'default',
      type: 'bugfix',
      status: 'running',
      workerAgentId: 'ghost-worker-session',
      workerSessionId: 'ghost-worker-session',
      failure: null,
      createdAt: now,
      updatedAt: now,
      position: 0,
      assignee: { agentId: 'dev-agent-a', label: 'agent dev-agen' },
      reviewer: null,
      reviewAttempts: 0,
      lastReview: null,
      devNotes: '',
      dependsOn: [],
      history: [],
    }
    const masterBoard = {
      boardId: 'default',
      name: 'default',
      workspaceId: '',
      scope: 'project',
      ownerSessionId: null,
      masterAgentId: 'dev-agent-a',
      masterClaimedAt: now,
      handoverNotes: '',
      masterHistory: [],
      archivedAt: null,
    }
    await writeFile(
      join(root, 'taskboard.json'),
      JSON.stringify({
        unit: { name: 'taskboard', version: 1 },
        global: null,
        tables: {
          tickets: { [orphan.id]: orphan },
          boards: { [masterBoard.boardId]: masterBoard },
        },
      }, null, 2),
    )
    const { service, unregisterMaster } = await harness({ root })
    // A full restart leaves the master session absent too: auto-redispatch is
    // impossible, so the V3-13 terminal path — blocked + notify — applies.
    unregisterMaster()
    await vi.waitFor(async () => {
      const current = await service.viewTicket(orphan.id)
      expect(current.status).toBe('blocked')
      expect(current.failure?.reason).toContain('restart reconciliation')
    })
    const blocked = await service.viewTicket(orphan.id)
    expect(blocked.history.filter(row => row.kind === 'fail')).toHaveLength(1)
  })

  it('leaves a running card alone while its worker is live and auto-redispatches once the worker leaves the registry', async () => {
    const { service, devA, unregisterWorker } = await harness()
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    const card = await createTicket(service, 'live worker card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    // The spawned worker is a registered live session: the pass touches nothing.
    expect(await service.reconcileLostWorkers()).toBe(0)
    let current = await service.viewTicket(card.id)
    expect(current.status).toBe('running')
    expect(followup).not.toHaveBeenCalled()
    // The worker session vanishes (termination / host restart): the next pass
    // auto-redispatches a fresh worker — the card stays running with the
    // budget incremented and a master notice.
    unregisterWorker()
    expect(await service.reconcileLostWorkers()).toBe(1)
    current = await service.viewTicket(card.id)
    expect(current.status).toBe('running')
    expect(current.autoRetries).toBe(1)
    expect(current.failure).toBeNull()
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
    expect(textOf(message)).toContain(card.id)
    expect(textOf(message)).toContain('auto-redispatched')
    // The replacement worker (same stub id) is not re-registered, so the next
    // loss exhausts the budget and the card finally blocks.
    expect(await service.reconcileLostWorkers()).toBe(1)
    current = await service.viewTicket(card.id)
    expect(current.status).toBe('running')
    expect(current.autoRetries).toBe(2)
    expect(await service.reconcileLostWorkers()).toBe(1)
    current = await service.viewTicket(card.id)
    expect(current.status).toBe('blocked')
    expect(current.failure?.reason).toContain('worker lost after 2 automatic redispatch attempts')
    expect(current.history.filter(row => row.kind === 'fail')).toHaveLength(1)
  })

  it('periodically scans running cards: auto-redispatch until the budget is exhausted, then one block', async () => {
    const { service, devA, unregisterWorker } = await harness({ reconcileIntervalMs: 20 })
    await service.claimMaster('default', devA)
    const card = await createTicket(service, 'periodic scan card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    unregisterWorker()
    // Each tick auto-redispatches (budget 1, then 2), and the third tick
    // blocks the card — the periodic scanner closes the loop end to end.
    await vi.waitFor(async () => {
      const current = await service.viewTicket(card.id)
      expect(current.status).toBe('blocked')
    })
    const blocked = await service.viewTicket(card.id)
    expect(blocked.autoRetries).toBe(2)
    expect(blocked.failure?.reason).toContain('worker lost after 2 automatic redispatch attempts')
    // Let several more interval ticks fire: the scan stays idempotent — one
    // fail row and one notice for the whole lifetime (the redispatch notices
    // dedupe by kind inside their own window).
    await new Promise(resolve => setTimeout(resolve, 80))
    const again = await service.viewTicket(card.id)
    expect(again.status).toBe('blocked')
    expect(again.history.filter(row => row.kind === 'fail')).toHaveLength(1)
    expect(again.failure?.reason).toContain('worker lost after 2 automatic redispatch attempts')
  })
  it('judges a still-registered but idle worker lost and auto-redispatches it', async () => {
    const { ctx, service, devA, unregisterWorker } = await harness({ lostWorkerTimeoutMs: 100 })
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    const card = await createTicket(service, 'idle worker card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    // Replace the registered worker with a stale twin under the same id: the
    // session is present but its activity tail is older than the timeout, so
    // the pass judges it lost on the idle-staleness arm and auto-redispatches.
    unregisterWorker()
    const oldSession = Session.create(SessionId('worker-child-agent'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('worker-child-agent'),
      createdAt: Date.now() - 60_000,
      isSeeded: false,
    })
    const staleWorker = stubAgentForSession(oldSession)
    ctx.agents.register(staleWorker)
    expect(await service.reconcileLostWorkers()).toBe(1)
    const current = await service.viewTicket(card.id)
    expect(current.status).toBe('running')
    expect(current.autoRetries).toBe(1)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(textOf(followup.mock.calls[0]![0] as { content: { type: string; text: string }[] })).toContain('auto-redispatched')
  })

  it('blocks the card once the per-card auto-redispatch budget is exhausted', async () => {
    // Every worker spawn dies immediately, so the settlement callback keeps
    // firing: attempt 1 and 2 auto-redispatch, attempt 3 blocks.
    const failing = Promise.reject(new Error('always dies'))
    void failing.catch(() => {})
    const { service, devA } = await harness({
      workerRunResults: [failing, failing, failing],
      workerSpawnIds: ['worker-child-agent', 'worker-child-2', 'worker-child-3'],
      noticeDedupeWindowMs: 0,
    })
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    const card = await createTicket(service, 'budget card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    await vi.waitFor(async () => {
      const current = await service.viewTicket(card.id)
      expect(current.status).toBe('blocked')
    })
    const blocked = await service.viewTicket(card.id)
    expect(blocked.autoRetries).toBe(2)
    expect(blocked.failure?.reason).toContain('worker lost after 2 automatic redispatch attempts')
    expect(blocked.history.filter(row => row.kind === 'fail')).toHaveLength(1)
    // The master heard about both redispatches and the terminal block.
    expect(followup).toHaveBeenCalledTimes(3)
  })

  it('releases a ghost reviewer seat and auto-redispatches a fresh reviewer', async () => {
    const { service, devA, workerChild, reviewerChild, unregisterReviewer } = await harness()
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    const card = await createTicket(service, 'ghost review card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    await service.report(workerChild, card.id, 'implemented')
    expect((await service.viewTicket(card.id)).reviewer?.agentId).toBe(reviewerChild.id)
    // The reviewer session vanishes: the seat is a ghost and must be released.
    unregisterReviewer()
    expect(await service.reconcileStaleReviewers()).toBe(1)
    const current = await service.viewTicket(card.id)
    // The seat was released (a review-release history row landed) and a fresh
    // reviewer was auto-redispatched through the live master.
    expect(current.history.some(row => row.kind === 'review-release')).toBe(true)
    expect(current.reviewer).not.toBeNull()
    expect(followup).toHaveBeenCalled()
    expect(textOf(followup.mock.calls.at(-1)![0] as { content: { type: string; text: string }[] })).toContain('review seat')
  })

  it('leaves the seat vacant for claim_review when no live master exists to re-review', async () => {
    const { service, devA, workerChild, unregisterReviewer, unregisterMaster } = await harness()
    await service.claimMaster('default', devA)
    const card = await createTicket(service, 'no master re-review card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    await service.report(workerChild, card.id, 'implemented')
    unregisterReviewer()
    unregisterMaster()
    expect(await service.reconcileStaleReviewers()).toBe(1)
    const current = await service.viewTicket(card.id)
    expect(current.reviewer).toBeNull()
    // The seat is vacant: claim_review can take it.
    await service.claimReview(devA, card.id)
    expect((await service.viewTicket(card.id)).reviewer?.agentId).toBe(devA.id)
  })

  it('releases a stale reviewer seat after the staleness timeout without a verdict', async () => {
    const { ctx, service, devA, workerChild, unregisterReviewer } = await harness({ reviewerStaleTimeoutMs: 50 })
    await service.claimMaster('default', devA)
    const card = await createTicket(service, 'stale review card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    await service.report(workerChild, card.id, 'implemented')
    // The reviewer is registered but idle with an old activity tail and no
    // reviewOutcome: past the timeout the seat is released (and a fresh
    // reviewer is auto-redispatched through the live master).
    unregisterReviewer()
    const oldSession = Session.create(SessionId('reviewer-child-agent'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('reviewer-child-agent'),
      createdAt: Date.now() - 60_000,
      isSeeded: false,
    })
    const staleReviewer = stubAgentForSession(oldSession)
    ctx.agents.register(staleReviewer)
    expect(await service.reconcileStaleReviewers()).toBe(1)
    const released = await service.viewTicket(card.id)
    expect(released.history.some(row => row.kind === 'review-release')).toBe(true)
    // The fresh reviewer (same stub id) is re-attached by the auto-redispatch.
    expect(released.reviewer).not.toBeNull()
  })

  it('reconciles In testing ghost seats on restart alongside running workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-restart-review-'))
    const now = Date.now()
    const ghostReview = {
      id: 'ticket-restart-review',
      title: 'ghost review after restart',
      description: 'reviewer died with the old process',
      column: 'in_testing',
      priority: 'normal',
      boardId: 'default',
      type: 'feature',
      status: 'claimed',
      failure: null,
      autoRetries: 0,
      createdAt: now,
      updatedAt: now,
      position: 0,
      assignee: { agentId: 'dev-agent-a', label: 'agent dev-agen' },
      reviewer: { agentId: 'ghost-reviewer-session', label: 'reviewer ghost' },
      reviewAttempts: 0,
      lastReview: null,
      reviewOutcome: null,
      devNotes: 'implemented',
      dependsOn: [],
      history: [],
    }
    const masterBoard = {
      boardId: 'default',
      name: 'default',
      workspaceId: '',
      scope: 'project',
      ownerSessionId: null,
      masterAgentId: 'dev-agent-a',
      masterClaimedAt: now,
      handoverNotes: '',
      masterHistory: [],
      archivedAt: null,
    }
    await writeFile(
      join(root, 'taskboard.json'),
      JSON.stringify({
        unit: { name: 'taskboard', version: 1 },
        global: null,
        tables: {
          tickets: { [ghostReview.id]: ghostReview },
          boards: { [masterBoard.boardId]: masterBoard },
        },
      }, null, 2),
    )
    const { service } = await harness({ root })
    // The startup pass releases the ghost review seat (no live reviewer) and
    // re-review is attempted through the live master.
    await vi.waitFor(async () => {
      const current = await service.viewTicket(ghostReview.id)
      expect(current.history.some(row => row.kind === 'review-release')).toBe(true)
    })
    const current = await service.viewTicket(ghostReview.id)
    expect(current.reviewer).not.toBeNull()
  })

  it('recoveries are reentry-safe: concurrent passes recover each card exactly once', async () => {
    const { service, devA, unregisterWorker } = await harness({
      workerSpawnIds: ['worker-child-agent', 'worker-child-reentry'],
    })
    await service.claimMaster('default', devA)
    const card = await createTicket(service, 'reentry card')
    await scheduleToNotStarted(service, devA, card)
    await service.assign(devA, card.id)
    unregisterWorker()
    // Two overlapping passes (startup scan racing a periodic tick) both see
    // the loss; the guarded recovery lets exactly one land and the second
    // pass sees the card already running with a live replacement.
    const [first, second] = await Promise.all([
      service.reconcileLostWorkers(),
      service.reconcileLostWorkers(),
    ])
    expect(first + second).toBe(1)
    const current = await service.viewTicket(card.id)
    expect(current.autoRetries).toBe(1)
    expect(current.history.filter(row => row.kind === 'reassign')).toHaveLength(1)
  })

  it('coexists with the settlement reclamation: one recovery wins, one redispatch per card', async () => {
    // Order A: the settlement callback wins; the reconciliation then skips.
    let settleA!: (result: RunResultStub) => void
    const runA = new Promise<RunResultStub>((resolve) => { settleA = resolve })
    const { service, devA, unregisterWorker } = await harness({
      workerRunResults: [runA],
      workerSpawnIds: ['worker-child-agent', 'worker-child-a'],
    })
    await service.claimMaster('default', devA)
    const followup = vi.spyOn(devA, 'followup')
    const cardA = await createTicket(service, 'dual path A')
    await scheduleToNotStarted(service, devA, cardA)
    await service.assign(devA, cardA.id)
    unregisterWorker()
    settleA({ output: [], stopReason: 'cancelled' })
    await vi.waitFor(async () => {
      const current = await service.viewTicket(cardA.id)
      expect(current.status).toBe('running')
      expect(current.autoRetries).toBe(1)
    })
    // The reconciliation sees the card already recovered: nothing to do.
    expect(await service.reconcileLostWorkers()).toBe(0)
    const recoveredA = await service.viewTicket(cardA.id)
    expect(recoveredA.history.filter(row => row.kind === 'reassign')).toHaveLength(1)
    expect(followup).toHaveBeenCalledTimes(1)

    // Order B: the reconciliation wins; the stale settlement callback skips.
    let settleB!: (result: RunResultStub) => void
    const runB = new Promise<RunResultStub>((resolve) => { settleB = resolve })
    const { service: serviceB, devA: devAB, unregisterWorker: unregisterB } = await harness({
      workerRunResults: [runB],
      workerSpawnIds: ['worker-child-agent', 'worker-child-b'],
    })
    await serviceB.claimMaster('default', devAB)
    const cardB = await createTicket(serviceB, 'dual path B')
    await scheduleToNotStarted(serviceB, devAB, cardB)
    await serviceB.assign(devAB, cardB.id)
    // The spawned worker session vanishes; the reconciliation wins and
    // auto-redispatches (the replacement 'worker-child-b' is registered).
    unregisterB()
    expect(await serviceB.reconcileLostWorkers()).toBe(1)
    const recoveredB = await serviceB.viewTicket(cardB.id)
    expect(recoveredB.status).toBe('running')
    expect(recoveredB.autoRetries).toBe(1)
    expect(recoveredB.workerSessionId).toBe('worker-child-b')
    // The stale settlement callback for the dead session must not
    // double-recover: the card now names the replacement worker.
    settleB({ output: [], stopReason: 'error' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const againB = await serviceB.viewTicket(cardB.id)
    expect(againB.history.filter(row => row.kind === 'reassign')).toHaveLength(1)
    expect(againB.autoRetries).toBe(1)
    expect(againB.workerSessionId).toBe('worker-child-b')
  })

  it('emits a forwarded change per mutation and a tombstone on removal', async () => {
    const { service, devA, changes } = await harness()
    const ticket = await createTicket(service, 'to remove')
    expect(changes.at(-1)).toMatchObject({ operation: 'create', ticketId: ticket.id, boardId: 'default' })
    const result = await service.removeRemote(devA, { ticketId: ticket.id })
    expect(result.removedId).toBe(ticket.id)
    expect(changes.at(-1)).toEqual({ operation: 'remove', ticketId: ticket.id, boardId: 'default', ticket: null })
    await expect(service.removeRemote(devA, { ticketId: ticket.id })).rejects.toMatchObject({ code: 'TASKBOARD_TICKET_NOT_FOUND' })
  })

  it('claims a Not started ticket as the master and enforces ownership (V3-7)', async () => {
    const { service, devA, devB } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'parallel one')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    expect(claimed.column).toBe('in_progress')
    expect(claimed.assignee?.agentId).toBe(devA.id)
    expect(claimed.status).toBe('claimed')
    // A non-master cannot claim at all (claim is master-only since V3-7).
    await expect(claimTicket(service, devB, claimed)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
    // The master cannot re-claim an already-owned ticket.
    await expect(claimTicket(service, devA, claimed)).rejects.toMatchObject({ code: 'TASKBOARD_ALREADY_CLAIMED' })
    // No in-progress capacity gate (V3-30): with four cards already In
    // progress, a fifth claim succeeds instead of being rejected.
    const second = await createTicket(service, 'parallel two')
    await toNotStarted(service, devA, second)
    await claimTicket(service, devA, second)
    const third = await createTicket(service, 'parallel three')
    await toNotStarted(service, devA, third)
    await claimTicket(service, devA, third)
    const fourth = await createTicket(service, 'parallel four')
    await toNotStarted(service, devA, fourth)
    await claimTicket(service, devA, fourth)
    const fifth = await createTicket(service, 'parallel five')
    await toNotStarted(service, devA, fifth)
    const fifthClaimed = await claimTicket(service, devA, fifth)
    expect(fifthClaimed.column).toBe('in_progress')
    const inProgress = (await service.snapshot(devA)).tickets.filter(ticket => ticket.column === 'in_progress')
    expect(inProgress).toHaveLength(5)
  })

  it('gates claims on dependency order', async () => {
    const { service, devA, reviewerChild } = await harness()
    await service.claimMaster('default', devA)
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
    await service.claimMaster('default', devA)
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
    await service.claimMaster('default', devA)
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
    await service.claimMaster('default', devA)
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
    await service.claimMaster('default', devA)
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
    const { service, devA } = await harness()
    const a = await createTicket(service, 'node a')
    const b = await createTicket(service, 'node b')
    // Duplicate entries are invalid input.
    await expect(createTicket(service, 'dup', [a.id, a.id])).rejects.toMatchObject({ code: 'TASKBOARD_INVALID_INPUT' })
    // A depends on B; editing B to depend on A closes the cycle.
    await service.editRemote(devA, { ticketId: a.id, title: 'node a', description: '', priority: 'normal', dependsOn: [b.id] })
    await expect(service.editRemote(devA, { ticketId: b.id, title: 'node b', description: '', priority: 'normal', dependsOn: [a.id] }))
      .rejects.toMatchObject({ code: 'TASKBOARD_DEPENDENCY_CYCLE' })
    await expect(service.editRemote(devA, { ticketId: b.id, title: 'node b', description: '', priority: 'normal', dependsOn: ['missing-ticket'] }))
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
    const { service, devA, workerChild, unregisterWorker } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'rework me')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    unregisterWorker()
    const result = await service.resolveReview(devA, reported.ticket.id, 'reject', 'reviewed the change', [
      'missing error handling in parse()',
      'tests do not cover the edge case',
    ])
    expect(result.action).toBe('rejected')
    // A vanished worker session cannot receive a live-agent followup.
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

  it('follows up the original worker through its live Agent handle', async () => {
    const { service, devA, workerChild } = await harness()
    const followup = vi.spyOn(workerChild, 'followup')
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'rework window')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const reported = await service.report(workerChild, ticket.id, 'implemented')
    const result = await service.resolveReview(devA, reported.ticket.id, 'reject', 'reviewed', ['fix the parse() path'])
    expect(result.followup).toBe('sent')
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]![0]
    expect(message.source).toMatchObject({ kind: 'taskboard', form: 'relay', senderSessionId: devA.id })
    const text = message.content[0]!.type === 'text' ? message.content[0]!.text : ''
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
    await service.editRemote(devA, { ticketId: merge.id, title: 'merge the branch', description: '', priority: 'normal', dependsOn: [], targetBranch: 'main' })
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
    // First access auto-creates the session-private default board plus a
    // per-workspace default board named after the directory basename.
    const boardsA = await service.listBoards(agentA)
    expect(boardsA).toHaveLength(2)
    expect(boardsA.map(board => board.scope).sort()).toEqual(['project', 'session'])
    expect(boardsA.find(board => board.scope === 'project')).toMatchObject({ boardId: 'default', workspaceId: 'ws-alpha', name: 'project-alpha' })
    expect(boardsA.find(board => board.scope === 'session')).toMatchObject({ scope: 'session', ownerSessionId: agentA.id, name: 'project-alpha' })
    const boardsB = await service.listBoards(agentB)
    expect(boardsB).toHaveLength(2)
    const projectB = boardsB.find(board => board.scope === 'project')!
    expect(projectB).toMatchObject({ workspaceId: 'ws-beta', name: 'project-beta' })
    expect(projectB.boardId).not.toBe('default')
    // Tickets created on a workspace's project board stay invisible to the other workspace.
    const projectA = boardsA.find(board => board.scope === 'project')!
    const ticketA = await service.createRemote(agentA, { title: 'alpha card', description: '', priority: 'normal', dependsOn: [], boardId: projectA.boardId })
    const ticketB = await service.createRemote(agentB, { title: 'beta card', description: '', priority: 'normal', dependsOn: [], boardId: projectB.boardId })
    const snapA = await service.snapshot(agentA, projectA.boardId)
    expect(snapA.tickets.map(ticket => ticket.id)).toEqual([ticketA.id])
    const snapB = await service.snapshot(agentB, projectB.boardId)
    expect(snapB.tickets.map(ticket => ticket.id)).toEqual([ticketB.id])
    // Cross-workspace boards are denied as not found and never listed.
    await expect(service.snapshot(agentA, projectB.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.snapshot(agentB, projectA.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    expect((await service.listBoards(agentA)).map(board => board.boardId)).not.toContain(projectB.boardId)
    expect((await service.listBoards(agentB)).map(board => board.boardId)).not.toContain(projectA.boardId)
    // A project-scoped createBoard stamps the caller's workspace over any requested value.
    const createdA = await service.createBoardRemote(agentA, { name: 'Sprint A', workspaceId: 'ws-beta', scope: 'project' })
    expect(createdA.workspaceId).toBe('ws-alpha')
    expect(createdA.scope).toBe('project')
    expect(createdA.ownerSessionId).toBeNull()
    expect((await service.listBoards(agentB)).map(board => board.boardId)).not.toContain(createdA.boardId)
    await expect(service.snapshot(agentB, createdA.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // A session-scoped createBoard is private to its creator even within the workspace.
    const privateA = await service.createBoardRemote(agentA, { name: 'Scratch A' })
    expect(privateA.scope).toBe('session')
    expect(privateA.ownerSessionId).toBe(agentA.id)
    expect((await service.listBoards(agentB)).map(board => board.boardId)).not.toContain(privateA.boardId)
    await expect(service.snapshot(agentB, privateA.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
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
    const legacyTicket = await service.createRemote(unowned, { title: 'legacy card', description: '', priority: 'normal', dependsOn: [], boardId: 'default' })
    expect((await service.snapshot(unowned, 'default')).tickets.map(ticket => ticket.id)).toEqual([legacyTicket.id])
    // The first real-workspace access adopts the default board, names it after
    // the directory, and re-scopes it as a project-shared board.
    const owner = stubAgentWithCwd('legacy-owner', cwdA)
    const boards = await service.listBoards(owner)
    expect(boards).toHaveLength(2)
    expect(boards.find(board => board.boardId === 'default')).toMatchObject({
      boardId: 'default', workspaceId: 'ws-legacy', name: 'legacy-project', scope: 'project',
    })
    // The adopted board still serves the legacy tickets.
    expect((await service.snapshot(owner, 'default')).tickets.map(ticket => ticket.id)).toEqual([legacyTicket.id])
    // The unowned session loses the adopted board.
    await expect(service.snapshot(unowned, 'default')).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    expect((await service.listBoards(unowned)).map(board => board.boardId)).not.toContain('default')
    // A second real workspace cannot see the adopted default board either.
    const other = stubAgentWithCwd('legacy-other', cwdB)
    const boardsB = await service.listBoards(other)
    expect(boardsB).toHaveLength(2)
    expect(boardsB.find(board => board.workspaceId === 'ws-other')).toMatchObject({ workspaceId: 'ws-other', name: 'other-project' })
    expect(boardsB.find(board => board.workspaceId === 'ws-other')!.boardId).not.toBe('default')
    await expect(service.snapshot(other, 'default')).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('seeds the materialized default board with the caller workspace on master verbs', async () => {
    const cwdA = 'C:\\work\\seed-project'
    const cwdB = 'C:\\work\\seed-other'
    const wsA = workspaceStub('ws-seed', cwdA)
    const wsB = workspaceStub('ws-other', cwdB)
    const resolveByPath = vi.fn(async (path: string) => path === cwdA ? wsA : path === cwdB ? wsB : undefined)
    // Scenario 1 (the accessibility regression): a workspace session claims
    // the implicit default on a fresh store; the materialized board must carry
    // the caller's workspace so the very next master verb is writable (an
    // unseeded materialization landed as a ''-workspace project board and the
    // follow-up createAsMaster/createRemote were denied as not found).
    {
      const { service } = await harness({ resolveByPath })
      const agent = stubAgentWithCwd('seed-master-a', cwdA)
      const other = stubAgentWithCwd('seed-other-a', cwdB)
      const claimed = await service.claimMaster('default', agent)
      expect(claimed).toMatchObject({
        boardId: 'default', workspaceId: 'ws-seed', scope: 'project', name: 'seed-project',
      })
      expect(claimed.masterAgentId).toBe(agent.id)
      // createAsMaster on the claimed default succeeds immediately.
      const planned = await service.createAsMaster(agent, { title: 'right after claim', description: '', priority: 'normal', dependsOn: [] })
      expect(planned.boardId).toBe('default')
      // createRemote on the claimed default succeeds too.
      const remote = await service.createRemote(agent, { title: 'remote after claim', description: '', priority: 'normal', dependsOn: [], boardId: 'default' })
      expect(remote.boardId).toBe('default')
      expect((await service.snapshot(agent, 'default')).tickets.map(ticket => ticket.id).sort())
        .toEqual([planned.id, remote.id].sort())
      // The seeded record shows up in the board listing.
      expect((await service.listBoards(agent)).find(board => board.boardId === 'default'))
        .toMatchObject({ workspaceId: 'ws-seed', scope: 'project' })
      // Another workspace session cannot reach the seeded default (no leak).
      await expect(service.snapshot(other, 'default')).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
      expect((await service.listBoards(other)).map(board => board.boardId)).not.toContain('default')
    }
    // Scenario 2 (the ensureBoard-related path): a createAsMaster attempt
    // before the seat is claimed must not leave the implicit default bricked
    // as a ''-workspace board; the later claim still materializes seeded.
    {
      const { service } = await harness({ resolveByPath })
      const agent = stubAgentWithCwd('seed-master-b', cwdA)
      await expect(service.createAsMaster(agent, { title: 'no seat yet', description: '', priority: 'normal', dependsOn: [] }))
        .rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })
      const claimed = await service.claimMaster('default', agent)
      expect(claimed).toMatchObject({ boardId: 'default', workspaceId: 'ws-seed', scope: 'project' })
      const planned = await service.createAsMaster(agent, { title: 'after the failed attempt', description: '', priority: 'normal', dependsOn: [] })
      expect(planned.boardId).toBe('default')
    }
  })

  it('falls back to unowned when the session cwd cannot be resolved to a workspace', async () => {
    const resolveByPath = vi.fn(async () => { throw new Error('path does not exist') })
    const { service } = await harness({ resolveByPath })
    const agent = stubAgentWithCwd('unresolved-agent', 'C:\\work\\missing-project')
    // A resolving failure falls back to unowned: the legacy default board remains shared.
    const boards = await service.listBoards(agent)
    expect(boards).toHaveLength(2)
    expect(boards.find(board => board.boardId === 'default')).toMatchObject({ boardId: 'default', workspaceId: '' })
    // createBoard stamps the unowned caller with the empty workspace id and,
    // by default, lands in session scope owned by the caller.
    const created = await service.createBoardRemote(agent, { name: 'Unowned board' })
    expect(created.workspaceId).toBe('')
    expect(created.scope).toBe('session')
    expect(created.ownerSessionId).toBe(agent.id)
    // An explicit project request from an unowned session is coerced back to
    // session scope: it must never mint a workspaceId-'' project board that
    // would be shared with every other unowned session.
    const forced = await service.createBoardRemote(agent, { name: 'Unowned project attempt', scope: 'project' })
    expect(forced.workspaceId).toBe('')
    expect(forced.scope).toBe('session')
    expect(forced.ownerSessionId).toBe(agent.id)
    // Another unowned session cannot see it: the unowned leak is closed —
    // new boards always land in scope/owner instead of being shared everywhere.
    const other = stubAgent('no-cwd-agent')
    expect((await service.listBoards(other)).map(board => board.boardId)).not.toContain(created.boardId)
    expect((await service.listBoards(other)).map(board => board.boardId)).not.toContain(forced.boardId)
    await expect(service.snapshot(other, created.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.snapshot(other, forced.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // The creating session still sees and snapshots its own boards.
    expect((await service.listBoards(agent)).map(board => board.boardId)).toContain(created.boardId)
    expect((await service.listBoards(agent)).map(board => board.boardId)).toContain(forced.boardId)
    await expect(service.snapshot(agent, created.boardId)).resolves.toMatchObject({ boardId: created.boardId })
    await expect(service.snapshot(agent, forced.boardId)).resolves.toMatchObject({ boardId: forced.boardId })
  })

  it('isolates session-private boards across sessions and shares project boards within a workspace', async () => {
    const cwdA = 'C:\\work\\team-project'
    const wsA = workspaceStub('ws-team', cwdA)
    const resolveByPath = vi.fn(async (path: string) => path === cwdA ? wsA : undefined)
    const { service } = await harness({ resolveByPath })
    const first = stubAgentWithCwd('team-session-1', cwdA)
    const second = stubAgentWithCwd('team-session-2', cwdA)
    // First access: each session sees its own private board plus the project board.
    const boardsFirst = await service.listBoards(first)
    const boardsSecond = await service.listBoards(second)
    expect(boardsFirst.map(board => board.scope).sort()).toEqual(['project', 'session'])
    expect(boardsSecond.map(board => board.scope).sort()).toEqual(['project', 'session'])
    const privateFirst = boardsFirst.find(board => board.scope === 'session')!
    expect(privateFirst).toMatchObject({ ownerSessionId: first.id, workspaceId: 'ws-team', name: 'team-project' })
    // The sibling session cannot see the private board (no existence leak).
    expect(boardsSecond.map(board => board.boardId)).not.toContain(privateFirst.boardId)
    await expect(service.snapshot(second, privateFirst.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // The owner session snapshots it fine.
    await expect(service.snapshot(first, privateFirst.boardId)).resolves.toMatchObject({ boardId: privateFirst.boardId })
    // A project board created by one session is shared with the sibling.
    const shared = await service.createBoardRemote(first, { name: 'Shared Sprint', scope: 'project' })
    expect(shared.scope).toBe('project')
    expect(shared.workspaceId).toBe('ws-team')
    expect(shared.ownerSessionId).toBeNull()
    expect((await service.listBoards(second)).map(board => board.boardId)).toContain(shared.boardId)
    await expect(service.snapshot(second, shared.boardId)).resolves.toMatchObject({ boardId: shared.boardId })
    // A session board created by the second session is invisible to the first.
    const privateSecond = await service.createBoardRemote(second, { name: 'My scratchpad' })
    expect(privateSecond.scope).toBe('session')
    expect(privateSecond.ownerSessionId).toBe(second.id)
    expect((await service.listBoards(first)).map(board => board.boardId)).not.toContain(privateSecond.boardId)
    await expect(service.snapshot(first, privateSecond.boardId)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('auto-creates one default private board per session', async () => {
    const { service, devA, devB } = await harness()
    const boardsA = await service.listBoards(devA)
    const sessionA = boardsA.find(board => board.scope === 'session')!
    expect(sessionA.boardId).toBe('session-' + devA.id)
    expect(sessionA.name).toBe('session board')
    expect(sessionA.ownerSessionId).toBe(devA.id)
    expect(sessionA.workspaceId).toBe('')
    // A second session gets its own private default board, never the first's.
    const boardsB = await service.listBoards(devB)
    const sessionB = boardsB.find(board => board.scope === 'session')!
    expect(sessionB.boardId).toBe('session-' + devB.id)
    expect(sessionB.boardId).not.toBe(sessionA.boardId)
    expect(boardsB.map(board => board.boardId)).not.toContain(sessionA.boardId)
    // Re-access is idempotent: exactly one private board per session.
    expect((await service.listBoards(devA)).filter(board => board.scope === 'session')).toHaveLength(1)
    expect((await service.listBoards(devB)).filter(board => board.scope === 'session')).toHaveLength(1)
  })

  it('appends masterHistory on claim and transfer for the hierarchy tree', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { service, devA, devB, unregisterDevB } = await harness()
      const claimed = await service.claimMaster('default', devA)
      expect(claimed.masterHistory).toHaveLength(1)
      expect(claimed.masterHistory![0]).toMatchObject({ fromAgentId: null, toAgentId: devA.id, notes: '' })
      expect(typeof claimed.masterHistory![0]!.at).toBe('number')
      const transferred = await service.transferMaster('default', devA, devB.id, 'handing over the board')
      expect(transferred.masterHistory).toHaveLength(2)
      expect(transferred.masterHistory![1]).toMatchObject({
        fromAgentId: devA.id, toAgentId: devB.id, notes: 'handing over the board',
      })
      // A lost-holder preemption records the displaced master as the source:
      // liveness — not a clock — takes the seat back (V3-25).
      unregisterDevB()
      const preempted = await service.claimMaster('default', devA)
      expect(preempted.masterHistory).toHaveLength(3)
      expect(preempted.masterHistory![2]).toMatchObject({ fromAgentId: devB.id, toAgentId: devA.id })
      expect(preempted.masterHistory![2]!.notes).toContain('lost seat')
      // A same-owner re-claim does not duplicate a history row.
      const again = await service.claimMaster('default', devA)
      expect(again.masterHistory).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects create/edit/move/remove/archive on boards the caller cannot see', async () => {
    const cwdA = 'C:\\work\\guarded-project'
    const wsA = workspaceStub('ws-guarded', cwdA)
    const resolveByPath = vi.fn(async (path: string) => path === cwdA ? wsA : undefined)
    const { service } = await harness({ resolveByPath })
    const owner = stubAgentWithCwd('guard-owner', cwdA)
    const intruder = stubAgentWithCwd('guard-intruder', cwdA)
    const boards = await service.listBoards(owner)
    const privateBoard = boards.find(board => board.scope === 'session')!
    // create: a ticket cannot be created on another session's private board.
    await expect(service.createRemote(intruder, { title: 'sneak', description: '', priority: 'normal', dependsOn: [], boardId: privateBoard.boardId }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // The owner creates a ticket; the intruder cannot move/edit/remove it.
    const ticket = await service.createRemote(owner, { title: 'owned', description: '', priority: 'normal', dependsOn: [], boardId: privateBoard.boardId })
    await expect(service.moveRemote(intruder, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.editRemote(intruder, { ticketId: ticket.id, title: 'owned', description: '', priority: 'normal', dependsOn: [] }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.removeRemote(intruder, { ticketId: ticket.id }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // archive: another session cannot archive a private board.
    await expect(service.archiveBoardRemote(intruder, { boardId: privateBoard.boardId }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // master-seat verbs are equally guarded: the intruder cannot claim, release
    // or transfer the private board's seat (no existence leak).
    await expect(service.claimMaster(privateBoard.boardId, intruder))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.releaseMaster(privateBoard.boardId, intruder))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.transferMaster(privateBoard.boardId, intruder, 'some-other-agent', 'handover'))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    // The owner's own verbs succeed on the private board (with the boardId).
    const moved = await service.moveRemote(owner, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null, boardId: privateBoard.boardId })
    expect(moved.column).toBe('not_started')
    const archived = await service.archiveBoardRemote(owner, { boardId: privateBoard.boardId })
    expect(archived.archivedAt).not.toBeNull()
    // The owner claims and releases the seat on their own private board.
    const claimed = await service.claimMaster(privateBoard.boardId, owner)
    expect(claimed.masterAgentId).toBe(owner.id)
    const released = await service.releaseMaster(privateBoard.boardId, owner)
    expect(released.masterAgentId).toBeNull()
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
    // A v1-shaped board row without the scope/ownerSessionId/masterHistory
    // fields: zod defaults fill them in (scope 'session', null owner, empty
    // history) and the legacy unowned default stays visible to an unowned caller.
    const v1Board = {
      boardId: 'default',
      name: 'default',
      workspaceId: '',
      masterAgentId: null,
      masterClaimedAt: null,
      handoverNotes: '',
      archivedAt: null,
    }
    await writeFile(
      join(root, 'taskboard.json'),
      JSON.stringify({
        unit: { name: 'taskboard', version: 1 },
        global: null,
        tables: {
          tickets: { [v1Ticket.id]: v1Ticket },
          boards: { [v1Board.boardId]: v1Board },
        },
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
    expect(loaded.filesScope).toBe('')
    // The v1 board row loads with the new dual-scope defaults intact.
    const boards = await service.listBoards(devA)
    const loadedBoard = boards.find(board => board.boardId === 'default')!
    expect(loadedBoard).toMatchObject({
      boardId: 'default',
      workspaceId: '',
      scope: 'session',
      ownerSessionId: null,
      masterHistory: [],
    })
    expect(loadedBoard.masterAgentId).toBeNull()
    expect(loadedBoard.archivedAt).toBeNull()
  })

  it('keeps a stray legacy empty-workspace board away from real workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskboard-legacy-orphan-'))
    // A v2-era orphan: workspaceId '' but NOT the legacy default board. It
    // must never surface in a real workspace's listing or snapshot.
    const orphan = {
      boardId: 'orphan-board',
      name: 'orphan',
      workspaceId: '',
      masterAgentId: null,
      masterClaimedAt: null,
      handoverNotes: '',
      archivedAt: null,
    }
    await writeFile(
      join(root, 'taskboard.json'),
      JSON.stringify({
        unit: { name: 'taskboard', version: 1 },
        global: null,
        tables: { boards: { [orphan.boardId]: orphan } },
      }, null, 2),
    )
    const cwd = 'C:\\work\\clean-project'
    const ws = workspaceStub('ws-clean', cwd)
    const resolveByPath = vi.fn(async (path: string) => path === cwd ? ws : undefined)
    const { service } = await harness({ root, resolveByPath })
    // An unowned caller may still see the orphan under the legacy rule.
    const unowned = stubAgent('orphan-unowned')
    expect((await service.listBoards(unowned)).map(board => board.boardId)).toContain('orphan-board')
    // A real workspace session never sees it.
    const workspaceAgent = stubAgentWithCwd('orphan-workspace', cwd)
    const workspaceBoards = await service.listBoards(workspaceAgent)
    expect(workspaceBoards.map(board => board.boardId)).not.toContain('orphan-board')
    await expect(service.snapshot(workspaceAgent, 'orphan-board')).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
    await expect(service.claimMaster('orphan-board', workspaceAgent)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
  })

  it('teaches the shared-workspace branch convention and filesScope in the master prompt', () => {
    expect(MASTER_SECTION).toContain('taskboard/<session-short-id>/<ticket-id>')
    expect(MASTER_SECTION).toContain('git status')
    expect(MASTER_SECTION).toContain('branch --show-current')
    expect(MASTER_SECTION).toContain('filesScope')
    expect(MASTER_SECTION).toContain('taskboard_assign')
    expect(MASTER_SECTION).toContain('taskboard/<session-short-id>/<ticket-id>')
    // The branch helper follows the documented convention.
    expect(branchNameFor('abc12345def', 'ticket-xyz')).toBe('taskboard/abc12345/ticket-xyz')
  })

  it('teaches the master workflow discipline: plan → phase scope → schedule → execute → numbered cards', () => {
    // Requirement planning: every agreed requirement lands in Backlog as a card.
    expect(MASTER_SECTION).toContain('Requirement planning')
    expect(MASTER_SECTION).toContain('Backlog')
    expect(MASTER_SECTION).toContain('taskboard_create')
    // Phase scope: master and user agree what the phase covers and its stopping point.
    expect(MASTER_SECTION).toContain('Phase scope')
    expect(MASTER_SECTION).toContain('stopping point')
    // Phase scheduling (V3-6): assign accepts Backlog and Not started, so the
    // phase's cards can be dispatched straight from Backlog — no move is ever
    // required before dispatch. Not started is the "next queue" display.
    expect(MASTER_SECTION).toContain('Phase scheduling')
    expect(MASTER_SECTION).toContain('taskboard_assign accepts Backlog and Not started')
    expect(MASTER_SECTION).toContain('no move is ever required before dispatch')
    expect(MASTER_SECTION).toContain('taskboard_move')
    expect(MASTER_SECTION).toContain('next queue')
    expect(MASTER_SECTION).toContain('user-scheduled')
    // Execution discipline: dispatch from Backlog or Not started, never the
    // working columns; stop when the phase is done.
    expect(MASTER_SECTION).toContain('Execution discipline')
    expect(MASTER_SECTION).toContain('dispatch from Backlog or Not started')
    expect(MASTER_SECTION).toContain('never touch In progress')
    expect(MASTER_SECTION).toContain('stop and wait')
    // Card numbering: cards carry a number agreed at creation/discussion time.
    expect(MASTER_SECTION).toContain('Card numbering')
    expect(MASTER_SECTION).toContain('V3-1')
    expect(MASTER_SECTION).toContain('every card carries a number')
    // The workflow section no longer tells agents that Backlog → Not started is the
    // user's "start this" drag signal; the master dispatches directly, and the
    // user's drag keeps visual feedback while intent lives in the conversation.
    expect(WORKFLOW_SECTION).not.toContain('Never move cards')
    expect(WORKFLOW_SECTION).toContain('no move is needed before dispatch')
    expect(WORKFLOW_SECTION).toContain('scheduling display for the next queue')
    expect(WORKFLOW_SECTION).toContain('phase scope')
    expect(WORKFLOW_SECTION).toContain('master')
  })

  it('teaches the master to adjudicate user-scheduled Not started cards', () => {
    // The user scheduling a card into Not started wakes the master with a
    // "user-scheduled" notice carrying the card facts and the adjudication rule.
    expect(MASTER_SECTION).toContain('user-scheduled')
    expect(MASTER_SECTION).toContain('Adjudicate whether to start it')
    expect(MASTER_SECTION).toContain('dependsOn')
    expect(MASTER_SECTION).toContain('filesScope')
    // Dispatch when every dependency is Done (V3-30 removed the capacity gate).
    expect(MASTER_SECTION).toContain('every dependency is Done')
    expect(MASTER_SECTION).not.toContain('In-progress cap')
    expect(MASTER_SECTION).toContain('taskboard_assign')
    // Refusal leaves a trace: explain to the user and record it on the card.
    expect(MASTER_SECTION).toContain('refusal reason')
    expect(MASTER_SECTION).toContain('durable trace')
  })

  it('teaches the master-only claim rule in the workflow and master sections (V3-7)', () => {
    // Claiming is the master's scheduling action: the workflow section no
    // longer instructs every session to claim tickets on its own.
    expect(WORKFLOW_SECTION).toContain('only the board\'s current master may call taskboard_claim')
    expect(WORKFLOW_SECTION).toContain('Workers and reviewers never claim')
    expect(WORKFLOW_SECTION).toContain('taskboard_assign (dispatch)')
    expect(WORKFLOW_SECTION).toContain('taskboard_reassign (re-dispatch)')
    // The old free-claim instruction is gone.
    expect(WORKFLOW_SECTION).not.toContain('Claim a ticket with taskboard_claim')
    // The master section names claim among the master-only scheduling tools.
    expect(MASTER_SECTION).toContain('Claiming a Not started ticket (taskboard_claim) is your scheduling action')
    expect(MASTER_SECTION).toContain('only the current master may claim')
    // V3-19 dedup: the worker/reviewer claim rule lives once, in the workflow
    // section — the master section no longer repeats the same sentence.
    expect(MASTER_SECTION).not.toContain('Workers and reviewers never claim')
  })

  it('drops both anti-poll paragraphs from the prompt: the rule lives once, in the dispatch return (V3-29)', () => {
    // ② V3-29: the two ~775-char "Event-driven master, never poll" paragraphs
    // are gone from the prompt — the closing contract is delivered by the
    // taskboard_assign / taskboard_reassign return text instead of being
    // repeated to every session's prompt.
    expect(MASTER_SECTION).not.toContain('never poll')
    expect(WORKFLOW_SECTION).not.toContain('never poll')
    expect(MASTER_SECTION).not.toContain('do not loop taskboard_list / taskboard_notices / taskboard_view')
    expect(WORKFLOW_SECTION).not.toContain('do not loop taskboard_list / taskboard_notices / taskboard_view')
    expect(MASTER_SECTION).not.toContain('A proactive refresh')
    expect(WORKFLOW_SECTION).not.toContain('A proactive refresh')
    expect(MASTER_SECTION).not.toContain('do not read unrelated cards or probe the filesystem')
    // The prompt net shrinks: the V3-28 baseline across both sections was
    // 15374 chars; removing the two paragraphs drops it under 14000.
    expect(MASTER_SECTION.length + WORKFLOW_SECTION.length).toBeLessThan(14000)
    // The rest of the V3-21 discipline (layered card reads) survives.
    expect(MASTER_SECTION).toContain('Read cards in layers')
    expect(MASTER_SECTION).toContain('default compact')
    expect(MASTER_SECTION).toContain('anomaly unresolved')
  })

  it('writes and reads the declared filesScope on cards', async () => {
    const { service, devA } = await harness()
    // Declared at create: read back through the Remote surface and the view.
    const scoped = await service.createRemote(devA, {
      title: 'scoped card', description: '', priority: 'normal', dependsOn: [],
      filesScope: 'src/parser.ts, tests/parser.spec.ts',
    })
    expect(scoped.filesScope).toBe('src/parser.ts, tests/parser.spec.ts')
    expect((await service.viewTicket(scoped.id)).filesScope).toBe('src/parser.ts, tests/parser.spec.ts')
    expect((await service.snapshot(devA)).tickets.find(ticket => ticket.id === scoped.id)!.filesScope)
      .toBe('src/parser.ts, tests/parser.spec.ts')
    // Undeclared cards default to ''.
    const bare = await createTicket(service, 'bare card')
    expect(bare.filesScope).toBe('')
    // Edit replaces the scope; omitting filesScope keeps the current one.
    const edited = await service.editRemote(devA, {
      ticketId: scoped.id, title: 'scoped card', description: '', priority: 'normal', dependsOn: [], filesScope: 'src/parser.ts',
    })
    expect(edited.filesScope).toBe('src/parser.ts')
    const kept = await service.editRemote(devA, {
      ticketId: scoped.id, title: 'scoped card', description: '', priority: 'normal', dependsOn: [],
    })
    expect(kept.filesScope).toBe('src/parser.ts')
  })

  it('records filesScope through the master create tool and surfaces it in the list rows', async () => {
    const { ctx, service, devA } = await harness()
    await service.claimMaster('default', devA)
    const result = await ctx.tools.execute({
      callId: ToolCallId('tool-create-scope'),
      name: 'taskboard_create',
      arguments: { title: 'tool scoped', description: '', priority: 'normal', filesScope: 'packages/client/ui-taskboard/src' },
      agent: devA,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const value = (result as { value: { id: string } }).value
    expect((await service.viewTicket(value.id)).filesScope).toBe('packages/client/ui-taskboard/src')
    // The dispatch surface (taskboard_list rows) carries the scope for the
    // master's parallel-safety judgment.
    const list = await ctx.tools.execute({
      callId: ToolCallId('tool-list-scope'),
      name: 'taskboard_list',
      arguments: {},
      agent: devA,
      signal: new AbortController().signal,
    })
    expect(list.isError).toBe(false)
    const listValue = (list as { value: { tickets: Array<{ id: string; filesScope: string }> } }).value
    const row = listValue.tickets.find(ticket => ticket.id === value.id)!
    expect(row.filesScope).toBe('packages/client/ui-taskboard/src')
    // The view tool also carries the scope.
    const view = await ctx.tools.execute({
      callId: ToolCallId('tool-view-scope'),
      name: 'taskboard_view',
      arguments: { ticketId: value.id },
      agent: devA,
      signal: new AbortController().signal,
    })
    expect(view.isError).toBe(false)
    const viewValue = (view as { value: { filesScope: string } }).value
    expect(viewValue.filesScope).toBe('packages/client/ui-taskboard/src')
  })

  it('injects the session branch and filesScope into the spawned worker prompt', async () => {
    const { service, devA, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await service.createRemote(devA, {
      title: 'branch card', description: '', priority: 'normal', dependsOn: [], filesScope: 'src/only-this.ts',
    })
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('Shared-workspace branch convention')
    expect(prompt).toContain(branchNameFor(devA.id, ticket.id))
    expect(prompt).toContain('git status')
    expect(prompt).toContain('Declared file scope: src/only-this.ts')
    // Without a session id the prompt omits the branch but keeps the scope.
    const bare = buildWorkerPrompt({ ...ticket, filesScope: '' })
    expect(bare).not.toContain('Shared-workspace branch convention')
    expect(bare).toContain('Declared file scope: (not declared)')
  })

  it('surfaces the declared file scope in the review prompt', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const ticket = await service.createRemote(devA, {
      title: 'scoped review', description: '', priority: 'normal', dependsOn: [], filesScope: 'src/parser.ts',
    })
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    await service.report(workerChild, ticket.id, 'implemented')
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    const prompt = (reviewCall[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('Declared file scope: src/parser.ts')
    expect(prompt).toContain('stays inside the declared file scope')
    // An undeclared scope prompts no scope-check step.
    const plain = await service.createAsMaster(devA, { title: 'plain', description: '', priority: 'normal', dependsOn: [] })
    await service.moveAsMaster(devA, { ticketId: plain.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    await service.assign(devA, plain.id)
    await service.report(workerChild, plain.id, 'done')
    const plainCall = subagentsStart.mock.calls[3] as [string, SubagentStartRequest]
    const plainPrompt = (plainCall[1].prompt as { type: string; text: string }[])[0]!.text
    expect(plainPrompt).toContain('Declared file scope: (not declared)')
    expect(plainPrompt).not.toContain('stays inside the declared file scope')
  })

  it('switches the reviewer depth from the card: only 【审核】deep upgrades it', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness()
    await service.claimMaster('default', devA)
    const promptAt = (index: number): string => {
      const call = subagentsStart.mock.calls[index] as [string, SubagentStartRequest]
      return (call[1].prompt as { type: string; text: string }[])[0]!.text
    }
    // A 【审核】 section that is an instruction (not exactly "deep") leaves the
    // default in place.
    const standard = await service.createRemote(devA, {
      title: 'standard depth', description: '【目标】x\n\n【审核】deep 标记能切换分档。并运行 tsc。',
      priority: 'normal', dependsOn: [], filesScope: 'src/a.ts',
    })
    await toNotStarted(service, devA, standard)
    await service.assign(devA, standard.id)
    await service.report(workerChild, standard.id, 'implemented')
    expect(promptAt(1)).toContain('Review depth: standard')

    const deep = await service.createRemote(devA, {
      title: 'deep depth', description: '【目标】y\n\n【审核】deep',
      priority: 'normal', dependsOn: [], filesScope: 'src/b.ts',
    })
    await toNotStarted(service, devA, deep)
    await service.assign(devA, deep.id)
    await service.report(workerChild, deep.id, 'implemented')
    const deepPrompt = promptAt(3)
    expect(deepPrompt).toContain('Review depth: deep')
    expect(deepPrompt).toContain('including files beyond the changed set when they sit directly on such a path')
    // Both reviewer modes carry the cost-narrowing blocks.
    expect(deepPrompt).toContain('Runtime constraints (built-in, always apply)')
    expect(deepPrompt).toContain('Review budget and failure posture')
  })


  // ── V3-19: role context capsules (worker/reviewer) ────────────────────────

  describe('role context capsules (V3-19)', () => {
    /** A minimal TicketView fixture for the pure prompt builders. */
    function capsuleTicket(partial: Partial<TicketView> = {}): TicketView {
      return {
        id: 'ticket-capsule', title: 'capsule card', description: '', column: 'not_started',
        priority: 'normal', boardId: 'default', type: 'feature', status: 'ready',
        failure: null, autoRetries: 0, createdAt: 1, updatedAt: 1, position: 0,
        assignee: null, reviewer: null, reviewAttempts: 0, lastReview: null, reviewOutcome: null,
        devNotes: '', targetBranch: '', filesScope: '', dependsOn: [], history: [],
        ...partial,
      }
    }

    /** A dispatch-time preflight report fixture ([B] V3-20 shape). */
    const preflightReport = (over: Partial<PreflightReport> = {}): PreflightReport => ({
      safe: true, violations: [], repoRoot: 'C:/repo',
      canonicalBase: { branch: 'main', commit: 'base-commit-1' },
      assignedWorktree: 'C:/repo', actualBranch: 'main', head: 'candidate-head-1',
      dirtyFiles: [], baseCandidateRelationship: 'equal', filesScope: 'src/a.ts',
      conflicts: [], checkedAt: 1,
      ...over,
    })

    const countOccurrences = (text: string, needle: string): number =>
      text.split(needle).length - 1

    const MARKER_DESCRIPTION = [
      '【目标】build the capsule compiler',
      '',
      '【验收】the prompt carries the acceptance verbatim; nothing duplicated.',
      '',
      '【硬约束】no LLM summary may replace the original text.',
      '',
      '【纪律】do not merge or push; recompile fresh on retry.',
    ].join('\n')

    it('worker capsule: acceptance verbatim, description content exactly once, no permission paragraphs', () => {
      const ticket = capsuleTicket({
        description: MARKER_DESCRIPTION,
        filesScope: 'src/capsule.ts, tests/capsule.spec.ts',
      })
      const prompt = buildWorkerPrompt(ticket, 'C:/work', 'master-session-1', preflightReport())
      // The capsule carries exactly the field set: goal, acceptance, git
      // facts, declared scope, constraints.
      expect(prompt).toContain('# Worker capsule')
      expect(prompt).toContain('【目标】build the capsule compiler')
      expect(prompt).toContain('【验收】the prompt carries the acceptance verbatim; nothing duplicated.')
      expect(prompt).toContain('【硬约束】no LLM summary may replace the original text.')
      expect(prompt).toContain('【纪律】do not merge or push; recompile fresh on retry.')
      // Verbatim acceptance: every section appears exactly once (no duplication).
      expect(countOccurrences(prompt, '【验收】the prompt carries the acceptance verbatim; nothing duplicated.')).toBe(1)
      expect(countOccurrences(prompt, '【目标】build the capsule compiler')).toBe(1)
      // The raw description is decomposed into the capsule fields, never
      // inlined whole on top of them.
      expect(countOccurrences(prompt, MARKER_DESCRIPTION)).toBe(0)
      // Git facts come from the preflight report, not an appendix.
      expect(prompt).toContain('canonical base: main @ base-commit-1')
      expect(prompt).toContain('assigned worktree: C:/repo')
      expect(prompt).toContain('actual branch: main')
      expect(prompt).toContain('HEAD: candidate-head-1')
      expect(prompt).toContain('dirty files: (none)')
      expect(prompt).toContain('Declared file scope: src/capsule.ts, tests/capsule.spec.ts')
      // The old per-card permission paragraph is gone (runtime tool filter
      // and the workflow section own the role permissions).
      expect(prompt).not.toContain('You may not claim')
      expect(prompt).not.toContain('Do not call any other taskboard tool')
      // Built-in runtime constraints ride every capsule: oversized tool output
      // is the dominant avoidable cost of a dispatched run (it stays in the
      // context and is re-sent on every later request).
      expect(prompt).toContain('Runtime constraints (built-in, always apply)')
      expect(prompt).toContain('Keep tool output small')
      // Dialect-aware: dispatched workers run pwsh on win32, bash on POSIX —
      // both examples are named, never a POSIX-only utility.
      expect(prompt).toContain('bash: `tail -n 120`; PowerShell: `Select-Object -Last 120`')
      expect(prompt).toContain('Select-Object -Skip 9 -First 16')
      // With facts available the location hint points at them.
      expect(prompt).toContain('the repository facts above already locate the code you need')
    })

    it('worker capsule: a marker-less description lands once in the additional details', () => {
      const ticket = capsuleTicket({ description: 'plain goal text with no markers' })
      const prompt = buildWorkerPrompt(ticket, 'C:/work', 'master-session-1')
      expect(prompt).toContain('(no 【目标】 section in the card description)')
      expect(prompt).toContain('(no 【验收】 section in the card description)')
      expect(prompt).toContain('Additional card details (verbatim):')
      expect(countOccurrences(prompt, 'plain goal text with no markers')).toBe(1)
      // Without preflight facts the capsule names the working directory and
      // tells the worker to verify with git directly.
      expect(prompt).toContain('preflight not computed at dispatch')
      expect(prompt).toContain('git branch --show-current')
      expect(prompt).toContain('working directory: C:/work')
      // Without computed facts the built-in hint must not claim the facts
      // above locate the code (the reviewer caught the unconditional claim).
      expect(prompt).toContain('locate the code with one targeted search before reading anything')
      expect(prompt).not.toContain('the repository facts above already locate the code you need')
    })

    it('worker capsule: retry recompiles a fresh capsule — no stale facts, no appended notes', () => {
      const first = capsuleTicket({ description: MARKER_DESCRIPTION, filesScope: 'src/a.ts' })
      const p1 = buildWorkerPrompt(first, 'C:/work', 'master-session-1', preflightReport({ head: 'old-head', dirtyFiles: [' M stale.ts'] }))
      expect(p1).toContain('HEAD: old-head')
      expect(p1).toContain('dirty files:  M stale.ts')
      // Retry: the same card re-dispatched — description annotated, facts fresh.
      const retry = capsuleTicket({
        description: MARKER_DESCRIPTION + '\n\n[auto-redispatch #2] 续做勿回滚：previous worker lost; continue from the preserved working tree.',
        filesScope: 'src/a.ts',
      })
      const p2 = buildWorkerPrompt(retry, 'C:/work', 'master-session-1', preflightReport({ head: 'fresh-head', dirtyFiles: [] }))
      // Fresh facts only: the new HEAD is in, the old one is gone.
      expect(p2).toContain('HEAD: fresh-head')
      expect(p2).not.toContain('HEAD: old-head')
      expect(p2).not.toContain('stale.ts')
      // The previous prompt's appendix pattern is never carried over.
      expect(p2).not.toContain('Deterministic repo preflight')
      // The current card state (the recovery annotation) is present once.
      expect(countOccurrences(p2, '[auto-redispatch #2]')).toBe(1)
    })

    it('worker capsule: deterministic — same inputs yield identical prompts', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, filesScope: 'src/a.ts' })
      const report = preflightReport()
      expect(buildWorkerPrompt(ticket, 'C:/work', 'master-session-1', report))
        .toBe(buildWorkerPrompt(ticket, 'C:/work', 'master-session-1', report))
    })

    it('reviewer capsule: base/candidate/touched files, compact claims and the diff-first path', () => {
      const ticket = capsuleTicket({
        description: MARKER_DESCRIPTION,
        filesScope: 'src/capsule.ts',
        devNotes: [
          'Root cause: duplicate prompt sections',
          'Files changed: src/capsule.ts, src/domain.ts',
          'Tests run: taskboard.spec.ts',
          'Known anomaly: none',
        ].join('\n'),
      })
      const facts: ReviewerGitFacts = {
        available: true, repoRoot: 'C:/repo', baseCommit: 'base-commit-1',
        candidateCommit: 'candidate-head-1', touchedFiles: ['src/capsule.ts', 'src/domain.ts'],
      }
      const prompt = buildReviewPrompt(ticket, facts)
      expect(prompt).toContain('# Reviewer capsule')
      expect(prompt).toContain('【验收】the prompt carries the acceptance verbatim; nothing duplicated.')
      expect(prompt).toContain('Base commit: base-commit-1')
      expect(prompt).toContain('Candidate commit: candidate-head-1')
      expect(prompt).toContain('Touched files / diff:')
      expect(prompt).toContain('  - src/capsule.ts')
      expect(prompt).toContain('  - src/domain.ts')
      expect(prompt).toContain('Declared file scope: src/capsule.ts')
      // Compact claims structured from devNotes.
      expect(prompt).toContain("Worker's claims")
      expect(prompt).toContain('Root cause: duplicate prompt sections')
      expect(prompt).toContain('Files changed: src/capsule.ts, src/domain.ts')
      expect(prompt).toContain('Tests run: taskboard.spec.ts')
      expect(prompt).toContain('Known anomaly: none')
      // The independent diff-first verification path, with scope and claims checks.
      expect(prompt).toContain('Independent verification (diff-first, not diff-only)')
      expect(prompt).toContain('Acceptance → diff')
      expect(prompt).toContain('stays inside the declared file scope')
      expect(prompt).toContain('a claim is never a fact')
    })

    it('reviewer capsule: unlabeled devNotes become one compact claim; no exploration dump', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, devNotes: 'implemented the compiler; ran tests' })
      const prompt = buildReviewReportPrompt(ticket)
      expect(prompt).toContain('Root cause: (not claimed)')
      expect(prompt).toContain('devNotes: implemented the compiler; ran tests')
      expect(prompt).toContain('verdict: "approve"')
      expect(prompt).not.toContain('Ticket content:')
    })

    it('reviewer capsule without git facts instructs computing base/candidate/diff', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, filesScope: 'src/capsule.ts' })
      const prompt = buildReviewPrompt(ticket)
      expect(prompt).toContain('Base commit: to be determined by the reviewer')
      expect(prompt).toContain('Candidate commit: to be determined by the reviewer')
      expect(prompt).toContain('(to be determined — compute the diff between the base and candidate commits and list the files)')
    })

    it('reviewer capsule: the worker root cause is a claim, never a fact', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, devNotes: 'Root cause: fixed the bug' })
      const prompt = buildReviewPrompt(ticket)
      expect(prompt).toContain('CLAIMS to verify independently, never facts')
      expect(prompt).toContain('Root cause: fixed the bug')
    })

    // ── V3-24: reviewer cost narrowing (output discipline, budget, depth, claims) ──

    it('reviewer capsule: carries the worker runtime output discipline verbatim', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, filesScope: 'src/capsule.ts' })
      const reviewPrompt = buildReviewPrompt(ticket, {
        available: true, repoRoot: 'C:/repo', baseCommit: 'base-commit-1',
        candidateCommit: 'candidate-head-1', touchedFiles: ['src/capsule.ts'],
      })
      expect(reviewPrompt).toContain('Runtime constraints (built-in, always apply)')
      expect(reviewPrompt).toContain('Keep tool output small')
      // Same dialect and the same examples as the worker capsule (V3-24).
      expect(reviewPrompt).toContain('bash: `tail -n 120`; PowerShell: `Select-Object -Last 120`')
      expect(reviewPrompt).toContain('bash: `sed -n 10,25p`; PowerShell: `Select-Object -Skip 9 -First 16`')
      // The reason the discipline exists is kept, not paraphrased away.
      expect(reviewPrompt).toContain('Every byte you print stays in your context and is re-sent on every later turn')
      // Verbatim parity: the worker capsule's own discipline line appears
      // unchanged in the reviewer capsule (one shared block, two roles).
      const workerPrompt = buildWorkerPrompt(ticket, 'C:/work', 'master-session-1', preflightReport())
      const discipline = workerPrompt.split('\n').find(line => line.includes('Keep tool output small'))
      expect(discipline).toBeDefined()
      expect(reviewPrompt).toContain(discipline as string)
    })

    it('reviewer capsule: ≤10-step budget with the no-evidence failure posture', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, filesScope: 'src/capsule.ts' })
      const prompt = buildReviewPrompt(ticket)
      expect(prompt).toContain('Review budget and failure posture')
      expect(prompt).toContain('≤10 steps')
      // Both reviewer modes (approve/reject and the report-mode child) carry
      // the same cost-narrowing blocks.
      const reportPrompt = buildReviewReportPrompt(ticket)
      expect(reportPrompt).toContain('Runtime constraints (built-in, always apply)')
      expect(reportPrompt).toContain('Review budget and failure posture')
      expect(reportPrompt).toContain('Review depth: standard')
      // The exact contract: reject with the concrete blockage inside the
      // budget rather than approving without evidence.
      expect(prompt).toContain('若在预算内无法独立验证，就用具体阻塞点打回，绝不在缺乏证据时通过。')
      expect(prompt).toContain('never approve without evidence')
    })

    it('reviewer capsule: standard by default, deep only when the card marks it', () => {
      const standard = buildReviewPrompt(capsuleTicket({ description: MARKER_DESCRIPTION }))
      expect(standard).toContain('Review depth: standard')
      expect(standard).not.toContain('Review depth: deep')
      expect(standard).toContain('depth: standard')
      // Standard tightens the open call-path read to a conflict-driven one.
      expect(standard).toContain('read files beyond the changed set only when a claim conflicts with the evidence you gathered')
      expect(standard).not.toContain('including files beyond the changed set when they sit directly on such a path')
      // Standard: the acceptance command runs once.
      expect(standard).toContain("Run the card's acceptance command once")

      const deepPrompt = buildReviewPrompt(capsuleTicket({
        description: MARKER_DESCRIPTION + '\n\n【审核】deep',
      }))
      expect(deepPrompt).toContain('Review depth: deep')
      expect(deepPrompt).toContain('depth: deep')
      // Deep allows the open read along the acceptance call paths (the old
      // unrestricted step 2), and probes the failure paths too.
      expect(deepPrompt).toContain('including files beyond the changed set when they sit directly on such a path')
      expect(deepPrompt).toContain('failure paths those inputs imply')
      expect(deepPrompt).not.toContain('read files beyond the changed set only when a claim conflicts')
    })

    it('reviewer depth: only a 【审核】 section whose body is exactly deep upgrades it', () => {
      expect(reviewerDepthFromDescription('')).toBe('standard')
      expect(reviewerDepthFromDescription('【审核】deep')).toBe('deep')
      expect(reviewerDepthFromDescription('【审核】 DEEP ')).toBe('deep')
      // An instruction in the section is ordinary card content, not a marker
      // (this card's own 【审核】 body must not flip its reviewer to deep).
      expect(reviewerDepthFromDescription('【审核】deep 标记能切换分档。并运行 tsc。')).toBe('standard')
      expect(reviewerDepthFromDescription('【审核】standard')).toBe('standard')
      expect(reviewerDepthFromDescription('【验收】deep')).toBe('standard')
      // The compiled capsule carries the derived depth.
      expect(compileReviewerCapsule(capsuleTicket({ description: '【审核】deep' })).depth).toBe('deep')
      expect(compileReviewerCapsule(capsuleTicket({ description: MARKER_DESCRIPTION })).depth).toBe('standard')
    })

    it('reviewer capsule: claims must carry the command and the key output line', () => {
      const withLine = buildReviewPrompt(capsuleTicket({
        description: MARKER_DESCRIPTION,
        devNotes: [
          'Tests run: corepack pnpm exec vitest run packages/taskboard/taskboard',
          'Key output line: Tests  384 passed (384)',
        ].join('\n'),
      }))
      expect(withLine).toContain('Tests run: corepack pnpm exec vitest run packages/taskboard/taskboard')
      expect(withLine).toContain('Key output line: Tests  384 passed (384)')
      // The key line is the re-run comparison target.
      expect(withLine).toContain('re-run the command and compare exactly that line')

      const withoutLine = buildReviewPrompt(capsuleTicket({
        description: MARKER_DESCRIPTION,
        devNotes: 'Tests run: corepack pnpm exec vitest run',
      }))
      expect(withoutLine).toContain('missing — the claim arrived without the key output line')
      expect(withoutLine).toContain('treat it as missing, never guess')
      expect(withoutLine).toContain('when devNotes gives no key output line, treat that claim as missing rather than guessing')

      const claims = parseWorkerClaims('关键输出行：12 passed\nKnown anomaly: none')
      expect(claims.keyOutputLine).toBe('12 passed')
      expect(claims.knownAnomaly).toBe('none')
      expect(parseWorkerClaims('Root cause: x').keyOutputLine).toBe('')
    })

    it('worker capsule: the reporting contract demands a checkable key output line', () => {
      const prompt = buildWorkerPrompt(capsuleTicket({ description: MARKER_DESCRIPTION }), 'C:/work', 'master-session-1')
      expect(prompt).toContain('Reporting contract (built-in, always apply)')
      expect(prompt).toContain('Make every claim checkable')
      expect(prompt).toContain('Key output line:')
      expect(prompt).toContain('treated as missing')
    })

    it('workflow and master sections keep one copy of the claim rule (V3-19 dedup)', () => {
      // The worker/reviewer claim rule is taught once, in the workflow section.
      expect(WORKFLOW_SECTION).toContain('Workers and reviewers never claim')
      expect(WORKFLOW_SECTION).toContain('taskboard_assign (dispatch)')
      expect(WORKFLOW_SECTION).toContain('taskboard_reassign (re-dispatch)')
      // The master section no longer repeats the same sentence.
      expect(MASTER_SECTION).not.toContain('Workers and reviewers never claim')
      expect(MASTER_SECTION).toContain('only the current master may claim')
    })

    it('capsule compilers are pure and expose the schema', () => {
      const ticket = capsuleTicket({ description: MARKER_DESCRIPTION, filesScope: 'src/a.ts' })
      const report = preflightReport()
      const capsule = compileWorkerCapsule(ticket, report)
      expect(capsule.goal).toContain('build the capsule compiler')
      expect(capsule.acceptance).toContain('acceptance verbatim')
      expect(capsule.constraints).toContain('no LLM summary may replace')
      expect(capsule.gitFacts.available).toBe(true)
      expect(capsule.gitFacts.head).toBe('candidate-head-1')
      expect(capsule.gitFacts.canonicalBase).toEqual({ branch: 'main', commit: 'base-commit-1' })
      expect(capsule.gitFacts.dirtyFiles).toEqual([])
      expect(capsule.additionalDetails).toBe('')
      // Reviewer side: the preflight facts map onto base/candidate.
      const reviewFacts = reviewerFactsFromPreflight(report)
      expect(reviewFacts.baseCommit).toBe('base-commit-1')
      expect(reviewFacts.candidateCommit).toBe('candidate-head-1')
      const reviewCapsule = compileReviewerCapsule({ ...ticket, devNotes: 'Root cause: x' }, reviewFacts)
      expect(reviewCapsule.acceptance).toContain('acceptance verbatim')
      expect(reviewCapsule.claims.rootCause).toBe('x')
      expect(reviewCapsule.git.baseCommit).toBe('base-commit-1')
    })

    it('parseWorkerClaims fills the four claim slots from labeled devNotes', () => {
      const claims = parseWorkerClaims([
        'Root cause: mislabeled cache key',
        'Files changed: src/a.ts, tests/a.spec.ts',
        'Tests run: vitest run',
        'Known anomaly: flaky timing test',
      ].join('\n'))
      expect(claims.rootCause).toBe('mislabeled cache key')
      expect(claims.filesChanged).toBe('src/a.ts, tests/a.spec.ts')
      expect(claims.testsRun).toBe('vitest run')
      expect(claims.knownAnomaly).toBe('flaky timing test')
      // Unlabeled devNotes keep the text but claim nothing.
      const plain = parseWorkerClaims('implemented it')
      expect(plain.rootCause).toBe('')
      expect(plain.devNotes).toBe('implemented it')
    })

    it('parseSections decomposes the description once and keeps the preamble', () => {
      const sections = parseSections('preamble text\n【目标】goal body\n【验收】accept body\n\n【纪律】discipline body')
      expect(sections.map(section => section.title)).toEqual(['', '目标', '验收', '纪律'])
      expect(sections[0]!.marker).toBeNull()
      expect(sections[0]!.body).toBe('preamble text')
      expect(sections[1]!.body).toBe('goal body')
      expect(sections[2]!.body).toBe('accept body')
      expect(sections[3]!.body).toBe('discipline body')
    })
  })

  // ── V3-5: customizable worker/reviewer model + reasoning effort ──────────

  it('spawns workers and reviewers with the configured model and effort in agentOptions (V3-5)', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness({
      workerModel: 'deepseek-v4-flash',
      workerEffort: 'max',
      reviewerModel: 'deepseek-v4-pro-max',
      reviewerEffort: 'off',
    })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'effort card')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const workerCall = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    expect(workerCall[1].agentOptions).toEqual({ model: 'deepseek-v4-flash', reasoningEffort: 'max' })
    await service.report(workerChild, ticket.id, 'implemented')
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    expect(reviewCall[1].agentOptions).toEqual({ model: 'deepseek-v4-pro-max', reasoningEffort: 'off' })
  })

  it('defaults reviewer model/effort along the worker knobs and omits effort when unset (V3-5)', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness({ workerEffort: 'high' })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'default knobs')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    // Worker: the flash default model plus the configured high effort.
    expect((subagentsStart.mock.calls[0] as [string, SubagentStartRequest])[1].agentOptions)
      .toEqual({ model: 'deepseek-v4-flash', reasoningEffort: 'high' })
    // Reviewer: model and effort default along the worker knobs.
    await service.report(workerChild, ticket.id, 'done')
    expect((subagentsStart.mock.calls[1] as [string, SubagentStartRequest])[1].agentOptions)
      .toEqual({ model: 'deepseek-v4-flash', reasoningEffort: 'high' })
    // Without any effort configured the spawn carries the model only; the
    // child model's adapter default governs.
    const bare = await harness()
    await bare.service.claimMaster('default', bare.devA)
    const plain = await createTicket(bare.service, 'no effort')
    await toNotStarted(bare.service, bare.devA, plain)
    await bare.service.assign(bare.devA, plain.id)
    expect((bare.subagentsStart.mock.calls[0] as [string, SubagentStartRequest])[1].agentOptions)
      .toEqual({ model: 'deepseek-v4-flash' })
  })

  it('falls back to the adapter default when a configured effort is not a deepseek level (V3-5)', async () => {
    const { service, devA, workerChild, subagentsStart } = await harness({
      workerEffort: 'bogus',
      reviewerEffort: 'ultra',
      workerModel: 'deepseek-v4-flash',
    })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'invalid effort')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    expect((subagentsStart.mock.calls[0] as [string, SubagentStartRequest])[1].agentOptions)
      .toEqual({ model: 'deepseek-v4-flash' })
    await service.report(workerChild, ticket.id, 'done')
    expect((subagentsStart.mock.calls[1] as [string, SubagentStartRequest])[1].agentOptions)
      .toEqual({ model: 'deepseek-v4-flash' })
    // An invalid reviewerEffort falls back to the (valid) workerEffort.
    const fb = await harness({ workerEffort: 'max', reviewerEffort: 'bogus' })
    await fb.service.claimMaster('default', fb.devA)
    const card = await createTicket(fb.service, 'fallback reviewer')
    await toNotStarted(fb.service, fb.devA, card)
    await fb.service.assign(fb.devA, card.id)
    await fb.service.report(fb.workerChild, card.id, 'done')
    const reviewCall = fb.subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    expect(reviewCall[1].agentOptions?.reasoningEffort).toBe('max')
  })

  it('board modelConfig overrides the host worker/reviewer model+effort per board (V3-5)', async () => {
    const { ctx, service, devA, workerChild, subagentsStart } = await harness({
      workerModel: 'host-flash',
      workerEffort: 'high',
    })
    await service.claimMaster('default', devA)
    const result = await ctx.tools.execute({
      callId: ToolCallId('tool-board-config'),
      name: 'taskboard_board_config',
      arguments: { workerModel: 'board-model', workerEffort: 'off', reviewerModel: 'board-reviewer', reviewerEffort: 'max' },
      agent: devA,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(rendered).toContain('board-model')
    const ticket = await createTicket(service, 'board override')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const workerCall = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    expect(workerCall[1].agentOptions).toEqual({ model: 'board-model', reasoningEffort: 'off' })
    await service.report(workerChild, ticket.id, 'done')
    const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    expect(reviewCall[1].agentOptions).toEqual({ model: 'board-reviewer', reasoningEffort: 'max' })
  })

  it('a partial board modelConfig inherits host knobs; "" clears an override; bad effort is rejected (V3-5)', async () => {
    const { ctx, service, devA, devB, subagentsStart } = await harness({ workerModel: 'host-flash', workerEffort: 'max' })
    await service.claimMaster('default', devA)
    // Set only the worker model: the effort and the reviewer knobs inherit the host config.
    await ctx.tools.execute({
      callId: ToolCallId('bc-partial'), name: 'taskboard_board_config',
      arguments: { workerModel: 'board-model' }, agent: devA, signal: new AbortController().signal,
    })
    const ticket = await createTicket(service, 'partial override')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    expect((subagentsStart.mock.calls[0] as [string, SubagentStartRequest])[1].agentOptions)
      .toEqual({ model: 'board-model', reasoningEffort: 'max' })
    // Clearing the worker model restores the host model.
    await ctx.tools.execute({
      callId: ToolCallId('bc-clear'), name: 'taskboard_board_config',
      arguments: { workerModel: '' }, agent: devA, signal: new AbortController().signal,
    })
    const card2 = await createTicket(service, 'cleared override')
    await toNotStarted(service, devA, card2)
    await service.assign(devA, card2.id)
    expect((subagentsStart.mock.calls[1] as [string, SubagentStartRequest])[1].agentOptions?.model).toBe('host-flash')
    // An invalid effort is rejected loudly by the master tool.
    const denied = await ctx.tools.execute({
      callId: ToolCallId('bc-bad'), name: 'taskboard_board_config',
      arguments: { workerEffort: 'ludicrous' }, agent: devA, signal: new AbortController().signal,
    })
    expect(denied.isError).toBe(true)
    expect((denied as { error: { message: string } }).error.message).toContain('off|high|max')
    // A non-master cannot configure the board.
    const nonMaster = await ctx.tools.execute({
      callId: ToolCallId('bc-non-master'), name: 'taskboard_board_config',
      arguments: { workerModel: 'nope' }, agent: devB, signal: new AbortController().signal,
    })
    expect(nonMaster.isError).toBe(true)
    expect((nonMaster as { error: { message: string } }).error.message).toContain('master')
  })

  it('omits agent options and records an effort downgrade when the provider lacks that capability (V3-5)', async () => {
    const { service, devA, subagentsStart } = await harness({
      workerEffort: 'max',
      providerCapabilities: { agentOptions: false, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    })
    await service.claimMaster('default', devA)
    const ticket = await createTicket(service, 'downgrade card')
    await toNotStarted(service, devA, ticket)
    await service.assign(devA, ticket.id)
    const workerCall = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    // The provider cannot accept either model or effort overrides.
    expect(workerCall[1].agentOptions).toBeUndefined()
    // The downgrade is recorded on the card history.
    const updated = await service.viewTicket(ticket.id)
    expect(updated.history.some(row => row.kind === 'model-effort-downgrade' && row.detail.includes('max'))).toBe(true)
  })

  it('writes the masterModel/masterEffort informational suggestion into the master prompt (V3-5)', async () => {
    const { ctx } = await harness({ masterEffort: 'high' })
    const assembly = await ctx.systemPrompt.assemble({})
    const master = assembly.sections.find(section => section.name === 'taskboard:master')
    expect(master?.text).toContain('Model preset suggestion (new sessions)')
    expect(master?.text).toContain('deepseek-v4-pro-max')
    expect(master?.text).toContain('reasoning effort "high"')
    expect(master?.text).toContain('authoritative')
    // Without a configured master effort the note names only the model.
    const bare = masterModelNote('deepseek-v4-pro-max', undefined)
    expect(bare).not.toContain('reasoning effort')
    // The static master section itself is untouched (existing tests cover it).
    expect(master?.text).toContain('Taskboard master')
  })
})

it('hands over the master seat with structured notes and continues cross-session', async () => {
  const { service, devA, devB, workerChild } = await harness()
  await service.claimMaster('default', devA)
  await createTicket(service, 'planned card')
  const inFlight = await createTicket(service, 'in flight')
  await toNotStarted(service, devA, inFlight)
  await service.assign(devA, inFlight.id)
  const underReview = await createTicket(service, 'under review')
  await toNotStarted(service, devA, underReview)
  await service.assign(devA, underReview.id)
  await service.report(workerChild, underReview.id, 'implemented')

  // A non-master cannot hand over the seat.
  await expect(service.handover('default', devB)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_MASTER' })

  // The master hands over: structured notes + released seat.
  const result = await service.handover('default', devA)
  expect(result.board.masterAgentId).toBeNull()
  expect(result.board.masterClaimedAt).toBeNull()
  const notes = result.notes
  expect(notes).toContain('# Taskboard handover — board "default"')
  expect(notes).toContain('## Backlog (1)')
  expect(notes).toContain('planned card')
  expect(notes).toContain('## Not started (0)')
  expect(notes).toContain('## In progress (1)')
  expect(notes).toContain('in flight')
  expect(notes).toContain('status running')
  expect(notes).toContain('worker worker-child-agent (session worker-child-agent)')
  expect(notes).toContain('## In testing (1)')
  expect(notes).toContain('under review')
  expect(notes).toContain('reviewer reviewer-child-agent')
  expect(notes).toContain('## Master history')
  expect(notes).toContain('dev-agent-a')

  // The board record carries the notes for the next master.
  const boardRow = (await service.listBoards(devB)).find(candidate => candidate.boardId === 'default')!
  expect(boardRow.handoverNotes).toBe(notes)

  // Cross-session: the successor claims the seat, reads the notes and
  // continues dispatching from them.
  const claimed = await service.claimMaster('default', devB)
  expect(claimed.masterAgentId).toBe(devB.id)
  expect(claimed.handoverNotes).toContain('worker worker-child-agent (session worker-child-agent)')
  const next = await createTicket(service, 'next dispatch')
  await toNotStarted(service, devB, next)
  const assigned = await service.assign(devB, next.id)
  expect(assigned.worker).toBe('spawned')
  expect(assigned.ticket.column).toBe('in_progress')
})

it('returns the structured handover snapshot from the claim tool, even without a prior handover', async () => {
  let settle!: (result: RunResultStub) => void
  const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
  const { ctx, service, devA, devB, workerChild } = await harness({ reviewerRunResult: runResult })
  await service.claimMaster('default', devA)
  const planned = await createTicket(service, 'planned card')
  const inFlight = await createTicket(service, 'in flight')
  await toNotStarted(service, devA, inFlight)
  await service.assign(devA, inFlight.id)
  const underReview = await createTicket(service, 'under review')
  await toNotStarted(service, devA, underReview)
  await service.assign(devA, underReview.id)
  await service.report(workerChild, underReview.id, 'implemented')
  settle({
    output: [],
    stopReason: 'completed',
    structured: { verdict: 'approve', summary: 'ok', problems: [] },
  })
  await vi.waitFor(async () => {
    expect((await service.viewTicket(underReview.id)).reviewOutcome).not.toBeNull()
  })
  // Crash succession: the old master never called taskboard_handover, so the
  // stored notes are empty — the claim tool must still deliver the complete
  // structured snapshot computed fresh from the live board state.
  await service.releaseMaster('default', devA)
  const claim = await ctx.tools.execute({
    callId: ToolCallId('tool-claim-snapshot'),
    name: 'taskboard_claim_master',
    arguments: {},
    agent: devB,
    signal: new AbortController().signal,
  })
  expect(claim.isError).toBe(false)
  const value = (claim as { value: {
    cards: Array<{
      ticketId: string
      title: string
      column: string
      status: string
      workerAgentId: string | null
      reviewer: { agentId: string } | null
      reviewOutcome: { verdict: string } | null
      dependsOn: string[]
    }>
    backlogSummary: string
    pendingAdjudications: string[]
    handoverNotes: string
  } }).value
  expect(value.handoverNotes).toBe('')
  expect(value.cards.map(card => card.ticketId).sort()).toEqual([planned.id, inFlight.id, underReview.id].sort())
  const inFlightRow = value.cards.find(card => card.ticketId === inFlight.id)!
  expect(inFlightRow).toMatchObject({ title: 'in flight', column: 'in_progress', status: 'running' })
  expect(inFlightRow.workerAgentId).toBe('worker-child-agent')
  const underReviewRow = value.cards.find(card => card.ticketId === underReview.id)!
  expect(underReviewRow).toMatchObject({ title: 'under review', column: 'in_testing' })
  expect(underReviewRow.reviewer?.agentId).toBe('reviewer-child-agent')
  expect(underReviewRow.reviewOutcome?.verdict).toBe('approve')
  expect(value.backlogSummary).toContain('Backlog 1')
  expect(value.backlogSummary).toContain('In progress 1')
  expect(value.backlogSummary).toContain('In testing 1')
  expect(value.pendingAdjudications).toEqual([underReview.id])

  // The MODEL-VISIBLE result (the rendered content the agent actually reads)
  // must carry the concrete facts, not just counts: this is the real P0-0
  // acceptance line that the previous review missed.
  const visible = (claim as { content: { type: string; text: string }[] }).content
  const claimText = visible.map(block => block.text).join('\n')
  expect(claimText).toContain(planned.id)
  expect(claimText).toContain('"planned card"')
  expect(claimText).toContain(inFlight.id)
  expect(claimText).toContain('"in flight"')
  expect(claimText).toContain('column=in_progress')
  expect(claimText).toContain('status=running')
  expect(claimText).toContain('worker=worker-child-agent')
  expect(claimText).toContain(underReview.id)
  expect(claimText).toContain('reviewer=reviewer-child-agent')
  expect(claimText).toContain('Pending adjudications: ' + underReview.id)
  expect(claimText).toContain('Backlog 1 · Not started 0 · In progress 1 · In testing 1')

  // taskboard_list's model-visible result carries the concrete rows too.
  const list = await ctx.tools.execute({
    callId: ToolCallId('tool-list-snapshot'),
    name: 'taskboard_list',
    arguments: {},
    agent: devB,
    signal: new AbortController().signal,
  })
  expect(list.isError).toBe(false)
  const listVisible = (list as { content: { type: string; text: string }[] }).content
  const listText = listVisible.map(block => block.text).join('\n')
  expect(listText).toContain(inFlight.id)
  expect(listText).toContain('"in flight"')
  expect(listText).toContain('column=in_progress')
  expect(listText).toContain('status=running')
  expect(listText).toContain(underReview.id)
})

it('lists cards compact by default and full when detail "full" is requested (V3-21)', async () => {
  const { ctx, service, devA } = await harness()
  await service.claimMaster('default', devA)
  const card = await service.createRemote(devA, {
    title: 'layered card', description: 'the full description', priority: 'normal',
    dependsOn: [], filesScope: 'src/domain.ts',
  })
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)

  // Default detail: compact one-line rows (no description/devNotes/reviewOutcome).
  const compact = await ctx.tools.execute({
    callId: ToolCallId('tool-list-compact'),
    name: 'taskboard_list',
    arguments: {},
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(compact.isError).toBe(false)
  const compactValue = (compact as { value: { tickets: Array<Record<string, unknown>> } }).value
  expect(compactValue.tickets[0]!.description).toBeUndefined()
  expect(compactValue.tickets[0]!.devNotes).toBeUndefined()
  const compactText = compact.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(compactText).toContain(card.id)
  expect(compactText).not.toContain('the full description')

  // detail "full": the rows carry description/devNotes/reviewOutcome and the
  // model-visible render shows them.
  const full = await ctx.tools.execute({
    callId: ToolCallId('tool-list-full'),
    name: 'taskboard_list',
    arguments: { detail: 'full' },
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(full.isError).toBe(false)
  const fullValue = (full as { value: { tickets: Array<{ description?: string; devNotes?: string; reviewOutcome?: unknown }> } }).value
  expect(fullValue.tickets[0]!.description).toBe('the full description')
  expect(fullValue.tickets[0]!.devNotes).toBeDefined()
  const fullText = full.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(fullText).toContain('the full description')
})

it('rejects handover on an unknown board', async () => {
  const { service, devA } = await harness()
  await expect(service.handover('no-such-board', devA)).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NOT_FOUND' })
})

it('rejects assign from a subagent session; the top-level master still dispatches', async () => {
  const { service, devA } = await harness()
  const subagent = stubAgentForSession(Session.create(SessionId('spawned-child'), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('spawned-child'),
    createdAt: Date.now(),
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
  }))
  await service.claimMaster('default', devA)
  const ticket = await createTicket(service, 'root guard')
  await toNotStarted(service, devA, ticket)
  await expect(service.assign(subagent, ticket.id)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_ROOT' })
  // The top-level master still dispatches after the rejection.
  const result = await service.assign(devA, ticket.id)
  expect(result.worker).toBe('spawned')
  expect(result.ticket.status).toBe('running')
})

it('notifies the master inbox when a worker reports and when a verdict lands', async () => {
  let settle!: (result: RunResultStub) => void
  const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
  const { service, devA, workerChild } = await harness({ reviewerRunResult: runResult })
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const card = await createTicket(service, 'notice card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)

  // Worker reports done: the master's inbox receives the adjudicate notice.
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.ticket.column).toBe('in_testing')
  expect(followup).toHaveBeenCalledTimes(1)
  const first = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
  expect(first.source.kind).toBe('taskboard')
  expect(first.source.boardId).toBe('default')
  expect(textOf(first)).toContain(card.id)
  expect(textOf(first)).toContain('taskboard_resolve_review')

  // The reviewer verdict lands on the card: a second notice reaches the master.
  settle({ output: [], stopReason: 'completed', structured: { verdict: 'approve', summary: 'verified', problems: [] } })
  await vi.waitFor(() => {
    expect(followup.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
  const second = followup.mock.calls[1]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
  expect(second.source.kind).toBe('taskboard')
  expect(textOf(second)).toContain('approve')
  expect(textOf(second)).toContain('taskboard_resolve_review')
})

it('carries the compact event line (ticket/state/scope/verdict/anomaly) in every worker-lifecycle notice (V3-21)', async () => {
  let settle!: (result: RunResultStub) => void
  const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
  const { service, devA, workerChild } = await harness({ reviewerRunResult: runResult })
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const card = await service.createRemote(devA, {
    title: 'compact notice card', description: '', priority: 'normal', dependsOn: [], filesScope: 'src/domain.ts',
  })
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)

  // Worker done: WORKER_DONE ticket=... title=... state=in_testing scope=...
  await service.report(workerChild, card.id, 'implemented and tested')
  const done = textOf(followup.mock.calls[0]![0] as { content: { type: string; text: string }[] })
  expect(done).toContain('WORKER_DONE ticket=' + card.id)
  expect(done).toContain('state=in_testing')
  expect(done).toContain('scope=src/domain.ts')
  expect(done).toContain('taskboard_resolve_review')

  // Review verdict: REVIEW_VERDICT ticket=... verdict=approve state=in_testing.
  settle({ output: [], stopReason: 'completed', structured: { verdict: 'approve', summary: 'verified', problems: [] } })
  await vi.waitFor(() => { expect(followup.mock.calls.length).toBeGreaterThanOrEqual(2) })
  const verdict = textOf(followup.mock.calls[1]![0] as { content: { type: string; text: string }[] })
  expect(verdict).toContain('REVIEW_VERDICT ticket=' + card.id)
  expect(verdict).toContain('verdict=approve')
  expect(verdict).toContain('state=in_testing')
})

it('carries the compact event line (ticket/state/scope/blocker/anomaly) in fail and lost-worker notices (V3-21)', async () => {
  const { service, devA, workerChild } = await harness()
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const card = await createTicket(service, 'compact doomed card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)

  // Worker failed: WORKER_FAILED ticket=... state=in_progress/blocked blocker=...
  const blocked = await service.fail(workerChild, card.id, 'dependency is down')
  expect(blocked.status).toBe('blocked')
  const failed = textOf(followup.mock.calls[0]![0] as { content: { type: string; text: string }[] })
  expect(failed).toContain('WORKER_FAILED ticket=' + card.id)
  expect(failed).toContain('state=in_progress/blocked')
  expect(failed).toContain('blocker="dependency is down"')
  expect(failed).toContain('taskboard_reassign')

  // A terminated worker is auto-redispatched: WORKER_REDISPATCHED ticket=...
  // state=in_progress/running anomaly=lost (worker terminated (...)).
  let settle!: (result: RunResultStub) => void
  const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
  const { service: service2, devA: devA2 } = await harness({ workerRunResults: [runResult] })
  await service2.claimMaster('default', devA2)
  const followup2 = vi.spyOn(devA2, 'followup')
  const silent = await createTicket(service2, 'compact silent worker')
  await scheduleToNotStarted(service2, devA2, silent)
  await service2.assign(devA2, silent.id)
  settle({ output: [], stopReason: 'aborted' })
  await vi.waitFor(async () => {
    expect((await service2.viewTicket(silent.id)).autoRetries).toBe(1)
  })
  const redispatched = textOf(followup2.mock.calls[0]![0] as { content: { type: string; text: string }[] })
  expect(redispatched).toContain('WORKER_REDISPATCHED ticket=' + silent.id)
  expect(redispatched).toContain('state=in_progress/running')
  expect(redispatched).toContain('anomaly=')
  expect(redispatched).toContain('lost')
  expect(redispatched).toContain('auto-redispatched')
})

it('notifies the master inbox when a worker reports failure', async () => {
  const { service, devA, workerChild } = await harness()
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const card = await createTicket(service, 'doomed card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  const blocked = await service.fail(workerChild, card.id, 'dependency is down')
  expect(blocked.status).toBe('blocked')
  expect(followup).toHaveBeenCalledTimes(1)
  const message = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
  expect(message.source.kind).toBe('taskboard')
  expect(textOf(message)).toContain(card.id)
  expect(textOf(message)).toContain('taskboard_reassign')
})

it('notifies the master inbox when the user schedules a card into Not started', async () => {
  const { service, devA } = await harness()
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  // A dependency that is already Done: the notice reports "all Done".
  const dep = await createTicket(service, 'dependency done')
  await service.moveRemote(devA, { ticketId: dep.id, column: 'done', beforeTicketId: null, afterTicketId: null })
  const card = await createTicket(service, 'scheduled card', [dep.id])
  await service.moveRemote(devA, { ticketId: card.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
  expect(followup).toHaveBeenCalledTimes(1)
  const message = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
  expect(message.source.kind).toBe('taskboard')
  expect(message.source.boardId).toBe('default')
  const text = textOf(message)
  expect(text).toContain('user scheduled ticket ' + card.id)
  expect(text).toContain('scheduled card')
  expect(text).toContain('priority normal')
  expect(text).toContain('type feature')
  expect(text).toContain('dependsOn')
  expect(text).toContain('all Done')
  expect(text).toContain('filesScope')
  expect(text).toContain('taskboard_assign')
  // The durable board notice records the same event for cold reads.
  const snapshot = await service.snapshot(devA)
  expect(snapshot.notices).toHaveLength(1)
  expect(snapshot.notices![0]).toMatchObject({ kind: 'user-scheduled', ticketId: card.id })
  expect(snapshot.notices![0]!.text).toContain(card.id)

  // A card whose dependency is still pending reports NOT all Done and names it.
  const depPending = await createTicket(service, 'dependency pending')
  const blocked = await createTicket(service, 'blocked scheduled', [depPending.id])
  await service.moveRemote(devA, { ticketId: blocked.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
  expect(followup.mock.calls.length).toBe(2)
  const secondMessage = followup.mock.calls[1]![0] as {
    content: { type: string; text: string }[]
    source: { kind: string; boardId: string }
  }
  const second = textOf(secondMessage)
  expect(second).toContain('NOT all Done')
  expect(second).toContain(depPending.id)
})

it("does not re-notify on the master's own move, a repeated move, or a card returning from In progress", async () => {
  const { service, devA } = await harness()
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  // Master-origin scheduling (the taskboard_move tool) never notifies: the
  // master already knows it scheduled the card.
  const masterCard = await createTicket(service, 'master scheduled')
  await service.moveAsMaster(devA, { ticketId: masterCard.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
  expect(followup).not.toHaveBeenCalled()
  // A user-origin schedule notifies exactly once; dragging the same card
  // within Not started does not re-notify.
  const card = await createTicket(service, 'user scheduled')
  await toNotStarted(service, devA, card)
  expect(followup).toHaveBeenCalledTimes(1)
  await toNotStarted(service, devA, card)
  expect(followup).toHaveBeenCalledTimes(1)
  // A card returning from In progress to Not started (reassign backlog) is
  // not a fresh user schedule either.
  await service.assign(devA, card.id)
  await service.moveRemote(devA, { ticketId: card.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
  expect(followup).toHaveBeenCalledTimes(1)
})

it('notifies the master when a worker run terminates without reporting', async () => {
  let settle!: (result: RunResultStub) => void
  const runResult = new Promise<RunResultStub>((resolve) => { settle = resolve })
  const { service, devA } = await harness({ workerRunResults: [runResult] })
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const card = await createTicket(service, 'silent worker')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  settle({ output: [], stopReason: 'aborted' })
  await vi.waitFor(async () => {
    const current = await service.viewTicket(card.id)
    expect(current.autoRetries).toBe(1)
  })
  expect(followup).toHaveBeenCalledTimes(1)
  const message = followup.mock.calls[0]![0] as { content: { type: string; text: string }[]; source: { kind: string; boardId: string } }
  expect(message.source.kind).toBe('taskboard')
  expect(textOf(message)).toContain('lost')
  expect(textOf(message)).toContain('auto-redispatched')
})

it('skips the master notice while the seat is vacant', async () => {
  const { service, devA, workerChild } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'vacant seat card')
  await toNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  await service.releaseMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.ticket.column).toBe('in_testing')
  expect(followup).not.toHaveBeenCalled()
})

it('skips the master notice when the master session is not loaded', async () => {
  const { service, workerChild } = await harness()
  const ghost = stubAgent('ghost-master')
  await service.claimMaster('default', ghost)
  const card = await createTicket(service, 'ghost seat card')
  await toNotStarted(service, ghost, card)
  await service.assign(ghost, card.id)
  const followup = vi.spyOn(ghost, 'followup')
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.ticket.column).toBe('in_testing')
  expect(followup).not.toHaveBeenCalled()
})
it('queues a master notice into the persisted session inbox when the master is absent from the registry and replays it on the next run', async () => {
  const persistence = fakeSessionPersistence()
  // The master session has a persisted log from the previous process (the
  // agent id is the persisted session id); a fresh log with no events keeps
  // the next seq at 0.
  persistence.stored.set(SessionId('dev-agent-a'), [])
  const { service, devA, workerChild, unregisterMaster } = await harness({ sessionPersistence: persistence })
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'persistent notice card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  // The master session leaves the live registry (host restart): the live
  // followup path cannot reach it, so the notice must be queued durably.
  unregisterMaster()
  const blocked = await service.fail(workerChild, card.id, 'backend down')
  expect(blocked.status).toBe('blocked')
  // One contiguous inbox splice was appended to the master's persisted log.
  expect(persistence.append).toHaveBeenCalledTimes(1)
  const [masterId, events] = persistence.append.mock.calls[0] as [string, SessionEvent[]]
  expect(masterId).toBe(devA.id)
  expect(events).toHaveLength(1)
  const splice = events[0]!
  expect(splice.type).toBe('agent/inbox/spliced')
  const data = splice.data as { target: string; start: number; inserted: { content: { text: string }[] }[] }
  expect(data.target).toBe('next-turn')
  expect(data.start).toBe(0)
  expect(JSON.stringify(data.inserted)).toContain(card.id)
  // The persisted splice carries the complete identified message that the
  // standard Inbox projection will expose on resume.
  const persisted = persistence.stored.get(devA.id)!
  const resumed = Session.create(SessionId(devA.id), persisted)
  const replayed = resumed.snapshotEvents().find(event => event.type === 'agent/inbox/spliced')
  expect(JSON.stringify(replayed?.data)).toContain(card.id)
  // The in-board fallback record landed too.
  const read = await service.boardNotices('default', devA)
  expect(read.notices).toHaveLength(1)
  expect(read.notices[0]).toMatchObject({ kind: 'worker-failed', ticketId: card.id })
  expect(read.notices[0]!.text).toContain(card.id)
})

it('records durable board notices readable via the claim result and the taskboard_notices tool', async () => {
  const { ctx, service, devA, workerChild } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'notice trail card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  await service.fail(workerChild, card.id, 'crashed')
  // The in-board fallback record carries the event with its stable kind.
  const read = await service.boardNotices('default', devA)
  expect(read.boardId).toBe('default')
  expect(read.notices).toHaveLength(1)
  expect(read.notices[0]).toMatchObject({ kind: 'worker-failed', ticketId: card.id })
  // A master re-claim carries the notices so nothing since the last look is missed.
  const claimed = await service.claimMaster('default', devA)
  expect(claimed.notices ?? []).toHaveLength(1)
  expect(claimed.notices?.[0]!.text).toContain(card.id)
  // The taskboard_notices tool reads them back.
  const toolResult = await ctx.tools.execute({
    callId: ToolCallId('tool-notices'),
    name: 'taskboard_notices',
    arguments: {},
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(toolResult.isError).toBe(false)
  type NoticeRow = { kind: string; text: string; at: number; ticketId: string }
  const value = (toolResult as { value: { boardId: string; notices: NoticeRow[] } }).value
  expect(value.boardId).toBe('default')
  expect(value.notices).toHaveLength(1)
  expect(value.notices[0]!.kind).toBe('worker-failed')
})

it('dedupes repeated notices for the same ticket and kind inside the window and notifies again after it', async () => {
  const { service, devA, unregisterWorker } = await harness({ noticeDedupeWindowMs: 60 })
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup')
  const card = await createTicket(service, 'dedupe card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  // First loss: one 'worker-redispatched' notice reaches the master.
  unregisterWorker()
  expect(await service.reconcileLostWorkers()).toBe(1)
  expect(followup).toHaveBeenCalledTimes(1)
  // Re-dispatch and lose the replacement worker inside the window: the same
  // (ticket, kind) notice is deduped — no second record, no second delivery.
  await service.reassign(devA, card.id, 'retry')
  unregisterWorker()
  expect(await service.reconcileLostWorkers()).toBe(1)
  const afterSecond = await service.boardNotices('default', devA)
  expect(afterSecond.notices).toHaveLength(1)
  expect(followup).toHaveBeenCalledTimes(1)
  // Past the window the same event notifies again.
  await new Promise(resolve => setTimeout(resolve, 80))
  await service.reassign(devA, card.id, 'retry')
  unregisterWorker()
  expect(await service.reconcileLostWorkers()).toBe(1)
  const afterThird = await service.boardNotices('default', devA)
  expect(afterThird.notices).toHaveLength(2)
  expect(followup).toHaveBeenCalledTimes(2)
})

it('never fails the triggering mutation when the notification path breaks', async () => {
  const persistence = fakeSessionPersistence()
  // The master session has a persisted log, but the delivery read explodes:
  // the notice must degrade silently and leave the mutation intact.
  persistence.stored.set(SessionId('dev-agent-a'), [])
  persistence.inspect.mockRejectedValueOnce(new Error('storage exploded'))
  const { service, devA, workerChild, unregisterMaster } = await harness({ sessionPersistence: persistence })
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'resilient card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  unregisterMaster()
  const blocked = await service.fail(workerChild, card.id, 'boom')
  expect(blocked.status).toBe('blocked')
  expect(blocked.failure?.reason).toBe('boom')
  // The durable board notice still landed before the delivery fault.
  const read = await service.boardNotices('default', devA)
  expect(read.notices).toHaveLength(1)
  expect(read.notices[0]!.kind).toBe('worker-failed')
})

it('records a notice even when no persistence backend is configured (board-only fallback)', async () => {
  const { service, workerChild } = await harness()
  const ghost = stubAgent('ghost-master')
  await service.claimMaster('default', ghost)
  const card = await createTicket(service, 'board fallback card')
  await scheduleToNotStarted(service, ghost, card)
  await service.assign(ghost, card.id)
  // The master is not live and no persistence backend exists: the notice
  // still lands on the board for later reads.
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.ticket.column).toBe('in_testing')
  const read = await service.boardNotices('default', ghost)
  expect(read.notices).toHaveLength(1)
  expect(read.notices[0]!.kind).toBe('worker-done')
})


it('never reports a wall-clock master lease on a board row (V3-25)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const { service, devA } = await harness()
    await service.claimMaster('default', devA)
    // Even long after any former lease would have expired the field stays null:
    // the seat has no deadline, only a liveness judgment.
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
    const row = (await service.listBoards(devA)).find(candidate => candidate.boardId === 'default')!
    expect(row.masterExpiresAt).toBeNull()
    expect(row.masterAgentId).toBe(devA.id)
    await service.releaseMaster('default', devA)
    const vacant = (await service.listBoards(devA)).find(candidate => candidate.boardId === 'default')!
    expect(vacant.masterExpiresAt).toBeNull()
    expect(vacant.masterAgentId).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('releases the master seat when the holder session leaves the registry (V3-25)', async () => {
  const { service, devA, unregisterMaster } = await harness()
  await service.claimMaster('default', devA)
  // The holding session vanishes from the live agent registry (host restart):
  // the same survival signal the worker lost path uses.
  unregisterMaster()
  expect(await service.reconcileMasterSeats()).toBe(1)
  const row = (await service.listBoards(devA)).find(candidate => candidate.boardId === 'default')!
  expect(row.masterAgentId).toBeNull()
  expect(row.masterClaimedAt).toBeNull()
  expect(row.masterExpiresAt).toBeNull()
  // A board history row records the release, with no successor taking the seat.
  const history = row.masterHistory ?? []
  expect(history).toHaveLength(2)
  expect(history[1]).toMatchObject({ fromAgentId: devA.id, toAgentId: '' })
  expect(history[1]!.notes).toContain('seat released')
  expect(history[1]!.notes).toContain('registry')
  // And a durable notice for the successor master landed on the board.
  expect(row.notices!).toHaveLength(1)
  expect(row.notices![0]).toMatchObject({ kind: 'master-released', ticketId: '' })
  expect(row.notices![0]!.text).toContain('MASTER_SEAT_RELEASED')
  expect(row.notices![0]!.text).toContain(devA.id)
  // A second pass finds nothing left to release (reentry-safe).
  expect(await service.reconcileMasterSeats()).toBe(0)
})

it('never releases a live master seat by elapsed time (V3-25)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    // The idle arm is off: nothing about elapsed time may free this seat.
    const { service, devA, devB } = await harness({ masterIdleTimeoutMs: 0 })
    await service.claimMaster('default', devA)
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000)
    // devA is still registered, so the rival claim is refused...
    await expect(service.claimMaster('default', devB)).rejects.toMatchObject({ code: 'TASKBOARD_MASTER_HELD' })
    // ...and the liveness pass releases nothing either.
    expect(await service.reconcileMasterSeats()).toBe(0)
    const row = (await service.listBoards(devB)).find(candidate => candidate.boardId === 'default')!
    expect(row.masterAgentId).toBe(devA.id)
  } finally {
    vi.useRealTimers()
  }
})

it('frees a registered but silent master seat only past the idle arm (V3-25)', async () => {
  /** Re-register the master id as a live session whose activity tail is old. */
  const standInStaleSession = (
    ctx: Awaited<ReturnType<typeof harness>>['ctx'], id: string, unregister: () => void,
  ) => {
    unregister()
    const stale = Session.create(SessionId(id), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: Date.now() - 60_000,
      isSeeded: false,
    })
    ctx.agents.register(stubAgentForSession(stale))
  }
  // Idle arm off (0): a registered holder keeps the seat however silent it is.
  const off = await harness({ masterIdleTimeoutMs: 0 })
  await off.service.claimMaster('default', off.devA)
  standInStaleSession(off.ctx, off.devA.id, off.unregisterMaster)
  expect(await off.service.reconcileMasterSeats()).toBe(0)
  expect((await off.service.listBoards(off.devA)).find(b => b.boardId === 'default')!.masterAgentId).toBe(off.devA.id)
  // Idle arm on: the same silent-but-registered holder is released.
  const on = await harness({ masterIdleTimeoutMs: 2000 })
  await on.service.claimMaster('default', on.devA)
  standInStaleSession(on.ctx, on.devA.id, on.unregisterMaster)
  expect(await on.service.reconcileMasterSeats()).toBe(1)
  const released = (await on.service.listBoards(on.devB)).find(b => b.boardId === 'default')!
  expect(released.masterAgentId).toBeNull()
  expect((released.masterHistory ?? []).at(-1)).toMatchObject({ fromAgentId: on.devA.id, toAgentId: '' })
  expect((released.masterHistory ?? []).at(-1)!.notes).toContain('idle')
  expect(released.notices!.at(-1)).toMatchObject({ kind: 'master-released' })
})

it('still hands the structured takeover snapshot to the successor after a liveness release (V3-25)', async () => {
  const { ctx, service, devA, devB, unregisterMaster } = await harness()
  await service.claimMaster('default', devA)
  const planned = await createTicket(service, 'planned card')
  const running = await createTicket(service, 'running card')
  await scheduleToNotStarted(service, devA, running)
  await service.assign(devA, running.id)
  unregisterMaster()
  expect(await service.reconcileMasterSeats()).toBe(1)
  // The explicit takeover entry point is unchanged: the successor's
  // taskboard_claim_master carries the complete structured snapshot.
  const claim = await ctx.tools.execute({
    callId: ToolCallId('tool-claim-after-liveness-release'),
    name: 'taskboard_claim_master',
    arguments: {},
    agent: devB,
    signal: new AbortController().signal,
  })
  expect(claim.isError).toBe(false)
  const value = (claim as { value: Record<string, unknown> }).value
  const cards = value.cards as { ticketId: string; column: string; status: string }[]
  expect(cards.map(card => card.ticketId).sort()).toEqual([planned.id, running.id].sort())
  expect(value.backlogSummary).toContain('Backlog 1')
  expect(value.backlogSummary).toContain('In progress 1')
  expect(value.pendingAdjudications).toEqual([])
  expect(value.handoverNotes).toBe('')
  // The release notice rides the successor's claim result.
  expect((value.notices as { kind: string }[]).map(n => n.kind)).toContain('master-released')
})

it('executes the taskboard_handover tool as the master and releases the seat', async () => {
  const { ctx, service, devA } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'tool handover card')
  await toNotStarted(service, devA, card)
  await service.assign(devA, card.id)

  const result = await ctx.tools.execute({
    callId: ToolCallId('tool-handover'),
    name: 'taskboard_handover',
    arguments: {},
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  const value = (result as { value: { boardId: string; masterAgentId: string | null; notes: string } }).value
  expect(value.boardId).toBe('default')
  expect(value.masterAgentId).toBeNull()
  expect(value.notes).toContain('tool handover card')
  // The rendered content reflects the released seat.
  const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(rendered).toContain('released with structured handover notes')
})

it('executes the taskboard_pause tool as the master and rejects a non-master', async () => {
  const { ctx, service, devA, devB, workerSignals } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'tool pause card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)

  const result = await ctx.tools.execute({
    callId: ToolCallId('tool-pause'),
    name: 'taskboard_pause',
    arguments: { ticketId: card.id, reason: 'tool-level pause' },
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  const value = (result as { value: { id: string; status: string } }).value
  expect(value.id).toBe(card.id)
  expect(value.status).toBe('paused')
  expect(workerSignals[0]!.aborted).toBe(true)
  const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(rendered).toContain('paused')

  // A non-master is rejected through the same tool.
  const denied = await ctx.tools.execute({
    callId: ToolCallId('tool-pause-denied'),
    name: 'taskboard_pause',
    arguments: { ticketId: card.id, reason: 'not the master' },
    agent: devB,
    signal: new AbortController().signal,
  })
  expect(denied.isError).toBe(true)
  expect((denied as { error: { message: string } }).error.message).toContain('master')
})

it('executes the taskboard_claim tool as the master and rejects a non-master (V3-7)', async () => {
  const { ctx, service, devA, devB } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'tool claim card')
  await toNotStarted(service, devA, card)

  // A non-master is rejected through the tool.
  const denied = await ctx.tools.execute({
    callId: ToolCallId('tool-claim-denied'),
    name: 'taskboard_claim',
    arguments: { ticketId: card.id },
    agent: devB,
    signal: new AbortController().signal,
  })
  expect(denied.isError).toBe(true)
  expect((denied as { error: { message: string } }).error.message).toContain('master')

  // The master claims through the same tool.
  const result = await ctx.tools.execute({
    callId: ToolCallId('tool-claim'),
    name: 'taskboard_claim',
    arguments: { ticketId: card.id },
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  const value = (result as { value: { id: string; column: string } }).value
  expect(value.id).toBe(card.id)
  expect(value.column).toBe('in_progress')
  const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(rendered).toContain('claimed')
})

it('rejects the taskboard_assign tool for a subagent-origin caller', async () => {
  const { ctx, service, devA } = await harness()
  const subagent = stubAgentForSession(Session.create(SessionId('spawned-tool-child'), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('spawned-tool-child'),
    createdAt: Date.now(),
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
  }))
  await service.claimMaster('default', devA)
  const ticket = await createTicket(service, 'tool root guard')
  await toNotStarted(service, devA, ticket)

  const result = await ctx.tools.execute({
    callId: ToolCallId('tool-assign'),
    name: 'taskboard_assign',
    arguments: { ticketId: ticket.id },
    agent: subagent,
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(true)
  expect((result as { error: { message: string } }).error.message).toContain('top-level session agent')
  // The top-level master still dispatches through the same tool.
  const ok = await ctx.tools.execute({
    callId: ToolCallId('tool-assign-ok'),
    name: 'taskboard_assign',
    arguments: { ticketId: ticket.id },
    agent: devA,
    signal: new AbortController().signal,
  })
  expect(ok.isError).toBe(false)
  expect((ok as { value: { worker: string } }).value.worker).toBe('spawned')
})

it('closes the dispatch turn in the return text itself: assign + every reassign branch carry the V3-29 contract', async () => {
  const renderedText = (result: { content: { type: string; text?: string }[] }): string =>
    result.content.map(block => block.type === 'text' ? (block.text ?? '') : '').join('')
  const h = await harness({ continuable: true })
  await h.service.claimMaster('default', h.devA)
  const card = await createTicket(h.service, 'contract card')
  await scheduleToNotStarted(h.service, h.devA, card)
  // Branch 1 — assign spawns a worker.
  const assigned = await h.ctx.tools.execute({
    callId: ToolCallId('v329-assign'), name: 'taskboard_assign',
    arguments: { ticketId: card.id }, agent: h.devA, signal: new AbortController().signal,
  })
  expect(assigned.isError).toBe(false)
  expect(renderedText(assigned)).toContain(DISPATCH_TURN_END)
  // Branch 2 — reassign "continue" wakes the existing worker session.
  await h.service.pause(h.devA, card.id, 'hold on')
  const continued = await h.ctx.tools.execute({
    callId: ToolCallId('v329-continue'), name: 'taskboard_reassign',
    arguments: { ticketId: card.id, action: 'continue' }, agent: h.devA, signal: new AbortController().signal,
  })
  expect(continued.isError).toBe(false)
  expect(renderedText(continued)).toContain(DISPATCH_TURN_END)
  // Branch 3 — reassign "retry" spawns a fresh worker.
  await h.service.fail(h.workerChild, card.id, 'stuck on a missing fixture')
  const retried = await h.ctx.tools.execute({
    callId: ToolCallId('v329-retry'), name: 'taskboard_reassign',
    arguments: { ticketId: card.id, action: 'retry' }, agent: h.devA, signal: new AbortController().signal,
  })
  expect(retried.isError).toBe(false)
  expect(renderedText(retried)).toContain(DISPATCH_TURN_END)
  // Branch 4 — reassign "backlog" returns the card to Not started.
  const backlogged = await h.ctx.tools.execute({
    callId: ToolCallId('v329-backlog'), name: 'taskboard_reassign',
    arguments: { ticketId: card.id, action: 'backlog' }, agent: h.devA, signal: new AbortController().signal,
  })
  expect(backlogged.isError).toBe(false)
  expect(renderedText(backlogged)).toContain(DISPATCH_TURN_END)
  // Branch 5 — an assign that spawns no worker still closes the turn.
  const blockedRun = await harness({ spawn: 'fail' })
  await blockedRun.service.claimMaster('default', blockedRun.devA)
  const blockedCard = await createTicket(blockedRun.service, 'blocked contract card')
  await scheduleToNotStarted(blockedRun.service, blockedRun.devA, blockedCard)
  const blocked = await blockedRun.ctx.tools.execute({
    callId: ToolCallId('v329-assign-blocked'), name: 'taskboard_assign',
    arguments: { ticketId: blockedCard.id }, agent: blockedRun.devA, signal: new AbortController().signal,
  })
  expect(blocked.isError).toBe(false)
  expect(renderedText(blocked)).toContain(DISPATCH_TURN_END)
  // The contract is one line appended to the branch text, never duplicated.
  const assignedText = renderedText(assigned)
  expect(assignedText).toContain('dispatched')
  expect(assignedText.indexOf(DISPATCH_TURN_END)).toBe(assignedText.lastIndexOf(DISPATCH_TURN_END))
})

it('skips the master notice when the agent registry is absent', async () => {
  const { ctx, service, devA, workerChild } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'no registry card')
  await toNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  const followup = vi.spyOn(devA, 'followup')
  Object.defineProperty(ctx, 'agents', { value: undefined, configurable: true })
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.ticket.column).toBe('in_testing')
  expect(followup).not.toHaveBeenCalled()
})

it('keeps report and fail alive when the master notice delivery throws', async () => {
  const { service, devA, workerChild, reviewerChild } = await harness()
  await service.claimMaster('default', devA)
  const followup = vi.spyOn(devA, 'followup').mockImplementation(() => {
    throw new Error('inbox down')
  })
  // A throwing notification must not rob the card of its reviewer: the
  // reviewer is spawned before the notice and the notice fault is swallowed.
  const card = await createTicket(service, 'notice storm card')
  await scheduleToNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.review).toBe('spawned')
  expect(reported.ticket.reviewer?.agentId).toBe(reviewerChild.id)
  expect(followup).toHaveBeenCalledTimes(1)
  // fail() must land the blocked mutation even when its notice throws.
  const doomed = await createTicket(service, 'notice storm doomed')
  await scheduleToNotStarted(service, devA, doomed)
  await service.assign(devA, doomed.id)
  const blocked = await service.fail(workerChild, doomed.id, 'dependency is down')
  expect(blocked.status).toBe('blocked')
  expect(blocked.failure?.reason).toBe('dependency is down')
  expect(followup).toHaveBeenCalledTimes(2)
})

it('surfaces the real reviewer spawn failure on the card history', async () => {
  const { service, devA, workerChild } = await harness({ failReviewerSpawn: true })
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'opaque spawn failure')
  await toNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.review).toBe('failed')
  expect(reported.reviewerAgentId).toBeNull()
  const current = await service.viewTicket(card.id)
  const failureRow = current.history.find(row => row.kind === 'review-spawn-failed')
  expect(failureRow).toBeDefined()
  expect(failureRow?.detail).toContain('reviewer spawn exploded')
  // requestReviewRemote keeps its message but appends the real cause.
  await expect(service.requestReviewRemote(devA, { ticketId: card.id, boardId: 'default' }))
    .rejects.toMatchObject({ message: expect.stringContaining('no reviewer backend is available to assign: reviewer spawn exploded') })
})

it('returns the current state for repeated fail and repeated report by the same worker', async () => {
  const { service, devA, workerChild, reviewerChild, subagentsStart } = await harness()
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'idempotent card')
  await toNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  // The first report moves the card to In testing and spawns the reviewer.
  const first = await service.report(workerChild, card.id, 'implemented once')
  expect(first.review).toBe('spawned')
  // A repeated report by the same worker returns the current state and does
  // not append another report row or spawn a second reviewer.
  const again = await service.report(workerChild, card.id, 'implemented twice')
  expect(again.ticket.column).toBe('in_testing')
  expect(again.ticket.reviewer?.agentId).toBe(reviewerChild.id)
  const historyAfter = await service.viewTicket(card.id)
  expect(historyAfter.history.filter(row => row.kind === 'report')).toHaveLength(1)
  expect(subagentsStart.mock.calls.filter(([, request]) =>
    (request as SubagentStartRequest).label?.startsWith('review '),
  )).toHaveLength(1)
  // fail idempotency: a second fail on the blocked card returns it untouched.
  const doomed = await createTicket(service, 'idempotent doomed')
  await toNotStarted(service, devA, doomed)
  await service.assign(devA, doomed.id)
  const blocked = await service.fail(workerChild, doomed.id, 'broken once')
  expect(blocked.status).toBe('blocked')
  const blockedAgain = await service.fail(workerChild, doomed.id, 'broken twice')
  expect(blockedAgain.status).toBe('blocked')
  expect(blockedAgain.failure?.reason).toBe('broken once')
  const doomedHistory = await service.viewTicket(doomed.id)
  expect(doomedHistory.history.filter(row => row.kind === 'fail')).toHaveLength(1)
})

it('downgrades unsupported reviewer capabilities instead of failing the spawn', async () => {
  const { service, devA, workerChild, subagentsStart } = await harness({
    reviewMode: 'report',
    providerCapabilities: { agentOptions: false, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
  })
  await service.claimMaster('default', devA)
  const card = await createTicket(service, 'capability downgrade card')
  await toNotStarted(service, devA, card)
  await service.assign(devA, card.id)
  const reported = await service.report(workerChild, card.id, 'implemented')
  expect(reported.review).toBe('spawned')
  const workerCall = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
  expect(workerCall[1].agentOptions).toBeUndefined()
  expect(workerCall[1].toolFilter).toBeUndefined()
  const reviewCall = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
  expect(reviewCall[1].agentOptions).toBeUndefined()
  expect(reviewCall[1].outputSchema).toBeUndefined()
  expect(reviewCall[1].toolFilter).toBeUndefined()
  // The degraded prompt explains the no-schema report fallback.
  const prompt = (reviewCall[1].prompt as { type: string; text: string }[])[0]!.text
  expect(prompt).toContain('does not support structured output')
})

it('builds handover notes covering every card state and the empty history', () => {
  const board = {
    boardId: 'default', name: 'default', workspaceId: '', scope: 'project' as const,
    ownerSessionId: null, masterAgentId: null, masterClaimedAt: null, masterExpiresAt: null,
    handoverNotes: '', archivedAt: null,
  }
  const at = 1000
  const base: TicketView = {
    id: 'ticket-x', title: 'x', description: 'x', column: 'backlog', priority: 'normal',
    boardId: 'default', type: 'feature', status: 'ready', failure: null, autoRetries: 0,
    createdAt: at, updatedAt: at, position: 0, assignee: null, reviewer: null,
    reviewAttempts: 0, lastReview: null, reviewOutcome: null, devNotes: '',
    targetBranch: '', filesScope: '', dependsOn: [], history: [],
  }
  const backlog = { ...base, id: 'ticket-backlog', title: 'planned', column: 'backlog' as const, dependsOn: ['ticket-done'] }
  const notStarted = { ...base, id: 'ticket-next', title: 'next up', column: 'not_started' as const, dependsOn: ['ticket-done'] }
  const claimed = { ...base, id: 'ticket-claimed', title: 'claimed card', column: 'in_progress' as const, status: 'claimed' as const }
  const sessionlessWorker = {
    ...base, id: 'ticket-sessionless', title: 'sessionless worker', column: 'in_progress' as const,
    status: 'running' as const, workerAgentId: 'worker-solo',
  }
  const blocked = {
    ...base, id: 'ticket-blocked', title: 'blocked card', column: 'in_progress' as const, status: 'blocked' as const,
    workerAgentId: 'worker-1', workerSessionId: 'worker-1', failure: { reason: 'infra down', at },
  }
  const vacantReview = {
    ...base, id: 'ticket-vacant', title: 'vacant seat', column: 'in_testing' as const, status: 'claimed' as const,
    reviewAttempts: 2,
  }
  const verdict = {
    ...base, id: 'ticket-verdict', title: 'verdict card', column: 'in_testing' as const, status: 'claimed' as const,
    reviewer: { agentId: 'reviewer-1', label: 'reviewer 1' }, reviewAttempts: 3,
    reviewOutcome: { verdict: 'approve' as const, summary: 'ok', problems: [], at },
  }
  const done = { ...base, id: 'ticket-done', title: 'finished', column: 'done' as const, status: 'claimed' as const }

  const notes = buildHandoverNotes(board, [claimed, sessionlessWorker, blocked, verdict, done, vacantReview, backlog, notStarted])
  expect(notes).toContain('# Taskboard handover — board "default"')
  expect(notes).toContain('## Backlog (1)')
  expect(notes).toContain('ticket-backlog "planned" [feature, normal] — depends on ticket-done')
  expect(notes).toContain('## Not started (1)')
  expect(notes).toContain('ticket-next "next up"')
  expect(notes).toContain('## In progress (3)')
  expect(notes).toContain('ticket-claimed "claimed card" [feature, normal] — status claimed')
  expect(notes).toContain('ticket-sessionless "sessionless worker" [feature, normal] — status running; worker worker-solo (session )')
  expect(notes).toContain('ticket-blocked "blocked card" [feature, normal] — status blocked; worker worker-1 (session worker-1); failure: infra down')
  expect(notes).toContain('## In testing (2)')
  expect(notes).toContain('ticket-vacant "vacant seat" [feature, normal] — review attempt 3; review seat vacant')
  expect(notes).toContain('ticket-verdict "verdict card" [feature, normal] — review attempt 4; reviewer reviewer-1; verdict approve awaiting resolve')
  expect(notes).toContain('## Done (1)')
  expect(notes).toContain('ticket-done "finished"')
  expect(notes).toContain('## Master history')
  expect(notes).toContain('(no seat transitions yet)')
  // A history carrying transition notes renders them on their rows.
  const withHistory = buildHandoverNotes({ ...board, masterHistory: [{ fromAgentId: null, toAgentId: 'agent-two', at: 2000, notes: 'board state: two cards' }] }, [done])
  expect(withHistory).toContain('agent-two')
  expect(withHistory).toContain('board state: two cards')
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
describe('V3-28 continuable dispatch and wake-up recovery', () => {
  /** One stubbed continuable start spec as the fake seam receives it. */
  interface StartedSpec {
    provider: string
    label: string
    request: {
      prompt: { type: string; text: string }[]
      outputSchema?: unknown
      toolFilter?: { deny?: string[] }
    }
  }

  it('dispatches the worker through startContinuable (provider stays "spawn") and records the durable child session', async () => {
    const h = await harness({ continuable: true })
    await h.service.claimMaster('default', h.devA)
    const card = await createTicket(h.service, 'continuable dispatch')
    await scheduleToNotStarted(h.service, h.devA, card)
    const assigned = await h.service.assign(h.devA, card.id)
    expect(h.subagentsStart).not.toHaveBeenCalled()
    expect(h.subagentsStartContinuable).toHaveBeenCalledTimes(1)
    const spec = h.subagentsStartContinuable.mock.calls[0]![0] as StartedSpec
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe(card.title)
    // A durable child can never carry the one-shot structured-output contract.
    expect(spec.request.outputSchema).toBeUndefined()
    expect(assigned.worker).toBe('spawned')
    const current = await h.service.viewTicket(card.id)
    expect(current.status).toBe('running')
    expect(current.workerAgentId).toBe('worker-child-agent')
    expect(current.workerSessionId).toBe('worker-child-agent')
  })

  it('wakes the recorded child session when the worker is judged lost — no replacement is spawned', async () => {
    const h = await harness({ continuable: true })
    await h.service.claimMaster('default', h.devA)
    const followup = vi.spyOn(h.devA, 'followup')
    const card = await createTicket(h.service, 'wake me instead of respawning')
    await scheduleToNotStarted(h.service, h.devA, card)
    await h.service.assign(h.devA, card.id)
    // The worker session vanishes (host restart / hard death).
    h.unregisterWorker()
    expect(await h.service.reconcileLostWorkers()).toBe(1)
    expect(h.subagentsSendMessage).toHaveBeenCalledTimes(1)
    const call = h.subagentsSendMessage.mock.calls[0] as unknown as [Agent, string, { type: string; text: string }[]]
    // The sender is the exact live master agent (sendMessage's live-sender
    // requirement) and the target is the same child session the card records.
    expect(call[0]).toBe(h.devA)
    expect(call[1]).toBe('worker-child-agent')
    const message = call[2].map(part => part.text).join('')
    expect(message).toContain(card.id)
    expect(message).toContain(card.title)
    expect(message).toContain('续做勿回滚')
    expect(message).toContain('Why you were woken')
    // No second start: the durable session was woken in place.
    expect(h.subagentsStartContinuable).toHaveBeenCalledTimes(1)
    expect(h.subagentsStart).not.toHaveBeenCalled()
    const current = await h.service.viewTicket(card.id)
    expect(current.status).toBe('running')
    expect(current.failure).toBeNull()
    expect(current.workerSessionId).toBe('worker-child-agent')
    expect(current.autoRetries).toBe(1)
    expect(current.description).toContain('续做勿回滚')
    // History and the master notice both record a wake, not a re-spawn.
    expect(current.history.some(row => row.detail.startsWith('woken to continue after'))).toBe(true)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(textOf(followup.mock.calls[0]![0] as { content: { type: string; text: string }[] })).toContain('WORKER_CONTINUED')
    const notice = (await h.service.snapshot(h.devA)).notices?.at(-1)
    expect(notice).toMatchObject({ kind: 'worker-continued', ticketId: card.id })
  })

  it('degrades to a fresh spawn when the wake is refused, and stays one-shot when the provider cannot resume', async () => {
    // A seam that exposes startContinuable but whose sendMessage refuses the
    // wake (no continuation state for that child): recovery falls back.
    const refused = await harness({
      continuable: true,
      sendMessageError: 'subagent has no supported continuation state',
      workerSpawnIds: ['worker-child-agent', 'worker-child-2'],
    })
    await refused.service.claimMaster('default', refused.devA)
    const card = await createTicket(refused.service, 'refused wake')
    await scheduleToNotStarted(refused.service, refused.devA, card)
    await refused.service.assign(refused.devA, card.id)
    refused.unregisterWorker()
    expect(await refused.service.reconcileLostWorkers()).toBe(1)
    expect(refused.subagentsSendMessage).toHaveBeenCalledTimes(1)
    // The fallback is a fresh child (a new durable session), never the one the
    // refused wake targeted.
    expect(refused.subagentsStartContinuable).toHaveBeenCalledTimes(2)
    expect(refused.subagentsStart).not.toHaveBeenCalled()
    const spawned = await refused.service.viewTicket(card.id)
    expect(spawned.status).toBe('running')
    expect(spawned.autoRetries).toBe(1)
    expect(spawned.workerSessionId).toBe('worker-child-2')
    expect(spawned.description).toContain('auto-redispatch #1')
    // A provider without prepareContinuable keeps the historic one-shot path
    // end to end — including recovery, which never tries to wake.
    const oneShot = await harness({ continuable: true, providerSupportsContinuable: false })
    await oneShot.service.claimMaster('default', oneShot.devA)
    const card2 = await createTicket(oneShot.service, 'one shot provider')
    await scheduleToNotStarted(oneShot.service, oneShot.devA, card2)
    await oneShot.service.assign(oneShot.devA, card2.id)
    expect(oneShot.subagentsStart).toHaveBeenCalledTimes(1)
    expect(oneShot.subagentsStartContinuable).not.toHaveBeenCalled()
    oneShot.unregisterWorker()
    expect(await oneShot.service.reconcileLostWorkers()).toBe(1)
    // The wake is refused (the child has no continuation state) and the
    // recovery degrades to the historic spawn.
    expect(oneShot.subagentsSendMessage).toHaveBeenCalledTimes(1)
    expect(oneShot.subagentsStart).toHaveBeenCalledTimes(2)
  })

  it('spawns the report-mode reviewer through startContinuable and lands its verdict through taskboard_review_verdict', async () => {
    const h = await harness({ continuable: true })
    await h.service.claimMaster('default', h.devA)
    const card = await createTicket(h.service, 'continuable review')
    await toNotStarted(h.service, h.devA, card)
    await h.service.assign(h.devA, card.id)
    const reported = await h.service.report(h.workerChild, card.id, 'implemented and tested')
    expect(reported.review).toBe('spawned')
    expect(reported.reviewerAgentId).toBe('reviewer-child-agent')
    expect(h.subagentsStartContinuable).toHaveBeenCalledTimes(2)
    const spec = h.subagentsStartContinuable.mock.calls[1]![0] as StartedSpec
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('review ' + card.id)
    // A continuable reviewer cannot return a run result / structured output, so
    // its verdict travels through the reviewer-facing tool instead.
    expect(spec.request.outputSchema).toBeUndefined()
    const prompt = spec.request.prompt.map(part => part.text).join('')
    expect(prompt).toContain('taskboard_review_verdict')
    expect(prompt).toContain(card.id)
    expect(spec.request.toolFilter?.deny).toContain('taskboard_approve')
    // Only the designated reviewer seat may land a verdict.
    await expect(h.service.submitReviewVerdict(h.workerChild, card.id, 'approve', 'sneaky', []))
      .rejects.toMatchObject({ code: 'TASKBOARD_NOT_REVIEWER' })
    const landed = await h.service.submitReviewVerdict(h.reviewerChild, card.id, 'reject', 'the parse path is broken', ['fix the parse() path'])
    expect(landed.reviewOutcome).toMatchObject({ verdict: 'reject' })
    expect((await h.service.viewTicket(card.id)).reviewOutcome).toMatchObject({ verdict: 'reject' })
    // The reviewer never moves the card; the master resolves it as before.
    expect((await h.service.viewTicket(card.id)).column).toBe('in_testing')
    const result = await h.service.resolveReview(h.devA, card.id, 'approve', 'verified after rework', [])
    expect(result.action).toBe('approved')
    expect(result.ticket.column).toBe('done')
  })

  it('taskboard_reassign action "continue" wakes a paused or blocked card into the same worker session', async () => {
    const h = await harness({ continuable: true })
    await h.service.claimMaster('default', h.devA)
    const card = await createTicket(h.service, 'resume by waking')
    await scheduleToNotStarted(h.service, h.devA, card)
    await h.service.assign(h.devA, card.id)
    await h.service.pause(h.devA, card.id, 'hold on')
    expect((await h.service.viewTicket(card.id)).status).toBe('paused')
    const resumed = await h.service.reassign(h.devA, card.id, 'continue')
    expect(resumed.worker).toBe('continued')
    expect(resumed.workerAgentId).toBe('worker-child-agent')
    expect(resumed.ticket.status).toBe('running')
    expect(resumed.ticket.workerSessionId).toBe('worker-child-agent')
    expect(resumed.ticket.history.at(-1)?.detail).toContain('master woke the existing worker session')
    expect(h.subagentsSendMessage).toHaveBeenCalledTimes(1)
    expect(h.subagentsStart).not.toHaveBeenCalled()
    // A blocked card is woken the same way: the failure record clears and the
    // recorded session identity is untouched.
    await h.service.fail(h.workerChild, card.id, 'stuck on a missing fixture')
    expect((await h.service.viewTicket(card.id)).status).toBe('blocked')
    const back = await h.service.reassign(h.devA, card.id, 'continue')
    expect(back.worker).toBe('continued')
    expect(back.ticket.status).toBe('running')
    expect(back.ticket.failure).toBeNull()
    expect(back.ticket.workerSessionId).toBe('worker-child-agent')
    expect(h.subagentsSendMessage).toHaveBeenCalledTimes(2)
    expect(h.subagentsStart).not.toHaveBeenCalled()
  })
})
