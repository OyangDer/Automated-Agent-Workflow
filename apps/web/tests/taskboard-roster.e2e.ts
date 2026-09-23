// Keyless assembled-browser acceptance for the Taskboard roster (V6-13): the
// reuse path every "clickable UI" card must supply, because neither a component
// test nor a string match can see a stale built client bundle or a plugin layer
// that never mounted. The scaffold boots the real Host composition over the two
// shipped plugin layers, drives it with a real Chromium, and the assertion pairs
// the on-screen headcount with the Host capacity the same click changed.
//
// Reusing this path for another Taskboard UI card: copy this file, keep the
// scaffold + overlay + dual-evidence shape, swap the click and the Host read.
// apps/web/tests/README.md carries the three-step recipe.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./taskboard-roster.overlay.yml', import.meta.url))
const HOST_PATCH = fileURLToPath(new URL('../../../packages/taskboard/taskboard/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../../packages/client/ui-taskboard/cordis.patch.yml', import.meta.url))
// The plugin packages are not root dependencies, so the scaffold installs them
// by manifest the way `dsh plugin add` does.
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/taskboard/taskboard/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/client/ui-taskboard/package.json', import.meta.url)),
]

/**
 * The Host-side board read this smoke pairs with the on-screen headcount. It is
 * declared here because this file's lint program does not carry the taskboard
 * package's cordis `Context` augmentation (the Host program in
 * `tsconfig.host.json` does).
 */
interface TaskboardHostPort {
  /** The live board snapshot: members, caps and tickets. */
  snapshot(agent: unknown): Promise<{
    capacity: { worker: number; reviewer: number }
    members: readonly unknown[]
  }>
}

/**
 * Parse one profile patch list.
 * @param path - the patch file to read.
 * @returns its entries.
 */
function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error('profile layer at ' + path + ' must be a list')
  return parsed
}

describe('Taskboard profile layers', () => {
  it('mirrors the two shipped plugin layers', () => {
    expect(profileEntries(OVERLAY)).toEqual([...profileEntries(HOST_PATCH), ...profileEntries(WEB_PATCH)])
  })
})

describe('web e2e: Taskboard roster', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    // A seeded turn puts the conversation view (and its view ring) on screen,
    // which is where the Taskboard tab is registered.
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('the connected workspace created no Agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Open the Taskboard controls.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready.').waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('raises the worker headcount in the mounted tab and on the Host', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-taskboard-roster'))
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('the connected workspace created no Agent')
    // Host-side baseline: the same service the tab reads through the Remote.
    const host = scaffold.ctx as unknown as { taskboard: TaskboardHostPort }
    const before = await host.taskboard.snapshot(agent)

    await page.getByRole('tab', { name: 'Taskboard', exact: true }).click()
    const count = page.getByTestId('roster-worker-count')
    await count.waitFor({ timeout: 30_000 })
    const uiBefore = ((await count.textContent()) ?? '').trim()
    expect(uiBefore).toBe(String(before.capacity.worker))

    // A stale assembled client bundle throws here (the V6-10 "not a function"
    // failure mode) instead of passing a string assertion.
    await page.getByTestId('roster-worker-increase').click()
    await expect.poll(async () => ((await count.textContent()) ?? '').trim(), { timeout: 20_000 })
      .toBe(String(before.capacity.worker + 1))
    const uiAfter = ((await count.textContent()) ?? '').trim()

    const after = await host.taskboard.snapshot(agent)
    expect(after.capacity.worker).toBe(before.capacity.worker + 1)
    // A fresh board materializes its roster on the first headcount write, so
    // the roster can grow by more than the one slot the click raised.
    expect(after.members.length).toBeGreaterThan(before.members.length)

    console.log(
      'taskboard smoke: worker headcount UI ' + uiBefore + ' -> ' + uiAfter
      + ' | Host capacity worker ' + String(before.capacity.worker) + ' -> ' + String(after.capacity.worker)
      + ' | Host roster members ' + String(before.members.length) + ' -> ' + String(after.members.length),
    )
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
