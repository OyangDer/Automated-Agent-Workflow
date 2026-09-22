// @vitest-environment jsdom
/**
 * Presentation-level acceptance of the V6-3 headcount panel: the per-role
 * counts, the raise that creates a member, the lowering that asks WHICH member
 * to archive (never picking one), the archived list with its restore button,
 * and the board's refusal text. Props are fed directly — no render machinery
 * and no Remote transport — per the component-test convention.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type {
  BoardSnapshot, MemberRole, MemberView, RestoreMemberRequest, SetRosterCapacityRequest,
} from '@deepseek-ai/dsh-taskboard/client'
import { effectiveHeadcount, RosterControls } from '../src/client/RosterControls.tsx'
import type { TaskboardT } from '../src/client/TicketCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as unknown as TaskboardT

/** One roster member fixture; active unless `archived` is given. */
function member(id: string, role: MemberRole, overrides: Partial<MemberView> = {}): MemberView {
  const index = id.slice(1)
  return {
    id,
    boardId: 'default',
    role,
    partnerId: (role === 'worker' ? 'R' : 'W') + index,
    sessionId: '',
    summary: id + ' summary',
    modules: [],
    recentTickets: [],
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    currentTicketId: null,
    ...overrides,
  }
}

/** One recorded mutation. */
type Call = readonly [kind: 'capacity' | 'restore', request: SetRosterCapacityRequest | RestoreMemberRequest]

/** A stub panel harness: recorded calls plus the refusal the next call raises. */
function harness(members: MemberView[], capacity?: { worker: number; reviewer: number }) {
  const calls: Call[] = []
  let refusal: Error | null = null
  const snapshot = { boardId: 'default', name: 'default', tickets: [] } as BoardSnapshot
  return {
    calls,
    refuse: (message: string) => { refusal = new Error(message) },
    capacity,
    members,
    props: {
      members,
      capacity,
      boardId: 'default',
      setRosterCapacity: async (request: SetRosterCapacityRequest) => {
        calls.push(['capacity', request])
        if (refusal !== null) throw refusal
        return snapshot
      },
      restoreMember: async (request: RestoreMemberRequest) => {
        calls.push(['restore', request])
        if (refusal !== null) throw refusal
        return snapshot
      },
      t,
    },
  }
}

describe('RosterControls', () => {
  it('renders the per-role headcount and raises one slot without naming a member', () => {
    const stub = harness([member('W1', 'worker'), member('R1', 'reviewer')], { worker: 2, reviewer: 3 })
    render(createElement(RosterControls, stub.props))

    expect(screen.getByTestId('roster-worker-count').textContent).toBe('2')
    expect(screen.getByTestId('roster-reviewer-count').textContent).toBe('3')
    fireEvent.click(screen.getByTestId('roster-worker-increase'))
    expect(stub.calls).toEqual([['capacity', { boardId: 'default', role: 'worker', count: 3 }]])
  })

  it('lowers only after the user names the member: the panel never picks one', () => {
    const stub = harness(
      [member('W1', 'worker'), member('W2', 'worker'), member('R1', 'reviewer')],
      { worker: 2, reviewer: 1 },
    )
    render(createElement(RosterControls, stub.props))

    fireEvent.click(screen.getByTestId('roster-worker-decrease'))
    // Nothing is archived yet: the panel asks which member instead.
    expect(stub.calls).toEqual([])
    expect(screen.getByTestId('taskboard-roster-picker').textContent).toContain('要归档哪一个worker')
    expect(screen.queryByTestId('roster-archive-R1')).toBeNull()
    fireEvent.click(screen.getByTestId('roster-archive-W2'))
    expect(stub.calls).toEqual([['capacity', {
      boardId: 'default', role: 'worker', count: 1, archiveMemberId: 'W2',
    }]])
    expect(screen.queryByTestId('taskboard-roster-picker')).toBeNull()
  })

  it('refuses to lower below one slot', () => {
    const stub = harness([member('W1', 'worker'), member('R1', 'reviewer')], { worker: 1, reviewer: 1 })
    render(createElement(RosterControls, stub.props))
    expect(screen.getByTestId('roster-worker-decrease')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('roster-reviewer-decrease')).toHaveProperty('disabled', true)
  })

  it('shows the archived members with their record and restores one by id', () => {
    const archived = member('W2', 'worker', {
      archivedAt: 42, status: 'archived', modules: ['parser'], summary: '熟悉 parser；目前空闲',
    })
    const stub = harness([
      member('W1', 'worker'), archived, member('R1', 'reviewer'), member('R2', 'reviewer'),
    ], { worker: 1, reviewer: 2 })
    render(createElement(RosterControls, stub.props))

    const chip = screen.getByTestId('roster-archived-W2')
    expect(chip.textContent).toContain('已归档')
    // The record survives the archive: number, partner and summary are on the chip.
    expect(chip.textContent).toContain('W2')
    expect(chip.textContent).toContain('R2')
    expect(chip.textContent).toContain('熟悉 parser')
    fireEvent.click(screen.getByTestId('roster-restore-W2'))
    expect(stub.calls).toEqual([['restore', { boardId: 'default', memberId: 'W2' }]])
  })

  it('surfaces the board refusal (a member executing a card) without archiving anything', async () => {
    const stub = harness(
      [member('W1', 'worker', { status: 'busy', currentTicketId: 'ticket-7' }), member('W2', 'worker')],
      { worker: 2, reviewer: 1 },
    )
    stub.refuse('refusing to archive W1 (worker): it is executing card "ticket-7"')
    render(createElement(RosterControls, stub.props))

    fireEvent.click(screen.getByTestId('roster-worker-decrease'))
    fireEvent.click(screen.getByTestId('roster-archive-W1'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ticket-7')
    expect(stub.calls).toEqual([['capacity', {
      boardId: 'default', role: 'worker', count: 1, archiveMemberId: 'W1',
    }]])
  })

  it('falls back to the active member count when an older host serves no capacity', () => {
    const members = [member('W1', 'worker'), member('W2', 'worker', { archivedAt: 9, status: 'archived' })]
    expect(effectiveHeadcount(members, undefined, 'worker')).toBe(1)
    expect(effectiveHeadcount(members, { worker: 4, reviewer: 2 }, 'worker')).toBe(4)
    const stub = harness(members, undefined)
    render(createElement(RosterControls, stub.props))
    expect(screen.getByTestId('roster-worker-count').textContent).toBe('1')
  })
})
