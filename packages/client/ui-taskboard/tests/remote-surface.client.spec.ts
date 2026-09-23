// @vitest-environment jsdom
/**
 * The taskboard tab's verbs must exist on the Client Remote surface the browser
 * actually gets, and that surface is assembled at build time: the
 * `@deepseek-ai/dsh-api-remotes` client bundle inlines one generated
 * contribution per remote namespace (taskboard among them) and mounts them with
 * `ctx.remote.$mount`. Asserting the verb on the mounted contribution - by
 * executing the built bundle and watching what it mounts - is what catches the
 * failure mode where a fresh `typert.remote-client.js` never made it into the
 * assembly: the tab then calls a member the browser-side proxy does not carry
 * and the click dies with "ctx.remote.taskboard.setRosterCapacity is not a
 * function". A string check over `.js` text cannot see that, and neither can a
 * spec that scripts its own namespace double.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The built assembly the browser loads; built by `pnpm run build:lib:client`. */
const ASSEMBLY = resolve(process.cwd(), 'packages/api/remotes/lib/client.js')

/** Every taskboard verb this tab calls through `ctx.remote.taskboard`. */
const REQUIRED_VERBS = [
  'snapshot', 'create', 'edit', 'delete', 'move', 'requestReview', 'listBoards', 'createBoard', 'archiveBoard',
  'setRosterCapacity', 'restoreMember', 'listStages', 'createStage', 'switchStage', 'migrateTickets',
] as const

/** One captured `window.__ModuleLoader__.load` handoff. */
interface LoadedEntry {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => { apply?: (ctx: unknown) => unknown }
}

/**
 * Execute the built assembly bundle and collect the contribution ids it mounts.
 * @param source - the bundle text.
 * @returns the mounted contribution ids, in mount order.
 */
async function mountedContributionIds(source: string): Promise<string[]> {
  const loaded: LoadedEntry[] = []
  const load = (entry: LoadedEntry): void => { loaded.push(entry) }
  ;(globalThis as { window?: { __ModuleLoader__?: { load: typeof load } } }).window = { __ModuleLoader__: { load } }
  // The bundle is a closure factory for that loader, not a module: evaluating it
  // is how the browser runs it.
  new Function(source)()
  const mounted: string[] = []
  const ctx = {
    remote: {
      $mount: async (contribution: { descriptors: readonly { id: string }[] }) => {
        mounted.push(...contribution.descriptors.map(descriptor => descriptor.id))
        return async () => {}
      },
    },
  }
  for (const entry of loaded) {
    const exports = entry.factory((specifier: string) => {
      throw new Error('assembly bundle required an external in the surface probe: ' + specifier)
    })
    await exports.apply?.(ctx)
  }
  return mounted
}

// A stale artifact and an unbuilt one are different failures, and this spec only
// sees the first: absent, the whole block skips. Say so out loud rather than
// passing silently, and let the build pipeline own "the assembly was built at
// all" (`pnpm run build:lib:client` is mandatory after a remote signature
// change, per docs/cookbook/adding-a-remote-api.md step 3).
const ASSEMBLY_BUILT = existsSync(ASSEMBLY)
if (!ASSEMBLY_BUILT) {
  console.warn('[V6-10] assembly bundle not built, skipping the surface check: ' + ASSEMBLY)
}

describe.skipIf(!ASSEMBLY_BUILT)('client remote surface: the taskboard namespace the browser mounts', () => {
  it('carries every verb the tab calls', async () => {
    const ids = await mountedContributionIds(readFileSync(ASSEMBLY, 'utf8'))
    expect(ids.length).toBeGreaterThan(0)
    const missing = REQUIRED_VERBS.filter(verb => !ids.includes('@deepseek-ai/dsh-taskboard#taskboard/' + verb))
    expect(missing).toEqual([])
  })

  it('reports the mounted taskboard verbs', async () => {
    const ids = await mountedContributionIds(readFileSync(ASSEMBLY, 'utf8'))
    const verbs = ids
      .filter(id => id.startsWith('@deepseek-ai/dsh-taskboard#taskboard/'))
      .map(id => id.slice('@deepseek-ai/dsh-taskboard#taskboard/'.length))
      .sort()
    // Evidence line, not the assertion: what the browser-side proxy carries.
    console.log('[V6-10] assembled client remote surface, taskboard verbs: ' + verbs.join(', '))
    expect(verbs).toContain('setRosterCapacity')
    expect(verbs).toContain('restoreMember')
  })
})
