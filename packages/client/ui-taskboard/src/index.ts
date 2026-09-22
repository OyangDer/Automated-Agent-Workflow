/**
 * Taskboard surface plugin, node half. The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration; the node half exists so the plugin appears in the host
 * cordis.yml / Loader.
 *
 * It also carries the HOST-PLANE registration of the automatic-compaction
 * ceiling section (V6-7). The web profile composes `compaction-basic` per agent
 * preset — the `dsh-web-app` bundle disables the base bundle's host-plane mount
 * — so that package's node half never runs at boot and its section exists only
 * while a preset engine is mounted. The browser's describe mirror reads
 * `settings.describe` once per connection and re-reads only on a document
 * commit, so a namespace appearing later leaves the taskboard ceiling row
 * latched on `unavailable` ("This deployment serves no such setting"). This
 * package is the host-plane plugin that deployment mounts for the board, so its
 * node half registers the section at boot.
 *
 * The registration claims NO composition entry: the ceiling's composition value
 * is a per-preset fact (the shipped web presets set their own `thresholdRatio`),
 * and every engine that mounts afterwards finds the namespace claimed and
 * follows the user document instead. The namespace, field, and bounds are
 * spelled here rather than imported for the same reason the browser half spells
 * them: a client package must not depend on a Host package, and
 * `@deepseek-ai/dsh-compaction-basic` owns the contract these test against.
 * {@link apply} degrades to a warning, never a failed boot.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.settings merge this half registers through.
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Settings namespace carrying the ceiling, as `compaction-basic` spells it. */
const COMPACTION_CEILING_NAMESPACE = 'compaction-basic'

/** The section's single field, as `compaction-basic` spells it. */
const COMPACTION_CEILING_FIELD = 'thresholdRatio'

/** Smallest accepted ceiling; the owning package's schema refuses less. */
const COMPACTION_CEILING_MIN = 0.01

/** Largest accepted ceiling; one is the whole routed context window. */
const COMPACTION_CEILING_MAX = 1

/**
 * The ceiling section as the host plane registers it: the one editable field,
 * with no default, because the composition value belongs to each preset engine.
 */
interface CompactionCeilingSection {
  thresholdRatio?: number
}

/** Durable ceiling schema, mirroring `COMPACTION_THRESHOLD_SCHEMA`'s bounds. */
const CompactionCeilingSchema: z<CompactionCeilingSection> = z.object({
  [COMPACTION_CEILING_FIELD]: z.number().min(COMPACTION_CEILING_MIN).max(COMPACTION_CEILING_MAX),
})

/**
 * Register the ceiling section when the optional settings service is composed,
 * so the browser sees it on its first describe read instead of waiting for a
 * preset engine.
 *
 * An engine that mounted first keeps its own registration (and with it the
 * validation its composition implies); this call then does nothing. A refused
 * registration — a malformed stored section, or a duplicate claim — is logged
 * and leaves the row on its actionable unavailable copy rather than failing the
 * plugin load.
 * @param ctx - host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const { settings } = settingsCtx
    if (settings.get(COMPACTION_CEILING_NAMESPACE) !== undefined) return
    try {
      settings.register(COMPACTION_CEILING_NAMESPACE, CompactionCeilingSchema)
    } catch (error: unknown) {
      ctx.logger.warn(
        `ui-taskboard: compaction ceiling section not registered: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}
