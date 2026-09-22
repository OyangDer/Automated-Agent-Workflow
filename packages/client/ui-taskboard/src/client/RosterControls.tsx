/**
 * The roster headcount panel (V6-3). It owns the one interaction the
 * requirement is strict about: lowering a headcount NEVER picks the member for
 * the user — the panel asks which member to archive and sends that member's id
 * with the new count, so the board can refuse (or accept) a named decision
 * instead of a silent one. Raising a count creates the new member, an archived
 * member stays visible with its number, 履历 and summary, and the restore
 * button brings it back to dispatch.
 *
 * Every refusal from the board (a member executing a card, an invalid count)
 * is surfaced verbatim in the panel's alert instead of being swallowed.
 */
import { useState } from 'react'
import type {
  BoardSnapshot, MemberRole, MemberView, RestoreMemberRequest, SetRosterCapacityRequest,
} from '@deepseek-ai/dsh-taskboard/client'
import type { TaskboardT } from './TicketCard.tsx'
import css from './Board.module.css'

/** The two roster roles, in display order. */
const ROLES: readonly MemberRole[] = ['worker', 'reviewer']

/** Props of the roster headcount panel. */
export interface RosterControlsProps {
  /** Every member of the active board, archived ones included. */
  members: readonly MemberView[]
  /** The board's effective headcount per role; undefined on an old host. */
  capacity: { worker: number; reviewer: number } | undefined
  /** The board every mutation targets. */
  boardId: string
  /** Change one role's headcount (a lowering names the member to archive). */
  setRosterCapacity: (request: SetRosterCapacityRequest) => Promise<BoardSnapshot>
  /** Bring one archived member back. */
  restoreMember: (request: RestoreMemberRequest) => Promise<BoardSnapshot>
  /** Locale resolver for the `taskboard` namespace. */
  t: TaskboardT
}

/**
 * The headcount in force for one role: the host-reported cap, or the number of
 * active members when an older host serves none.
 * @param members - every member of the board.
 * @param capacity - the host-reported caps, when present.
 * @param role - the role to count.
 * @returns the effective headcount.
 */
export function effectiveHeadcount(
  members: readonly MemberView[],
  capacity: { worker: number; reviewer: number } | undefined,
  role: MemberRole,
): number {
  if (capacity !== undefined) return capacity[role]
  return members.filter(member => member.role === role && member.archivedAt === null).length
}

/** The members of one role that still take cards. */
function activeMembersOf(members: readonly MemberView[], role: MemberRole): MemberView[] {
  return members.filter(member => member.role === role && member.archivedAt === null)
}

/**
 * Render the headcount panel: the per-role count with its +/- controls, the
 * named-member picker a lowering opens, the archived members with their
 * restore button, and the board's refusal text.
 * @param props - the bound roster data and the two mutation verbs.
 * @returns the panel element.
 */
export function RosterControls({
  members, capacity, boardId, setRosterCapacity, restoreMember, t,
}: RosterControlsProps) {
  const [picking, setPicking] = useState<MemberRole | null>(null)
  const [error, setError] = useState<string | null>(null)
  const archived = members.filter(member => member.archivedAt !== null)

  /** Run one mutation, surfacing the board's refusal in the alert. */
  const run = (call: () => Promise<BoardSnapshot>): void => {
    setError(null)
    void call().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : t('roster.failed'))
    })
  }

  const roleName = (role: MemberRole): string => t(role === 'worker' ? 'roster.worker' : 'roster.reviewer')

  return (
    <span className={css.rosterControls} data-testid="taskboard-roster-controls">
      {ROLES.map((role) => {
        const count = effectiveHeadcount(members, capacity, role)
        return (
          <span key={role} className={css.rosterRole} data-role={role} data-testid={'roster-' + role}>
            <span className={css.rosterRoleName}>{roleName(role)}</span>
            <button
              type="button"
              className={css.rosterStep}
              data-testid={'roster-' + role + '-decrease'}
              aria-label={t('roster.decrease').replace('{role}', roleName(role))}
              title={t('roster.decrease').replace('{role}', roleName(role))}
              disabled={count <= 1}
              onClick={() => {
                setError(null)
                setPicking(picking === role ? null : role)
              }}
            >
              −
            </button>
            <span className={css.rosterCount} data-testid={'roster-' + role + '-count'}>{String(count)}</span>
            <button
              type="button"
              className={css.rosterStep}
              data-testid={'roster-' + role + '-increase'}
              aria-label={t('roster.increase').replace('{role}', roleName(role))}
              title={t('roster.increase').replace('{role}', roleName(role))}
              onClick={() => {
                setPicking(null)
                run(() => setRosterCapacity({ boardId, role, count: count + 1 }))
              }}
            >
              +
            </button>
          </span>
        )
      })}
      {picking !== null && (
        <span className={css.rosterPick} data-testid="taskboard-roster-picker" data-role={picking}>
          <span className={css.rosterPickLabel}>
            {t('roster.pick').replace('{role}', roleName(picking))}
          </span>
          {activeMembersOf(members, picking).map(member => (
            <button
              key={member.id}
              type="button"
              className={css.rosterPickMember}
              data-testid={'roster-archive-' + member.id}
              title={member.summary}
              onClick={() => {
                const role = picking
                const next = effectiveHeadcount(members, capacity, role) - 1
                setPicking(null)
                run(() => setRosterCapacity({ boardId, role, count: next, archiveMemberId: member.id }))
              }}
            >
              {member.id}
            </button>
          ))}
          <button type="button" className={css.rosterStep} onClick={() => { setPicking(null) }}>
            {t('action.close')}
          </button>
        </span>
      )}
      {archived.length > 0 && (
        <span className={css.rosterArchived} data-testid="taskboard-roster-archived">
          <span className={css.rosterPickLabel}>{t('roster.archived')}</span>
          {archived.map(member => (
            <span
              key={member.id}
              className={css.rosterChip}
              data-status="archived"
              data-testid={'roster-archived-' + member.id}
            >
              <b className={css.rosterId}>{member.id}</b>
              <span className={css.rosterPartner}>{'↔ ' + member.partnerId}</span>
              <span className={css.rosterState}>{t('roster.archivedState')}</span>
              <span className={css.rosterSummary} title={member.summary}>{member.summary}</span>
              <button
                type="button"
                className={css.rosterStep}
                data-testid={'roster-restore-' + member.id}
                onClick={() => { run(() => restoreMember({ boardId, memberId: member.id })) }}
              >
                {t('roster.restore')}
              </button>
            </span>
          ))}
        </span>
      )}
      {error !== null && <span className={css.rosterError} role="alert">{error}</span>}
    </span>
  )
}
