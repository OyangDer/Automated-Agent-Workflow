// V6-12 acceptance: the runaway review seat, reproduced in the real Host
// composition across a restart. Boot 1 seats a reviewer through the real path
// (requestReview); the Host is then disposed and boot 2 comes up on the SAME
// harness home and session root, so the reviewer survives only as a stored
// session record while the live registry is empty — the exact pair the probe
// found in production, where the old liveness pass judged the holder neither
// lost (a record exists) nor stale (nothing registered to time) and the seat
// stayed claimed forever. The assertions are the card's: the seat survives the
// restart, nothing is released inside the staleness window, the pass then
// releases it as *stale* (the record kept the seat, the clock freed it), and
// taskboard_claim_review takes it afterwards.
import { mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./taskboard-review-seat.overlay.yml', import.meta.url))
// The plugin packages are not root dependencies, so each boot installs them by
// manifest the way `dsh plugin add` does.
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/taskboard/taskboard/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/client/ui-taskboard/package.json', import.meta.url)),
]

/** One ticket row as this smoke reads it. */
interface SmokeTicket {
  readonly id: string
  readonly reviewer: { readonly agentId: string } | null
  readonly history: readonly { readonly kind: string; readonly detail?: string }[]
}

/**
 * The Host-side slice this smoke drives, declared here because this file's lint
 * program does not carry the taskboard package's cordis `Context` augmentation.
 */
interface TaskboardHostPort {
  claimMaster(boardId: string, agent: unknown): Promise<unknown>
  createRemote(agent: unknown, request: Record<string, unknown>): Promise<SmokeTicket>
  moveAsMaster(agent: unknown, request: Record<string, unknown>): Promise<SmokeTicket>
  requestReviewRemote(agent: unknown, request: Record<string, unknown>): Promise<SmokeTicket>
  claimReview(agent: unknown, ticketId: string): Promise<SmokeTicket>
  viewTicket(ticketId: string): Promise<SmokeTicket>
  reconcileStaleReviewers(): Promise<number>
}

/** Both durable roots are shared by the two boots (outside the owned temp roots). */
const HOME = join(tmpdir(), 'v612-home-' + String(process.pid))
const SESSIONS = join(tmpdir(), 'v612-sessions-' + String(process.pid))
const STORAGE = join(tmpdir(), 'v612-storage-' + String(process.pid))

/**
 * Link the two plugin packages into the profile the scaffold is about to boot.
 * The scaffold's install-anchor step leaves `profiles/scaffold/node_modules`
 * empty in this worktree, so the Loader cannot import either layer by name.
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
      // Already linked by an earlier boot of this run.
    }
  }
}

describe('web e2e: Taskboard review seat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let ticketId = ''
  let reviewerAgentId = ''
  /** The session that seated the reviewer; reused as the claimer after the restart. */
  let seatedBy: unknown

  beforeAll(async () => {
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    mkdirSync(SESSIONS, { recursive: true })
    mkdirSync(STORAGE, { recursive: true })
    linkPluginLayers(HOME)
    // Boot 1: seat a reviewer through the real path, then dispose the Host.
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS,
      harnessHome: HOME, persistenceRoot: SESSIONS, storageRoot: STORAGE,
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const host = scaffold.ctx as unknown as { taskboard: TaskboardHostPort }
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('the connected workspace created no Agent')
    await host.taskboard.claimMaster('default', agent)
    const card = await host.taskboard.createRemote(agent, {
      title: 'v612 review seat', description: 'seat a reviewer, then restart the host',
      priority: 'normal', dependsOn: [], boardId: 'default',
    })
    ticketId = card.id
    await host.taskboard.moveAsMaster(agent, {
      ticketId, column: 'in_testing', beforeTicketId: null, afterTicketId: null,
    })
    seatedBy = agent
    await host.taskboard.requestReviewRemote(agent, { ticketId })
    reviewerAgentId = (await host.taskboard.viewTicket(ticketId)).reviewer?.agentId ?? ''
    if (reviewerAgentId === '') throw new Error('the real seating path seated no reviewer')
    // Both sessions must be durable before the Host goes away: the reviewer's
    // stored record is the half of the blind spot that keeps the seat.
    await scaffold.ctx.sessions.flush(agent.session)
    const reviewerSession = scaffold.ctx.agents.get(reviewerAgentId as never)?.session
    if (reviewerSession !== undefined) await scaffold.ctx.sessions.flush(reviewerSession)
    await scaffold.close()
    // Boot 2: same home and session root, a fresh live registry.
    linkPluginLayers(HOME)
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS,
      harnessHome: HOME, persistenceRoot: SESSIONS, storageRoot: STORAGE,
    })
    // Boot 2 needs no browser: the scenario is asserted through the Host (the
    // real service), and the board it reads is the one boot 1 left behind.
  }, 300_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('releases a seat whose holder survived only as a stored session, then lets claim_review take it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-taskboard-review-seat'))
    const host = scaffold.ctx as unknown as { taskboard: TaskboardHostPort }
    const claimer = seatedBy
    if (claimer === undefined) throw new Error('boot 1 recorded no seating session')
    // The restart shape: the holder's process is gone, its stored record is not.
    expect(scaffold.ctx.agents.get(reviewerAgentId as never)).toBeUndefined()
    const survived = await host.taskboard.viewTicket(ticketId)
    expect(survived.reviewer?.agentId).toBe(reviewerAgentId)
    expect(survived.history.some(entry => entry.kind === 'review-release')).toBe(false)
    // Inside the window: nothing is released (the record still holds the seat).
    expect(await host.taskboard.reconcileStaleReviewers()).toBe(0)
    expect((await host.taskboard.viewTicket(ticketId)).reviewer?.agentId).toBe(reviewerAgentId)
    // Past it: the seat is released as STALE — a judgment that requires the
    // stored record to keep it (seatLost false) and only the clock to free it.
    let row = survived
    await expect.poll(async () => {
      await host.taskboard.reconcileStaleReviewers()
      row = await host.taskboard.viewTicket(ticketId)
      return row.history.some(entry => entry.kind === 'review-release')
    }, { timeout: 90_000, interval: 2000 }).toBe(true)
    const detail = row.history.find(entry => entry.kind === 'review-release')?.detail ?? ''
    const released = await host.taskboard.viewTicket(ticketId)
    const claimed = released.reviewer === null ? await host.taskboard.claimReview(claimer, ticketId) : released
    expect(claimed.reviewer).not.toBeNull()

    console.log(
      'taskboard review-seat smoke: reviewer ' + reviewerAgentId + ' seated in boot 1'
      + ' | after restart registry=' + String(scaffold.ctx.agents.get(reviewerAgentId as never))
      + ' but seat kept; reconcile inside the window released 0'
      + ' | after the window history says "' + detail + '", reviewer=null'
      + ' | claim_review took the seat as ' + String(claimed.reviewer?.agentId),
    )
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
