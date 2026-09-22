/**
 * TicketDetail: the read/edit overlay for one selected card. Shows the full
 * ticket, review state and history, and offers the user-side verbs: edit,
 * adjacent-column moves, re-review, and a two-step delete.
 */
import { useState } from 'react'
import type {
  ColumnId, EditTicketRequest, Priority, RemoveTicketRequest,
  RemoveTicketResult, RequestReviewRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { TaskboardT } from './TicketCard.tsx'
import css from './TicketDetail.module.css'

/** The five workflow columns in canonical left-to-right order. */
const COLUMNS: readonly ColumnId[] = ['backlog', 'not_started', 'in_progress', 'in_testing', 'done']

const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high']

/**
 * The fixed partner of one roster member id (V6-1): W<n> pairs with R<n>.
 * @param id - the member id shown on the card.
 * @returns the partner member id.
 */
function partnerOf(id: string): string {
  const match = /^[WR](\d+)$/.exec(id)
  return (id.startsWith('R') ? 'W' : 'R') + (match === null ? '' : match[1])
}

/**
 * Turn one rejected verb into a user-facing message: surface the real
 * server failure text when the rejection carries one, falling back to the
 * generic copy for non-Error rejections.
 */
function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}

export interface TicketDetailProps {
  ticket: TicketView
  /** All board tickets, for the dependsOn picker. */
  board: TicketView[]
  t: TaskboardT
  onClose: () => void
  onEdit: (request: EditTicketRequest) => Promise<TicketView>
  onRemove: (request: RemoveTicketRequest) => Promise<RemoveTicketResult>
  onRequestReview: (request: RequestReviewRequest) => Promise<TicketView>
  onMove: (column: ColumnId) => void
  onError: (message: string) => void
}

export function TicketDetail({
  ticket, board, t, onClose, onEdit, onRemove, onRequestReview, onMove, onError,
}: TicketDetailProps) {
  const [editing, setEditing] = useState(false)
  const [armDelete, setArmDelete] = useState(false)
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description)
  const [priority, setPriority] = useState<Priority>(ticket.priority)
  const [dependsOn, setDependsOn] = useState<string[]>(ticket.dependsOn)
  const [filesScope, setFilesScope] = useState(ticket.filesScope)
  const [pending, setPending] = useState(false)

  const columnIndex = COLUMNS.indexOf(ticket.column)
  const prevColumn: ColumnId | null = columnIndex > 0 ? COLUMNS[columnIndex - 1] ?? null : null
  const nextColumn: ColumnId | null = columnIndex >= 0 && columnIndex < COLUMNS.length - 1 ? COLUMNS[columnIndex + 1] ?? null : null

  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      onError(t('error.generic'))
      return
    }
    setPending(true)
    try {
      await onEdit({ ticketId: ticket.id, boardId: ticket.boardId, title, description, priority, dependsOn, filesScope })
      setEditing(false)
    } catch (error) {
      onError(failureMessage(error, t('error.generic')))
    } finally {
      setPending(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!armDelete) {
      setArmDelete(true)
      return
    }
    setPending(true)
    try {
      await onRemove({ ticketId: ticket.id, boardId: ticket.boardId })
      onClose()
    } catch (error) {
      onError(failureMessage(error, t('error.generic')))
    } finally {
      setPending(false)
    }
  }

  const requestReview = async (): Promise<void> => {
    setPending(true)
    try {
      await onRequestReview({ ticketId: ticket.id, boardId: ticket.boardId })
    } catch (error) {
      onError(failureMessage(error, t('error.generic')))
    } finally {
      setPending(false)
    }
  }

  const lastReview = ticket.lastReview

  return (
    <aside className={css.panel} role="dialog" aria-label={ticket.title}>
      <header className={css.header}>
        <h2 className={css.title}>{ticket.title}</h2>
        <button type="button" className={css.closeButton} onClick={onClose} aria-label={t('action.close')}>×</button>
      </header>
      <div className={css.body}>
        <dl className={css.facts}>
          <div className={css.fact}>
            <dt>{t('detail.assignee')}</dt>
            <dd>{ticket.assignee === null ? t('state.unassigned') : ticket.assignee.label}</dd>
          </div>
          <div className={css.fact}>
            <dt>{t('detail.reviewer')}</dt>
            <dd>{ticket.reviewer === null ? t('state.unassigned') : ticket.reviewer.label}</dd>
          </div>
          {ticket.workerMemberId !== undefined && (
            <div className={css.fact}>
              <dt>{t('detail.pair')}</dt>
              <dd>
                {t('detail.pairValue')
                  .replace('{worker}', ticket.workerMemberId)
                  .replace('{reviewer}', ticket.reviewerMemberId ?? partnerOf(ticket.workerMemberId))}
              </dd>
            </div>
          )}
          {ticket.queue !== null && ticket.queue !== undefined && (
            <div className={css.fact}>
              <dt>{t('detail.queue')}</dt>
              <dd>{'#' + String(ticket.queue.position) + ' · ' + ticket.queue.reason}</dd>
            </div>
          )}
          <div className={css.fact}>
            <dt>{t('detail.reviewAttempts')}</dt>
            <dd>{String(ticket.reviewAttempts)}</dd>
          </div>
          <div className={css.fact}>
            <dt>{t('form.priority')}</dt>
            <dd>{t(('priority.' + ticket.priority) as never)}</dd>
          </div>
          <div className={css.fact}>
            <dt>{t('detail.filesScope')}</dt>
            <dd>{ticket.filesScope.trim() === '' ? '—' : ticket.filesScope}</dd>
          </div>
        </dl>

        {!editing && (
          <>
            <p className={css.description}>{ticket.description.trim() === '' ? '—' : ticket.description}</p>
            {ticket.devNotes.trim() !== '' && (
              <section className={css.section}>
                <h3 className={css.sectionTitle}>{t('detail.devNotes')}</h3>
                <p className={css.paragraph}>{ticket.devNotes}</p>
              </section>
            )}
            {ticket.dependsOn.length > 0 && (
              <section className={css.section}>
                <h3 className={css.sectionTitle}>{t('form.dependsOn')}</h3>
                <ul className={css.dependencyList}>
                  {ticket.dependsOn.map(id => <li key={id} className={css.dependency}>{id}</li>)}
                </ul>
              </section>
            )}
          </>
        )}

        {editing && (
          <div className={css.editForm}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('form.title')}</span>
              <input className={css.input} value={title} onChange={event => setTitle(event.target.value)} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('form.description')}</span>
              <textarea className={css.textarea} value={description} onChange={event => setDescription(event.target.value)} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('form.priority')}</span>
              <select className={css.input} value={priority} onChange={event => setPriority(event.target.value as Priority)}>
                {PRIORITIES.map(value => (
                  <option key={value} value={value}>{t(('priority.' + value) as never)}</option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('form.filesScope')}</span>
              <textarea
                className={css.textarea}
                value={filesScope}
                placeholder={t('form.filesScope.placeholder')}
                onChange={(event) => { setFilesScope(event.target.value) }}
              />
            </label>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('form.dependsOn')}</span>
              <div className={css.dependencyPicker}>
                {board.filter(candidate => candidate.id !== ticket.id && candidate.column !== 'done').map(candidate => (
                  <label key={candidate.id} className={css.dependencyOption}>
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(candidate.id)}
                      onChange={(event) => {
                        setDependsOn(current => event.target.checked
                          ? [...current, candidate.id]
                          : current.filter(id => id !== candidate.id))
                      }}
                    />
                    <span>{candidate.title}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {lastReview !== null && (
          <section className={css.reviewBox + (lastReview.outcome === 'rejected' ? ' ' + css.reviewRejected : ' ' + css.reviewApproved)}>
            <h3 className={css.sectionTitle}>
              {`${t('detail.lastReview')} · ${t(lastReview.outcome === 'rejected' ? 'detail.lastReview.rejected' : 'detail.lastReview.approved')}`}
            </h3>
            <p className={css.paragraph}>{lastReview.feedback.trim() === '' ? '—' : lastReview.feedback}</p>
            <p className={css.reviewMeta}>{lastReview.reviewer.label}</p>
          </section>
        )}

        {ticket.history.length > 0 && (
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{t('detail.history')}</h3>
            <ol className={css.historyList}>
              {[...ticket.history].reverse().map((row, index) => (
                <li key={index} className={css.historyRow}>
                  <span className={css.historyDetail}>{row.detail}</span>
                  <span className={css.historyTime}>{new Date(row.at).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
      <footer className={css.footer}>
        {!editing && (
          <>
            {prevColumn !== null && (
              <button type="button" className={css.button} onClick={() => { onMove(prevColumn) }}>{t('action.moveLeft')}</button>
            )}
            {nextColumn !== null && (
              <button type="button" className={css.button} onClick={() => { onMove(nextColumn) }}>{t('action.moveRight')}</button>
            )}
            {ticket.column === 'in_testing' && (
              <button type="button" className={css.button} disabled={pending} onClick={() => { void requestReview() }}>
                {t('action.requestReview')}
              </button>
            )}
            <button type="button" className={css.button} onClick={() => { setEditing(true) }}>{t('action.edit')}</button>
          </>
        )}
        {editing && (
          <>
            <button type="button" className={css.buttonPrimary} disabled={pending} onClick={() => { void save() }}>{t('action.save')}</button>
            <button type="button" className={css.button} onClick={() => { setEditing(false) }}>{t('action.cancel')}</button>
          </>
        )}
        <button
          type="button"
          className={armDelete ? css.buttonDanger : css.button}
          disabled={pending}
          onClick={() => { void remove() }}
        >
          {armDelete ? t('action.delete') + '?' : t('action.delete')}
        </button>
      </footer>
    </aside>
  )
}
