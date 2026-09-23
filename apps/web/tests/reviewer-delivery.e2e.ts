// V6-14 acceptance: the reviewer a card seats must hang under the board MASTER,
// so the master can message (or wake) it. The reported failure was
//   subagent "<id>" belongs to another parent session
// when the master sent a message to the reviewer of its own In testing card —
// the report path had spawned that child under the reporting WORKER instead.
// This runs the real composition, seats a reviewer through the report path, and
// delivers a master-side message; a worker-side delivery is the negative control
// that keeps the old error reachable (so "no error" means "wrong parent gone",
// not "the seam stopped checking").
import { mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./reviewer-delivery.overlay.yml', import.meta.url))
const ANCHORS = [
  fileURLToPath(new URL('../../../packages/taskboard/taskboard/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/client/ui-taskboard/package.json', import.meta.url)),
]
const HOME = join(tmpdir(), 'v614-home-' + String(process.pid))

/** The Host slice this acceptance drives. */
interface Host {
  taskboard: {
    claimMaster(boardId: string, agent: unknown): Promise<unknown>
    createRemote(agent: unknown, request: Record<string, unknown>): Promise<{ id: string }>
    moveAsMaster(agent: unknown, request: Record<string, unknown>): Promise<unknown>
    assign(agent: unknown, ticketId: string): Promise<{ workerAgentId?: string }>
    report(agent: unknown, ticketId: string, notes: string): Promise<unknown>
    viewTicket(ticketId: string): Promise<{ reviewer: { agentId: string } | null }>
  }
  subagents: {
    sendMessage(parent: unknown, sessionId: string, content: readonly unknown[], options: { signal: AbortSignal }): Promise<unknown>
  }
  agents: { get(id: never): unknown; list(): unknown[] }
}

/**
 * Link the two plugin packages into the profile the scaffold boots: this
 * worktree's install-anchor step leaves `profiles/scaffold/node_modules` empty,
 * so the Loader cannot import either layer by name.
 * @param home - the harness home whose scaffold profile receives the links.
 */
function linkPluginLayers(home: string): void {
  const target = join(home, 'profiles', 'scaffold', 'node_modules', '@deepseek-ai')
  mkdirSync(target, { recursive: true })
  for (const name of ['dsh-taskboard', 'dsh-client-ui-taskboard']) {
    const source = fileURLToPath(new URL('../../../packages/' + (name === 'dsh-taskboard' ? 'taskboard/taskboard' : 'client/ui-taskboard'), import.meta.url))
    try {
      symlinkSync(source, join(target, name), 'junction')
    } catch {
      // Already linked.
    }
  }
}

it('delivers a master message to the reviewer its card seated (V6-14)', async () => {
  linkPluginLayers(HOME)
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAY, extraInstallAnchors: ANCHORS, harnessHome: HOME,
  })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const host = scaffold.ctx as unknown as Host
    const master = scaffold.ctx.agents.list()[0] as { id: string } | undefined
    if (master === undefined) throw new Error('the connected workspace created no Agent')
    await host.taskboard.claimMaster('default', master)
    const card = await host.taskboard.createRemote(master, {
      title: 'v614 reviewer delivery', description: 'seat a reviewer through the report path',
      priority: 'normal', dependsOn: [], boardId: 'default',
    })
    await host.taskboard.moveAsMaster(master, {
      ticketId: card.id, column: 'not_started', beforeTicketId: null, afterTicketId: null,
    })
    const assigned = await host.taskboard.assign(master, card.id)
    const worker = assigned.workerAgentId === undefined ? undefined : host.agents.get(assigned.workerAgentId as never)
    if (worker === undefined) throw new Error('the assigned worker is not registered')
    // The report path is where the reviewer used to be spawned under the WORKER.
    await host.taskboard.report(worker, card.id, 'implemented')
    const seated = await host.taskboard.viewTicket(card.id)
    const reviewerId = seated.reviewer?.agentId ?? ''
    expect(reviewerId).not.toBe('')
    // The master OWNS this child: the delivery must go through.
    const signal = new AbortController().signal
    await host.subagents.sendMessage(master, reviewerId, [{ type: 'text', text: 'status?' }], { signal })
    // Negative control: the worker must NOT be accepted as the sender, so the
    // old failure mode is still observable when the parent is wrong.
    let wrongParent = ''
    try {
      await host.subagents.sendMessage(worker, reviewerId, [{ type: 'text', text: 'status?' }], { signal })
    } catch (error: unknown) {
      wrongParent = error instanceof Error ? error.message : String(error)
    }
    console.log('[v614] reviewer=' + reviewerId + ' master=' + master.id
      + ' | master delivery ok | worker delivery: ' + (wrongParent === '' ? 'ACCEPTED (unexpected)' : wrongParent))
    // The master's delivery went through and the worker's was refused: the child
    // belongs to the master. (The refusal copy depends on the seam's identity
    // checks, so the assertion pins "refused", not one exact sentence.)
    expect(wrongParent).not.toBe('')
    // Drain before teardown: the real seated reviewer owns an inbox projection,
    // and disposing the tree while its continuation is still settling surfaces
  } finally {
    // Drain the continuable descendants (the reviewer this run seated, plus the
    // worker) BEFORE the tree goes away: disposing while a continuable
    // activation is still settling surfaces as an unhandled rejection —
    // "agent … cannot read inbox state: its projection registration is not
    // active" (ContinuableActivationRegistry.settlementState → SubagentInbox).
    const subagents = (scaffold.ctx as unknown as {
      subagents?: { drainContinuableDescendants?(parents: readonly unknown[]): Promise<void> }
    }).subagents
    await subagents?.drainContinuableDescendants?.(scaffold.ctx.agents.list()).catch(() => {})
    await browser.close()
    await scaffold.close()
  }
}, 300_000)
