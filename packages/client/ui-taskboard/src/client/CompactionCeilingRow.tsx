/**
 * The automatic-compaction ceiling row (V6-2): preset ceilings, a percent
 * input, the value in force and the composition fallback a reset returns to.
 * The row renders the `compaction-basic` settings section, so what it shows is
 * the ceiling the Host's engines actually compact under.
 *
 * V6-7: a served section that carries no choice yet reads as INHERITED, because
 * the composition value is a per-preset fact the document cannot name; and an
 * unavailable section reports what to do about it rather than only that it is
 * missing.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { TaskboardT } from './TicketCard.tsx'
import { COMPACTION_CEILING_PRESETS, type CompactionCeilingFace } from './compaction-threshold.ts'
import css from './Board.module.css'

/** Props of the ceiling row. */
export interface CompactionCeilingRowProps {
  /** The bound ceiling face every session tab shares. */
  ceiling: CompactionCeilingFace
  /** Locale resolver for the `taskboard` namespace. */
  t: TaskboardT
}

/**
 * Percent text for one ceiling ratio, trimming a trailing zero.
 * @param ratio - fraction of the routed context window.
 * @returns the percent string without its sign, e.g. `85` or `62.5`.
 */
export function ceilingPercent(ratio: number): string {
  const percent = Math.round(ratio * 1_000) / 10
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
}

/**
 * Render the ceiling row: one preset button per offered ceiling, a percent
 * input for anything else, the value in force, and the reset back to the
 * composition value.
 * @param props - the bound face and the tab's translator.
 * @returns the row element.
 */
export function CompactionCeilingRow({ ceiling, t }: CompactionCeilingRowProps) {
  // The observable's methods are declared with method syntax, so they are
  // bound once here: React re-subscribes whenever an identity changes.
  const store = ceiling.state
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const disabled = !state.writable || state.status !== 'ready'

  /** Store one chosen ratio; a refused write is reported in the row. */
  const apply = (ratio: number): void => {
    setError(null)
    void ceiling.choose(ratio).catch(() => { setError(t('ceiling.failed')) })
  }

  /** Store the typed percent, or report why it cannot be stored. */
  const submitDraft = (): void => {
    const percent = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(percent) || percent < 1 || percent > 100) {
      setError(t('ceiling.invalid'))
      return
    }
    setDraft('')
    apply(percent / 100)
  }

  /** The readout: the choice in force, the inherited note, or the refusal reason. */
  const readout = ((): string => {
    if (state.status === 'unavailable') return t('ceiling.unavailable')
    if (state.status === 'loading') return t('ceiling.loading')
    if (state.ratio === undefined) return t('ceiling.inherited')
    const current = t('ceiling.current').replace('{percent}', ceilingPercent(state.ratio))
    return state.overridden ? `${current} · ${t('ceiling.overridden')}` : current
  })()

  /**
   * Actionable guidance behind an unavailable readout: a page without a
   * writable Host document, or a Host that serves no ceiling section (V6-7 —
   * in the web profile that section comes from this plugin's own node half).
   */
  const guidance = state.status === 'unavailable'
    ? t(state.mode === 'memory' ? 'ceiling.helpLocal' : 'ceiling.helpHost')
    : undefined

  return (
    <div className={css.ceiling} data-testid="taskboard-compaction">
      <span className={css.ceilingTitle}>{t('ceiling.title')}</span>
      {COMPACTION_CEILING_PRESETS.map(ratio => (
        <button
          key={String(ratio)}
          type="button"
          className={css.ceilingPreset}
          data-preset={String(ratio)}
          data-active={state.overridden && state.ratio === ratio}
          disabled={disabled}
          onClick={() => { apply(ratio) }}
        >
          {ceilingPercent(ratio) + '%'}
        </button>
      ))}
      <input
        className={css.ceilingInput}
        type="text"
        inputMode="decimal"
        aria-label={t('ceiling.input')}
        placeholder={t('ceiling.inputPlaceholder')}
        value={draft}
        disabled={disabled}
        onChange={(event) => { setDraft(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter') submitDraft() }}
      />
      <button type="button" className={css.ceilingAction} disabled={disabled} onClick={submitDraft}>
        {t('ceiling.apply')}
      </button>
      <span className={css.ceilingValue} data-testid="taskboard-compaction-value">{readout}</span>
      {guidance !== undefined && (
        <span className={css.ceilingHelp} data-testid="taskboard-compaction-help">{guidance}</span>
      )}
      {state.base !== undefined && (
        <span className={css.ceilingValue}>
          {t('ceiling.base').replace('{percent}', ceilingPercent(state.base))}
        </span>
      )}
      <button
        type="button"
        className={css.ceilingAction}
        disabled={disabled || !state.overridden}
        onClick={() => {
          setError(null)
          void ceiling.reset().catch(() => { setError(t('ceiling.failed')) })
        }}
      >
        {t('ceiling.reset')}
      </button>
      {error !== null && <span className={css.ceilingError} role="alert">{error}</span>}
    </div>
  )
}
