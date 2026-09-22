/**
 * The user-owned automatic-compaction ceiling.
 *
 * The ceiling is a ratio of the routed model's context window, so the same
 * user choice means the same fraction of whatever window a session routes to.
 * The composition still owns the deployment value: it is the section's base
 * layer, and the package default applies when a composition sets none.
 *
 * `compaction-basic` loads once per mounted agent preset, so one process can
 * hold several engines while the settings document is a single host-plane
 * artifact. The first engine to find the namespace unclaimed registers it; every
 * later engine follows the namespace's commits instead. A follower reads the
 * RAW user layer, so while the document carries no choice each engine keeps its
 * own composition value rather than inheriting whichever preset registered
 * first.
 *
 * @module @deepseek-ai/dsh-compaction-basic/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the ctx.settings merge and the provider's owns-namespace surface.
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
// Type-only: the settings event declarations (settings/updated,
// settings/document-updated) this module subscribes to.
import type {} from '@deepseek-ai/dsh-settings/types'

/** Settings namespace carrying the user's automatic-compaction ceiling. */
export const COMPACTION_SETTINGS_NAMESPACE = 'compaction-basic'

/** The section's single field, spelled once for every reader and writer. */
export const THRESHOLD_RATIO_FIELD = 'thresholdRatio'

/** The user-editable subset of the compaction policy: its pressure ceiling. */
export interface CompactionThresholdSettings {
  /** Fraction of the routed model's context window at which pressure compaction fires. */
  thresholdRatio: number
}

/** Schema of the user-editable ceiling section. */
export const COMPACTION_THRESHOLD_SCHEMA: z<CompactionThresholdSettings> = z.object({
  // Zero (or less) would put the ceiling at zero tokens, so every step would
  // compact; one is the whole routed window.
  thresholdRatio: z.number().min(0.01).max(1),
})

/**
 * Read the ceiling the user document stores, ignoring the layers below it.
 *
 * The resolved section merges schema defaults, the composition base layer, and
 * the user layer, so an engine that did not register the namespace cannot tell
 * from `get()` alone whether a value is the user's choice or another preset's
 * composition value.
 * @param settings - the mounted settings provider.
 * @returns the stored ratio, or `undefined` when the document carries none.
 */
export function userThresholdRatio(settings: SettingsProvider): number | undefined {
  const descriptor = settings.describe()
    .find(candidate => String(candidate.ns) === COMPACTION_SETTINGS_NAMESPACE)
  const user = descriptor?.user
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return undefined
  const ratio = (user as Record<string, unknown>)[THRESHOLD_RATIO_FIELD]
  return typeof ratio === 'number' ? ratio : undefined
}

/** What one engine instance supplies to {@link bindThresholdSettings}. */
export interface ThresholdSettingsHooks {
  /**
   * Judge one candidate ceiling against this instance's own composition.
   * @param ratio - the candidate fraction of the routed context window.
   * @throws Error when this instance could not compact under that ceiling.
   */
  validate(ratio: number): void
  /**
   * Adopt one effective ceiling.
   * @param ratio - the fraction of the routed context window now in force.
   */
  apply(ratio: number): void
}

/**
 * Bind one engine instance to the shared ceiling section.
 *
 * The binding is an effect on the engine's context, so disposing the plugin
 * releases the namespace it registered. A deployment that never mounts a
 * settings provider is unaffected: the injection simply never runs and the
 * composition value stays authoritative.
 * @param ctx - the engine's plugin context.
 * @param base - the composition ceiling this instance falls back to.
 * @param hooks - validation and adoption of a candidate ceiling.
 */
export function bindThresholdSettings(ctx: Context, base: number, hooks: ThresholdSettingsHooks): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const { settings } = settingsCtx
    if (settings.get(COMPACTION_SETTINGS_NAMESPACE) === undefined) {
      let source: () => CompactionThresholdSettings = () => ({ [THRESHOLD_RATIO_FIELD]: base })
      try {
        settings.installSection(
          ctx,
          COMPACTION_SETTINGS_NAMESPACE,
          COMPACTION_THRESHOLD_SCHEMA,
          { [THRESHOLD_RATIO_FIELD]: base },
          {
            validate: (value) => { hooks.validate(value[THRESHOLD_RATIO_FIELD]) },
            setSource: (current) => { source = current },
            onChange: () => { hooks.apply(source()[THRESHOLD_RATIO_FIELD]) },
          },
        )
        return
      } catch (error: unknown) {
        // A stored section this instance cannot judge leaves the namespace
        // unclaimed. Observing it keeps the engine on its composition value
        // instead of failing the whole plugin load.
        ctx.logger.warn(
          `compaction-basic: threshold settings not registered, observing instead: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const follow = (): void => { hooks.apply(userThresholdRatio(settings) ?? base) }
    follow()
    ctx.effect(() => {
      const onCommit = (ns: unknown): void => {
        if (String(ns) !== COMPACTION_SETTINGS_NAMESPACE) return
        follow()
      }
      const offUpdated = ctx.on('settings/updated', onCommit)
      const offDocument = ctx.on('settings/document-updated', onCommit)
      return () => {
        offUpdated()
        offDocument()
      }
    }, 'compaction-basic: shared threshold section')
  })
}
