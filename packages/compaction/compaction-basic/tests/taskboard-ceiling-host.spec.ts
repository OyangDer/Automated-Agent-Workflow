/**
 * The automatic-compaction ceiling's HOST-PLANE registration (V6-7), the
 * deployment seam between this package and the taskboard plugin.
 *
 * The web profile disables the base bundle's host-plane `compaction-basic` mount
 * and composes that package per agent preset, so a freshly booted host has no
 * section registered when the browser reads `settings.describe` — and the
 * browser re-reads only on a document commit, so the taskboard ceiling row
 * stayed on `unavailable` forever. `@deepseek-ai/dsh-client-ui-taskboard`'s node
 * half registers the section at boot instead, with no composition entry.
 *
 * These tests pin the shape the registration closes — section served before any
 * engine mounts, preset engines keeping their own composition until the document
 * carries a choice, the choice surviving a host restart — and the contract this
 * package owns: the namespace, field, and bounds. The seam is exercised from
 * here because this package owns that contract and already mounts the real
 * settings providers; a spec inside the client package cannot import a Host
 * package, and the browser half's own spellings are pinned in
 * `packages/client/ui-taskboard/tests/compaction-ceiling.client.spec.tsx`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { apply as applyTaskboard } from '@deepseek-ai/dsh-client-ui-taskboard/src/index.ts'
import {
  COMPACTION_SETTINGS_NAMESPACE,
  COMPACTION_THRESHOLD_SCHEMA,
  THRESHOLD_RATIO_FIELD,
  bindThresholdSettings,
} from '../src/settings.ts'

/** In-memory settings provider fixture: writable, with an empty document. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

/** The ratio one bound engine adopted last, or undefined while none arrived. */
function lastRatio(adopted: readonly number[]): number | undefined {
  return adopted[adopted.length - 1]
}

describe('the taskboard host-plane ceiling section', () => {
  /** Every temp root this block created, removed after each test. */
  const roots: string[] = []
  afterEach(async () => {
    for (const home of roots.splice(0)) await rm(home, { recursive: true, force: true })
  })

  it('serves the ceiling section on the host plane before any engine mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    // The V6-7 defect: without an engine nothing has registered the section, and
    // this is exactly what the browser's first describe read used to see.
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(COMPACTION_SETTINGS_NAMESPACE)

    await ctx.plugin({ apply: applyTaskboard }).await()

    const row = ctx.settings.describe().find(candidate => candidate.ns === COMPACTION_SETTINGS_NAMESPACE)
    expect(row).toBeDefined()
    // No composition entry: the composition value is a per-preset fact.
    expect(row?.value).toEqual({})
    expect(row?.base).toBeUndefined()
    expect(JSON.stringify(row?.schema)).toContain(THRESHOLD_RATIO_FIELD)

    // The browser half binds the same namespace and field (pinned in the client
    // spec), and the owner spells both here: a drift in any of the three
    // spellings leaves the row driving nothing.
    expect(COMPACTION_SETTINGS_NAMESPACE).toBe('compaction-basic')
    expect(THRESHOLD_RATIO_FIELD).toBe('thresholdRatio')

    await ctx.settings.update(COMPACTION_SETTINGS_NAMESPACE, { [THRESHOLD_RATIO_FIELD]: 0.5 })
    expect(ctx.settings.get(COMPACTION_SETTINGS_NAMESPACE)).toEqual({ [THRESHOLD_RATIO_FIELD]: 0.5 })
  })

  it('bounds the section exactly as the owning package does', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply: applyTaskboard }).await()

    for (const ratio of [0.009, 1.5]) {
      expect(() => COMPACTION_THRESHOLD_SCHEMA({ thresholdRatio: ratio })).toThrow()
      await expect(ctx.settings.update(COMPACTION_SETTINGS_NAMESPACE, { thresholdRatio: ratio }))
        .rejects.toThrow()
    }
    await ctx.settings.update(COMPACTION_SETTINGS_NAMESPACE, { thresholdRatio: 0.01 })
    expect(ctx.settings.get(COMPACTION_SETTINGS_NAMESPACE)).toEqual({ thresholdRatio: 0.01 })
  })

  it('lets a preset engine keep its composition value and follow the stored ceiling', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply: applyTaskboard }).await()

    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const adopted: number[] = []
    const preset = ctx.plugin({
      apply: (presetCtx: Context) => {
        bindThresholdSettings(presetCtx, 0.3, {
          validate: () => {},
          apply: (ratio: number) => { adopted.push(ratio) },
        })
      },
    })
    await preset.await()

    // The section carries no choice yet, so this preset's own composition rules.
    expect(adopted).toEqual([0.3])

    await ctx.settings.update(COMPACTION_SETTINGS_NAMESPACE, { [THRESHOLD_RATIO_FIELD]: 0.5 })
    await vi.waitFor(() => { expect(lastRatio(adopted)).toBe(0.5) })

    // Clearing the choice returns the engine to its composition value.
    await ctx.settings.replace(COMPACTION_SETTINGS_NAMESPACE, {})
    await vi.waitFor(() => { expect(lastRatio(adopted)).toBe(0.3) })

    // Following an existing section is not the "not registered" fallback path.
    expect(warnings).toEqual([])
  })

  it('persists the choice across a restart-shaped fresh provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-taskboard-ceiling-'))
    roots.push(home)
    const file = join(home, 'settings.yaml')

    const ctx = new Context()
    await ctx.plugin(FileSettingsProvider, { path: file, watch: false }).await()
    await ctx.plugin({ apply: applyTaskboard }).await()
    await ctx.settings.update(COMPACTION_SETTINGS_NAMESPACE, { [THRESHOLD_RATIO_FIELD]: 0.5 })
    expect(await readFile(file, 'utf8')).toContain(`${COMPACTION_SETTINGS_NAMESPACE}:`)
    expect(await readFile(file, 'utf8')).toContain(`${THRESHOLD_RATIO_FIELD}: 0.5`)

    // What a host restart sees: a new context, provider, registration, and engine.
    const restarted = new Context()
    await restarted.plugin(FileSettingsProvider, { path: file, watch: false }).await()
    await restarted.plugin({ apply: applyTaskboard }).await()
    const adopted: number[] = []
    await restarted.plugin({
      apply: (presetCtx: Context) => {
        bindThresholdSettings(presetCtx, 0.3, {
          validate: () => {},
          apply: (ratio: number) => { adopted.push(ratio) },
        })
      },
    }).await()

    expect(restarted.settings.get(COMPACTION_SETTINGS_NAMESPACE)).toEqual({ [THRESHOLD_RATIO_FIELD]: 0.5 })
    await vi.waitFor(() => { expect(lastRatio(adopted)).toBe(0.5) })
  })
})
