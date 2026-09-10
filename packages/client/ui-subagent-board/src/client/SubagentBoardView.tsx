/**
 * SubagentBoardView: the conversation tab classifying this session's direct
 * children by their taskboard lifecycle. Rows come from the sessions seat
 * (subagentsByParent keyed by the framework sessionId); each child is matched
 * to a card through the worker/reviewer attribution of the default-board
 * snapshot, grouped into In progress / In testing / other, with a red blocked
 * badge for failed workers.
 */
import { useEffect, useMemo } from 'react'
import clsx from 'clsx'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentCatalogSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TicketView } from '@deepseek-ai/dsh-taskboard/client'
import type { SubagentBoardInjected } from './contract.ts'
import type { TaskboardBoardKey } from './locales.ts'
import css from './SubagentBoard.module.css'

export type SubagentBoardViewProps = ConvViewProps
  & InjectFace<SubagentBoardInjected>
  & PropsLocale<'taskboardBoard'>

/** One durable direct-child catalog row (runtime snapshot entry). */
type CatalogEntry = SubagentCatalogSnapshot['entries'][number]

/** The classification badge of one row. */
type RowBadge = 'in-progress' | 'in-testing' | 'blocked' | null

/** One rendered row: the child plus its matched card, group, and badge. */
interface BoardRow {
  entry: CatalogEntry
  ticket: TicketView | null
  group: GroupKey
  badge: RowBadge
}

/** The three fixed groups in display order. */
type GroupKey = 'in-progress' | 'in-testing' | 'other'

/**
 * Match a child to the card it serves: the worker session id or the reviewer
 * agent id both identify the subagent on the ticket.
 */
function ticketOf(entry: CatalogEntry, tickets: readonly TicketView[]): TicketView | null {
  return tickets.find(ticket =>
    ticket.workerAgentId === entry.id || ticket.workerSessionId === entry.id || ticket.reviewer?.agentId === entry.id,
  ) ?? null
}

/** Derive the classification badge: blocked wins, then the card's column. */
function badgeOf(group: GroupKey, ticket: TicketView | null): RowBadge {
  if (ticket === null) return null
  if (ticket.status === 'blocked' || ticket.failure !== null) return 'blocked'
  return group === 'in-progress' ? 'in-progress' : group === 'in-testing' ? 'in-testing' : null
}

/** Group one child: the matched card's column decides the group. */
function rowOf(entry: CatalogEntry, tickets: readonly TicketView[]): BoardRow {
  const ticket = ticketOf(entry, tickets)
  const group: GroupKey = ticket === null ? 'other'
    : ticket.column === 'in_progress' ? 'in-progress'
      : ticket.column === 'in_testing' ? 'in-testing' : 'other'
  return { entry, ticket, group, badge: badgeOf(group, ticket) }
}

/** Short display handle for one session id. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** The classification badge label for one row. */
function badgeText(badge: RowBadge, t: (key: TaskboardBoardKey) => string): string | null {
  if (badge === 'in-progress') return t('badge.inProgress')
  if (badge === 'in-testing') return t('badge.inTesting')
  if (badge === 'blocked') return t('badge.blocked')
  return null
}

/** The CSS class for one badge variant (noUncheckedIndexedAccess types css entries loosely). */
function badgeClass(badge: RowBadge): string | undefined {
  if (badge === 'in-progress') return css.badgeInProgress
  if (badge === 'in-testing') return css.badgeInTesting
  if (badge === 'blocked') return css.badgeBlocked
  return undefined
}

/** The display label of one child (continuable labels are required; one-shot fall back to the id). */
function labelOf(entry: CatalogEntry): string {
  if (entry.kind !== 'child') return entry.id
  return entry.label ?? entry.id
}

export function SubagentBoardView({
  useBoard, useSessions, sessionId, setCatalogOpen, t,
}: SubagentBoardViewProps) {
  const board = useBoard(snapshot => snapshot)
  const subagentsByParent = useSessions(state => state.subagentsByParent)
  const tickets = board?.tickets ?? []
  const entries = subagentsByParent[sessionId]?.entries ?? []

  // While this tab is mounted, its parent session's direct-child catalog
  // consumes live membership updates, so subagent start/end events refresh
  // the directory without any manual action.
  useEffect(() => {
    setCatalogOpen(true)
    return () => { setCatalogOpen(false) }
  }, [sessionId, setCatalogOpen])

  /** Grouped rows, derived purely from the two snapshots. */
  const groups = useMemo(() => {
    const byGroup = new Map<GroupKey, BoardRow[]>()
    for (const key of ['in-progress', 'in-testing', 'other'] as const) byGroup.set(key, [])
    for (const entry of entries) {
      const row = rowOf(entry, tickets)
      const rows = byGroup.get(row.group)
      if (rows !== undefined) rows.push(row)
    }
    return byGroup
  }, [entries, tickets])

  if (entries.length === 0) {
    return (
      <div className={css.root}>
        <header className={css.header}>
          <h1 className={css.title}>{t('view.subagents')}</h1>
          <span className={css.boardNote}>{t('board.note')}</span>
        </header>
        <p className={css.state}>{board === null ? t('state.loading') : t('empty')}</p>
      </div>
    )
  }

  const sections: { key: GroupKey; name: string }[] = [
    { key: 'in-progress', name: t('group.inProgress') },
    { key: 'in-testing', name: t('group.inTesting') },
    { key: 'other', name: t('group.other') },
  ]

  return (
    <div className={css.root}>
      <header className={css.header}>
        <h1 className={css.title}>{t('view.subagents')}</h1>
        <span className={css.count}>{String(entries.length)}</span>
        <span className={css.boardNote}>{t('board.note')}</span>
      </header>
      <div className={css.body}>
        {sections.map(({ key, name }) => {
          const rows = groups.get(key) ?? []
          if (rows.length === 0) return null
          return (
            <section key={key} className={css.group} data-group={key}>
              <div className={css.groupHeader}>
                <span className={css.groupName}>{name}</span>
                <span className={css.groupCount}>{String(rows.length)}</span>
              </div>
              {rows.map((row) => {
                const text = badgeText(row.badge, t)
                return (
                  <article key={row.entry.id} className={css.row}>
                    <div className={css.rowMain}>
                      <p className={css.rowTitle}>
                        {row.ticket === null ? t('row.noTicket') : row.ticket.title}
                      </p>
                      <div className={css.rowMeta}>
                        <span className={css.rowLabel}>{labelOf(row.entry)}</span>
                        <span className={css.rowId}>{shortId(row.entry.id)}</span>
                      </div>
                    </div>
                    {text !== null && (
                      <span className={clsx(css.badge, badgeClass(row.badge))}>{text}</span>
                    )}
                  </article>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
