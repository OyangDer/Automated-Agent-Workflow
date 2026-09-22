/**
 * TicketCard: one draggable kanban card. Purely presentational — every fact
 * arrives through props; interaction callbacks are owner-provided.
 */
import type { DragEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TicketView } from '@deepseek-ai/dsh-taskboard/client'
import css from './TicketCard.module.css'

/** The bound taskboard translator, shared by the tab's child components. */
export type TaskboardT = PropsLocale<'taskboard'>['t']

export interface TicketCardProps {
  ticket: TicketView
  selected: boolean
  dragging: boolean
  t: TaskboardT
  onSelect: () => void
  onDragStart: () => void
  onDragEnd: () => void
}

/** Priority → accent token (local custom property consumed by the CSS). */
const PRIORITY_ACCENT = {
  low: 'var(--dsw-alias-label-tertiary)',
  normal: 'var(--dsw-alias-state-business-primary)',
  high: 'var(--dsw-alias-state-error-primary)',
} as const satisfies Record<TicketView['priority'], string>

/** Ticket type → accent token for the kind badge (remaining kinds fall back). */
const TYPE_ACCENT: Partial<Record<TicketView['type'], string>> = {
  feature: 'var(--dsw-alias-state-business-primary)',
  bugfix: 'var(--dsw-alias-state-error-primary)',
  test: 'var(--dsw-alias-state-warn-primary)',
  merge: 'var(--dsw-alias-state-success-primary)',
}

/** The type accent with a neutral fallback for the remaining kinds. */
function typeAccent(type: TicketView['type']): string {
  return TYPE_ACCENT[type] ?? 'var(--dsw-alias-label-tertiary)'
}

/**
 * The fixed partner of one roster member id (V6-1): W<n> pairs with R<n>.
 * The board computes the pairing the same way, so this only renders it.
 */
function partnerOf(id: string, workerTag: string, reviewerTag: string): string {
  const match = /^[WR](\d+)$/.exec(id)
  return (id.startsWith('R') ? workerTag : reviewerTag) + (match === null ? '' : match[1])
}

export function TicketCard({
  ticket, selected, dragging, t,
  onSelect, onDragStart, onDragEnd,
}: TicketCardProps) {
  const rejected = ticket.lastReview?.outcome === 'rejected'
  const reviewing = ticket.column === 'in_testing'
  const approved = ticket.lastReview?.outcome === 'approved'
  const paused = ticket.status === 'paused'
  const queued = ticket.status === 'queued'
  // V6-1: the fixed worker -> reviewer pair is readable on the card itself.
  const pair = ticket.workerMemberId === undefined
    ? null
    : { worker: ticket.workerMemberId, reviewer: ticket.reviewerMemberId ?? partnerOf(ticket.workerMemberId, t('roster.tagWorker'), t('roster.tagReviewer')) }
  return (
    <article
      className={css.card + (selected ? ' ' + css.cardSelected : '') + (dragging ? ' ' + css.cardDragging : '')}
      draggable
      data-ticket-id={ticket.id}
      style={{
        '--taskboard-card-accent': PRIORITY_ACCENT[ticket.priority],
        '--taskboard-card-type-accent': typeAccent(ticket.type),
      } as Record<string, string>}
      onClick={onSelect}
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData('text/plain', ticket.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      <div className={css.cardTop}>
        <span className={css.cardTopLeft}>
          <span className={css.priority} title={t(('priority.' + ticket.priority) as never)}>
            {t(('priority.' + ticket.priority) as never)}
          </span>
          <span className={css.typeBadge} title={t(('type.' + ticket.type) as never)}>
            {t(('type.' + ticket.type) as never)}
          </span>
        </span>
        <span className={css.id}>{ticket.id}</span>
      </div>
      <h2 className={css.cardTitle}>{ticket.title}</h2>
      {ticket.description.trim() !== '' && (
        <p className={css.cardDescription}>{ticket.description}</p>
      )}
      {queued && ticket.queue !== null && ticket.queue !== undefined && (
        <p className={css.cardQueue}>
          {t('state.queueReason').replace('{reason}', ticket.queue.reason)}
        </p>
      )}
      <div className={css.cardMeta}>
        {ticket.assignee === null
          ? <span className={css.metaLabel}>{t('state.unassigned')}</span>
          : <span className={css.metaLabel}>{ticket.assignee.label}</span>}
        {pair !== null && (
          <span className={css.metaLabel}>
            {t('state.pair').replace('{worker}', pair.worker).replace('{reviewer}', pair.reviewer)}
          </span>
        )}
        {queued && <span className={css.badge + ' ' + css.badgeQueued}>{t('state.queued')}</span>}
        {reviewing && <span className={css.badge + ' ' + css.badgeReviewing}>{t('state.reviewing')}</span>}
        {rejected && <span className={css.badge + ' ' + css.badgeRejected}>{t('state.rejected')}</span>}
        {approved && <span className={css.badge + ' ' + css.badgeApproved}>{t('state.approved')}</span>}
        {paused && <span className={css.badge + ' ' + css.badgePaused}>{t('state.paused')}</span>}
        {ticket.reviewAttempts > 0 && (
          <span className={css.metaLabel}>{t('state.attempts').replace('{count}', String(ticket.reviewAttempts))}</span>
        )}
      </div>
    </article>
  )
}
