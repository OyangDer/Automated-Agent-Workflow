// V6-12 acceptance: the runaway review seat, reproduced in the real Host
// composition. The card sits In testing with a seated reviewer; the holder then
// leaves the live agent registry while its stored session record survives. That
// pair is the blind spot the probe found in production (a dead process whose
// session log is still on disk), so the old liveness pass judged it neither lost
// (the record exists) nor stale (the holder was not registered) and the seat
// stayed claimed forever. The assertions are the card's: the seat is released
// once the staleness window passes — and NOT before — after which
// taskboard_claim_review can take it.
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
  readonly column: string
  readonly reviewer: { readonly agentId: string } | null
  readonly history: readonly { readonly kind: string }[]
}

/**
 * The Host-side slice this smoke drives, declared here because this file's lint
 * program does not carry the taskboard package's cordis `Context` augmentation.
 */
interface TaskboardHostPort {
  claimMaster(boardId: string, agent: unknown): Promise<unknown>
  createRemote(agent: unknown, request: Record<string, unknown>): Promise<SmokeTicket>
  moveAsMaster(agent: unknown, request: Record<string, unknown>): Promise<SmokeTicket>
  claimReview(agent: unknown, ticketId: string): Promise<SmokeTicket>
  viewTicket(ticketId: string): Promise<SmokeTicket>
  reconcileStaleReviewers(): Promise<number>
}

/** The harness home this smoke keeps, outside the scaffold-owned temp roots. */
const HOME = join(tmpdir(), 'v612-home-' + String(process.pid))

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
  /** Seated in the setup, judged below. */
  let ticketId = ''
  let reviewerAgentId = ''

  beforeAll(async () => {
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    linkPluginLayers(HOME)
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS, harnessHome: HOME,
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const host = scaffold.ctx as unknown as { taskboard: TaskboardHostPort }
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('the connected workspace created no Agent')
    await host.taskboard.claimMaster('default', agent)
    const card = await host.taskboard.createRemote(agent, {
      title: 'v612 review seat', description: 'seat a reviewer, then lose its process',
      priority: 'normal', dependsOn: [], boardId: 'default',
    })
    ticketId = card.id
    await host.taskboard.moveAsMaster(agent, {
      ticketId, column: 'in_testing', beforeTicketId: null, afterTicketId: null,
    })
    // Entering In testing seats a reviewer through the real path; an empty seat
    // (no live subagent seam) is taken by this session instead.
    const moved = await host.taskboard.viewTicket(ticketId)
    const seated = moved.reviewer === null ? await host.taskboard.claimReview(agent, ticketId) : moved
    reviewerAgentId = seated.reviewer?.agentId ?? ''
    if (reviewerAgentId === '') throw new Error('the setup seated no reviewer')
    await scaffold.ctx.sessions.flush(agent.session)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('releases a seat whose holder survived only as a stored session, then lets claim_review take it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-taskboard-review-seat'))
    const host = scaffold.ctx as unknown as { taskboard: TaskboardHostPort }
    const holder = scaffold.ctx.agents.get(reviewerAgentId as never)
    if (holder === undefined) throw new Error('the seated reviewer is not live')
    expect((await host.taskboard.viewTicket(ticketId)).reviewer?.agentId).toBe(reviewerAgentId)

    // The dead process in one step: the holder leaves the live agent registry,
    // while its stored session record stays on disk (the shape the probe found
    // after a restart).
    const unregister = scaffold.ctx.agents.register(holder)
    unregister()
    expect(scaffold.ctx.agents.get(reviewerAgentId as never)).toBeUndefined()

    // Before the staleness window nothing is released: the stored record still
    // holds the seat (V3-43) and the clock has not run out.
    expect(await host.taskboard.reconcileStaleReviewers()).toBe(0)
    const stillHeld = await host.taskboard.viewTicket(ticketId)
    expect(stillHeld.reviewer?.agentId).toBe(reviewerAgentId)
    expect(stillHeld.history.some(entry => entry.kind === 'review-release')).toBe(false)

    // Past the window the same pass releases it (the interval timer may get
    // there first; poll the card either way).
    await expect.poll(async () => {
      const row = await host.taskboard.viewTicket(ticketId)
      return row.history.some(entry => entry.kind === 'review-release')
    }, { timeout: 30_000, interval: 500 }).toBe(true)
    const released = await host.taskboard.viewTicket(ticketId)
    // No live master exists to parent a replacement here, so the seat is left
    // vacant — exactly the state taskboard_claim_review is for.
    expect(released.reviewer).toBeNull()
    const claimed = await host.taskboard.claimReview(holder, ticketId)
    expect(claimed.reviewer?.agentId).toBe(reviewerAgentId)

    console.log(
      'taskboard review-seat smoke: holder ' + reviewerAgentId + ' left the live registry (stored log kept)'
      + ' -> reconcile before the window released 0, seat still ' + reviewerAgentId
      + '; after the window: reviewer=null + history review-release, then claim_review took the seat back as '
      + String(claimed.reviewer?.agentId),
    )
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
