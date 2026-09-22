/**
 * The automatic-compaction ceiling control's face.
 *
 * The ceiling itself belongs to `compaction-basic`'s settings namespace — the
 * Host half of this phase — and is spelled here rather than imported, because a
 * client package must not depend on a Host package. The control reads the
 * resolved section for the value in force and writes the USER layer through the
 * settings scope, so choosing a value equal to the composition default is still
 * a visible override rather than a silent no-op.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Settings namespace carrying the automatic-compaction ceiling. */
export const COMPACTION_CEILING_NS = 'compaction-basic'

/** The section's single field, spelled as the Host namespace spells it. */
export const COMPACTION_CEILING_FIELD = 'thresholdRatio'

/**
 * Preset ceilings, as fractions of whichever context window a session routes
 * to. 0.3 sits below where long sessions plateau, 0.85 leaves the widest
 * headroom; the composition value is always available as its own option.
 */
export const COMPACTION_CEILING_PRESETS: readonly number[] = [0.3, 0.5, 0.7, 0.85]

/** The ceiling section as this control reads it. */
export interface CompactionCeilingSection {
  /** Fraction of the routed context window at which pressure compaction fires. */
  thresholdRatio?: number
}

/** What the ceiling row renders. */
export interface CompactionCeilingState {
  /** `loading` before the first accepted section, `unavailable` when the Host serves none. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Ratio in force; undefined while no section has been accepted. */
  ratio: number | undefined
  /** Composition value the reset returns to; undefined when the Host declared none. */
  base: number | undefined
  /** Whether the user document carries the choice (presence, not a value comparison). */
  overridden: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /**
   * Which transport answered: `memory` means the page is not a local
   * connection, so the Host serves no writable settings document at all.
   */
  mode: 'host' | 'memory'
}

/** The ceiling row's face, built once per plugin and shared by every session tab. */
export interface CompactionCeilingFace {
  /** Live control state. */
  state: HostObservable<CompactionCeilingState>
  /**
   * Store one ceiling in the user layer.
   * @param ratio - fraction of the routed context window to persist.
   * @returns settlement after the Host write and its recovery read.
   */
  choose(ratio: number): Promise<void>
  /**
   * Clear the choice so the composition value governs again.
   * @returns settlement after the Host write and its recovery read.
   */
  reset(): Promise<void>
  /** Stop projecting scope changes into {@link state}. */
  dispose(): void
}

/** One layer's ceiling ratio, when that layer carries a usable number. */
function ratioOf(layer: unknown): number | undefined {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return undefined
  const ratio = (layer as Record<string, unknown>)[COMPACTION_CEILING_FIELD]
  return typeof ratio === 'number' ? ratio : undefined
}

/** Project one scope snapshot into the row's presentation state. */
function project(snapshot: SettingsScopeSnapshot<CompactionCeilingSection>): CompactionCeilingState {
  return {
    status: snapshot.status,
    ratio: ratioOf(snapshot.value),
    base: ratioOf(snapshot.base),
    overridden: ratioOf(snapshot.user) !== undefined,
    writable: snapshot.writable,
    mode: snapshot.mode,
  }
}

/**
 * Build the ceiling row's face over one bound settings scope.
 * @param scope - the scope bound to {@link COMPACTION_CEILING_NS}.
 * @returns the live face plus its disposer.
 */
export function createCompactionCeilingFace(
  scope: SettingsScope<CompactionCeilingSection>,
): CompactionCeilingFace {
  const store = createSnapshotStore(project(scope.getSnapshot()))
  const unsubscribe = scope.subscribe(() => {
    store.update((draft) => { Object.assign(draft, project(scope.getSnapshot())) })
  })
  return {
    state: store,
    choose: async (ratio) => { await scope.set(COMPACTION_CEILING_FIELD, ratio) },
    reset: async () => { await scope.unset(COMPACTION_CEILING_FIELD) },
    dispose: () => { unsubscribe() },
  }
}
