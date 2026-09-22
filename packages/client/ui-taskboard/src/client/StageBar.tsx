/**
 * The development-stage bar (V6-4). One stage is one board, and this strip is
 * where the user sees WHICH stage is current, switches between stages (an
 * archived stage is history: still selectable for review, marked read-only),
 * starts the next stage, and migrates an explicit batch of cards to another
 * stage.
 *
 * The bar owns no stage data: it renders the host's stage list and the current
 * stage's cards, and every mutation goes through the injected verbs only after
 * the user's confirmation. Nothing moves implicitly — the migration panel is
 * the only path that calls migrateTickets, and it always names the ticked ids
 * and the chosen target. A refusal from the host is surfaced verbatim, because
 * "this stage is archived" is exactly the answer the user needs to see.
 */
import { useState } from 'react'
import type {
  CreateStageRequest, MigrateTicketsRequest, MigrateTicketsResult, StageView, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { TaskboardT } from './TicketCard.tsx'
import css from './StageBar.module.css'

/** Props of the development-stage bar. */
export interface StageBarProps {
  /** Every stage of the caller's workspace, oldest first. */
  stages: readonly StageView[]
  /** The board id of the stage currently rendered. */
  currentBoardId: string
  /** The current stage's cards; the migration batch is picked from them. */
  tickets: readonly TicketView[]
  /** True when the current stage has ended: its history is read-only. */
  currentArchived: boolean
  /** Make one stage current; switching to an archived stage re-activates it. */
  switchStage: (boardId: string) => Promise<unknown>
  /** Start the next empty stage; the display name is optional. */
  createStage: (request: CreateStageRequest) => Promise<unknown>
  /** Move the named cards to one target stage; returns the host receipt. */
  migrateTickets: (request: MigrateTicketsRequest) => Promise<MigrateTicketsResult>
  /** Locale resolver for the `taskboard` namespace. */
  t: TaskboardT
}

/**
 * Format one stage as its 1-based index plus its display name.
 * @param stage - the stage to label.
 * @param t - locale resolver.
 * @returns the index-prefixed display label.
 */
export function stageLabel(stage: StageView, t: TaskboardT): string {
  return t('stage.index').replace('{index}', String(stage.stageIndex)) + ' ' + stage.stageName
}

/**
 * Format one stage's census: all cards plus the Done column.
 * @param stage - the stage to describe.
 * @param t - locale resolver.
 * @returns the census line.
 */
export function stageCensus(stage: StageView, t: TaskboardT): string {
  return t('stage.census')
    .replace('{total}', String(stage.total))
    .replace('{done}', String(stage.counts.done))
}

/**
 * Render the stage bar with its three panels (list, create, migrate).
 * @param props - the bound stage data, the verbs and the locale resolver.
 * @returns the stage strip element.
 */
export function StageBar({
  stages, currentBoardId, tickets, currentArchived, switchStage, createStage, migrateTickets, t,
}: StageBarProps) {
  const [listOpen, setListOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [stageName, setStageName] = useState('')
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [targetBoardId, setTargetBoardId] = useState('')
  const [receipt, setReceipt] = useState<MigrateTicketsResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const current = stages.find(stage => stage.boardId === currentBoardId)
    ?? stages.find(stage => stage.active)
    ?? null
  /** Stages the batch may move TO; the current stage is not a migration target. */
  const targets = stages.filter(stage => stage.boardId !== currentBoardId)

  /** Report one refusal, keeping the host's own reason text when it has one. */
  const fail = (failure: unknown): void => {
    setError(failure instanceof Error ? failure.message : t('stage.failed').replace('{reason}', String(failure)))
  }

  /** Make one stage current and close the list. */
  const runSwitch = (boardId: string): void => {
    setError(null)
    setListOpen(false)
    void switchStage(boardId).catch(fail)
  }

  /** Start the next stage; a blank name lets the host number it. */
  const runCreate = (): void => {
    setError(null)
    const name = stageName.trim()
    void createStage(name === '' ? {} : { name })
      .then(() => {
        setCreateOpen(false)
        setStageName('')
      })
      .catch(fail)
  }

  /** Move the ticked batch to the chosen stage after the explicit confirm. */
  const runMigrate = (): void => {
    setError(null)
    if (selected.length === 0 || targetBoardId === '') {
      setError(t('stage.migrateNone'))
      return
    }
    void migrateTickets({ ticketIds: [...selected], targetBoardId })
      .then((result) => {
        setReceipt(result)
        setSelected([])
        setTargetBoardId('')
        setMigrateOpen(false)
      })
      .catch(fail)
  }

  /** Tick or untick one card in the migration batch. */
  const toggle = (id: string): void => {
    setSelected(previous => previous.includes(id)
      ? previous.filter(candidate => candidate !== id)
      : [...previous, id])
  }

  /** The title of one migrated card, falling back to its id. */
  const titleOf = (id: string): string => tickets.find(ticket => ticket.id === id)?.title ?? id

  /** The display label of one stage id, falling back to the raw id. */
  const stageLabelOf = (boardId: string): string => {
    const stage = stages.find(candidate => candidate.boardId === boardId)
    return stage === undefined ? boardId : stageLabel(stage, t)
  }

  return (
    <div
      className={css.stageBar}
      data-testid="taskboard-stage-bar"
      data-archived={currentArchived || undefined}
    >
      <span className={css.stageTitle}>{t('stage.bar')}</span>
      {current === null ? (
        <span className={css.stageCurrent} data-testid="taskboard-stage-current">{t('stage.empty')}</span>
      ) : (
        <span
          className={css.stageCurrent}
          data-testid="taskboard-stage-current"
          data-archived={current.archivedAt !== null || currentArchived || undefined}
        >
          <span className={css.stageCurrentLabel}>{t('stage.current')}</span>
          <span className={css.stageIndex}>{'#' + String(current.stageIndex)}</span>
          <span className={css.stageName}>{current.stageName}</span>
          <span className={css.stageBadge} data-testid="taskboard-stage-current-marker">{t('stage.active')}</span>
          {(current.archivedAt !== null || currentArchived) && (
            <span className={css.stageReadonlyBadge} data-testid="taskboard-stage-current-archived">
              {t('stage.readonly')}
            </span>
          )}
        </span>
      )}
      <div className={css.stageActions}>
        <button
          type="button"
          className={css.stageAction}
          data-testid="stage-list-toggle"
          onClick={() => { setListOpen(open => !open); setCreateOpen(false) }}
        >
          {t('stage.list')}
        </button>
        <button
          type="button"
          className={css.stageAction}
          data-testid="stage-create-toggle"
          onClick={() => { setCreateOpen(open => !open); setListOpen(false) }}
        >
          {t('stage.create')}
        </button>
        <button
          type="button"
          className={css.stageAction}
          data-testid="stage-migrate-toggle"
          disabled={targets.length === 0}
          onClick={() => { setMigrateOpen(open => !open) }}
        >
          {t('stage.migrate')}
        </button>
      </div>
      {listOpen && (
        <ul className={css.stageList} data-testid="taskboard-stage-list">
          {stages.map((stage) => {
            const archived = stage.archivedAt !== null
            return (
              <li
                key={stage.boardId}
                className={css.stageRow}
                data-testid={'stage-row-' + stage.boardId}
                data-current={stage.boardId === currentBoardId}
                data-archived={archived}
              >
                <span className={css.stageRowIndex}>{'#' + String(stage.stageIndex)}</span>
                <span className={css.stageRowName}>{stage.stageName}</span>
                {stage.boardId === currentBoardId && (
                  <span className={css.stageBadge}>{t('stage.active')}</span>
                )}
                {archived && (
                  <span className={css.stageReadonlyBadge} data-testid={'stage-archived-' + stage.boardId}>
                    {t('stage.archived')}
                  </span>
                )}
                <span className={css.stageRowCensus} data-testid={'stage-census-' + stage.boardId}>
                  {stageCensus(stage, t)}
                </span>
                <button
                  type="button"
                  className={css.stageRowSwitch}
                  data-testid={'stage-switch-' + stage.boardId}
                  disabled={stage.boardId === currentBoardId}
                  onClick={() => { runSwitch(stage.boardId) }}
                >
                  {t('stage.switch')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {createOpen && (
        <form
          className={css.stageForm}
          data-testid="taskboard-stage-create"
          onSubmit={(event) => { event.preventDefault(); runCreate() }}
        >
          <input
            className={css.stageInput}
            data-testid="stage-name-input"
            value={stageName}
            onChange={(event) => { setStageName(event.target.value) }}
            placeholder={t('stage.createName')}
            aria-label={t('stage.createName')}
          />
          <button type="submit" className={css.stagePrimary} data-testid="stage-create-submit">
            {t('stage.createConfirm')}
          </button>
          <button
            type="button"
            className={css.stageSecondary}
            onClick={() => { setCreateOpen(false); setStageName('') }}
          >
            {t('action.cancel')}
          </button>
        </form>
      )}
      {migrateOpen && (
        <div className={css.stageMigrate} data-testid="taskboard-stage-migrate">
          <span className={css.stageMigrateHint}>{t('stage.migrateHint')}</span>
          <div className={css.stageMigrateCards} data-testid="taskboard-stage-migrate-cards">
            {tickets.map(ticket => (
              <label
                key={ticket.id}
                className={css.stageMigrateCard}
                data-testid={'stage-migrate-card-' + ticket.id}
                data-selected={selected.includes(ticket.id)}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(ticket.id)}
                  aria-label={ticket.title}
                  onChange={() => { toggle(ticket.id) }}
                />
                <span className={css.stageMigrateCardTitle} title={ticket.title}>{ticket.title}</span>
                <span className={css.stageMigrateCardColumn}>{t(('column.' + ticket.column) as never)}</span>
              </label>
            ))}
          </div>
          <label className={css.stageTargetLabel}>
            {t('stage.migrateTarget')}
            <select
              className={css.stageTargetSelect}
              data-testid="stage-migrate-target"
              value={targetBoardId}
              onChange={(event) => { setTargetBoardId(event.target.value) }}
              aria-label={t('stage.migrateTarget')}
            >
              <option value="">{t('stage.migrateTarget')}</option>
              {targets.map(stage => (
                <option key={stage.boardId} value={stage.boardId} disabled={stage.archivedAt !== null}>
                  {stageLabel(stage, t) + (stage.archivedAt !== null ? t('stage.migrateReadonlyTarget') : '')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={css.stagePrimary}
            data-testid="stage-migrate-submit"
            disabled={selected.length === 0 || targetBoardId === ''}
            onClick={() => { runMigrate() }}
          >
            {t('stage.migrateConfirm')}
          </button>
          <button
            type="button"
            className={css.stageSecondary}
            onClick={() => { setMigrateOpen(false) }}
          >
            {t('action.cancel')}
          </button>
        </div>
      )}
      {receipt !== null && (
        <span className={css.stageReceipt} data-testid="taskboard-stage-receipt">
          {t('stage.migrateDone')
            .replace('{count}', String(receipt.moved.length))
            .replace('{stage}', stageLabelOf(receipt.targetBoardId))}
          {' · ' + t('stage.migrateIds').replace('{ids}', receipt.moved.map(titleOf).join('、'))}
        </span>
      )}
      {currentArchived && (
        <div className={css.stageReadonlyNotice} role="status" data-testid="taskboard-stage-readonly">
          {t('stage.currentReadonly')}
        </div>
      )}
      {error !== null && <span className={css.stageError} role="alert">{error}</span>}
    </div>
  )
}
