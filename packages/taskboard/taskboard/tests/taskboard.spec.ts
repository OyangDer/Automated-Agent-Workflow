/**
 * Domain-level acceptance of the taskboard workflow: creation, user moves,
 * agent claims (owner/capacity/dependency rules), review spawning, approve,
 * reject-and-rework, the reviewer fallback, and edit/remove validations.
 * Runs against the real storage-domain facility with a temp JSON backend and
 * a stubbed subagent seam.
 */
import { mkdtemp, rm } from 'node:fs/promises'
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

/** How the stubbed subagent seam answers one reviewer spawn. */
type SpawnBehavior = 'spawn' | 'fail' | 'absent'

interface Harness {
  ctx: Context
  service: TaskboardService
  root: string
  changes: TaskboardChanged[]
  devA: Agent
  devB: Agent
  reviewerChild: Agent
  spawnedReviewerId: string
}

/** Compose the real storage chain plus the taskboard service with stubs. */
async function harness(options: { maxInProgress?: number; spawn?: SpawnBehavior } = {}): Promise<Harness> {
  const { maxInProgress = 2, spawn = 'spawn' } = options
  const root = await mkdtemp(join(tmpdir(), 'taskboard-'))
  openRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const spawnedReviewerId = 'reviewer-child-agent'
  if (spawn === 'spawn') {
    ctx.provide('subagents', {
      start: vi.fn(async () => ({ id: spawnedReviewerId })),
    } as never)
  } else if (spawn === 'fail') {
    ctx.provide('subagents', {
      start: vi.fn(async () => {
        throw new Error('spawn exploded')
      }),
    } as never)
  }
  await ctx.plugin(TaskboardService, { maxInProgress })
  const service = ctx.taskboard
  const changes: TaskboardChanged[] = []
  ctx.on('taskboard/changed', change => changes.push(change))
  const devA = stubAgent('dev-agent-a')
  const devB = stubAgent('dev-agent-b')
  const reviewerChild = stubAgent(spawnedReviewerId)
  ctx.agents.register(devA)
  ctx.agents.register(devB)
  ctx.agents.register(reviewerChild)
  return { ctx, service, root, changes, devA, devB, reviewerChild, spawnedReviewerId }
}

/** Temp storage roots created by the harnesses, cleaned between cases. */
const openRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(openRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createTicket(service: TaskboardService, title: string, dependsOn: string[] = []): Promise<TicketView> {
  return await service.createRemote({ title, description: 'describe ' + title, priority: 'normal', dependsOn })
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
    const { service } = await harness()
    const first = await createTicket(service, 'first feature')
    const second = await createTicket(service, 'second feature')
    const snapshot = await service.snapshot()
    expect(snapshot.tickets.map(ticket => ticket.column)).toEqual(['backlog', 'backlog'])
    expect(snapshot.tickets.map(ticket => ticket.id)).toEqual([first.id, second.id])
    expect(first.column).toBe('backlog')
    expect(first.assignee).toBeNull()
  })

  it('emits a forwarded change per mutation and a tombstone on removal', async () => {
    const { service, changes } = await harness()
    const ticket = await createTicket(service, 'to remove')
    expect(changes.at(-1)).toMatchObject({ operation: 'create', ticketId: ticket.id })
    const result = await service.removeRemote({ ticketId: ticket.id })
    expect(result.removedId).toBe(ticket.id)
    expect(changes.at(-1)).toEqual({ operation: 'remove', ticketId: ticket.id, ticket: null })
    await expect(service.removeRemote({ ticketId: ticket.id })).rejects.toMatchObject({ code: 'TASKBOARD_TICKET_NOT_FOUND' })
  })

  it('claims a Not started ticket and enforces ownership and capacity', async () => {
    const { service, devA, devB } = await harness()
    const ticket = await createTicket(service, 'parallel one')
    await toNotStarted(service, devA, ticket)
    const claimed = await claimTicket(service, devA, ticket)
    expect(claimed.column).toBe('in_progress')
    expect(claimed.assignee?.agentId).toBe(devA.id)
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
    const rows = (await service.snapshot()).tickets.filter(ticket => ticket.column === 'not_started')
    expect(rows.map(ticket => ticket.id)).toEqual([second.id, first.id, third.id])
    expect(rows[1]!.position).toBeGreaterThan(rows[0]!.position)
    expect(rows[1]!.position).toBeLessThan(rows[2]!.position)
  })
})

describe('column vocabulary', () => {
  it('exposes the five canonical columns in order', () => {
    expect(TASKBOARD_COLUMNS).toEqual(['backlog', 'not_started', 'in_progress', 'in_testing', 'done'])
  })
})
