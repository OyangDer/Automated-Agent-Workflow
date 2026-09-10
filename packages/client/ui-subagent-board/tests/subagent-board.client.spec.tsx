// @vitest-environment jsdom
/**
 * Presentation-level acceptance of the subagent classification tab: children
 * of the current session grouped by their taskboard lifecycle, badges for
 * In progress / In testing / blocked, ticket-title attribution, and the empty
 * state. Props are fed directly — no render machinery — per the
 * component-test convention.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { SubagentCatalogSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { BoardSnapshot, TicketView } from '@deepseek-ai/dsh-taskboard/client'
import { SubagentBoardView, type SubagentBoardViewProps } from '../src/client/SubagentBoardView.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

afterEach(cleanup)

/** One realistic fixture ticket. */
function ticket(overrides: Partial<TicketView> = {}): TicketView {
  return {
    id: 'ticket-0001',
    title: '登录页重构',
    description: '把登录页拆成组件',
    column: 'backlog',
    priority: 'normal',
    boardId: 'default',
    type: 'feature',
    status: 'claimed',
    failure: null,
    reviewOutcome: null,
    autoRetries: 0,
    createdAt: 1,
    updatedAt: 1,
    position: 0,
    assignee: null,
    reviewer: null,
    reviewAttempts: 0,
    lastReview: null,
    devNotes: '',
    targetBranch: '',
    filesScope: '',
    dependsOn: [],
    history: [],
    ...overrides,
  }
}

/** One realistic durable direct-child catalog row. */
function child(overrides: Record<string, unknown> = {}): SubagentCatalogSnapshot['entries'][number] {
  return {
    kind: 'child',
    id: 'child-00000001',
    activity: 'inactive',
    hasChildren: false,
    mode: 'continuable',
    label: '工单 worker',
    ...overrides,
  } as unknown as SubagentCatalogSnapshot['entries'][number]
}

interface StubProps {
  board: BoardSnapshot | null
  entries: SubagentCatalogSnapshot['entries']
  sessionId?: string
}

/** Assemble the shares the component destructures. */
function propsOf({
  board, entries, sessionId = 'session-root', setCatalogOpen,
}: StubProps & { setCatalogOpen?: (open: boolean) => void }): SubagentBoardViewProps {
  const subagentsByParent = {
    [sessionId]: { entries, parentAvailable: true, state: 'ready', error: null },
  } as unknown as Record<string, never>
  return {
    useBoard: (selector: (value: BoardSnapshot | null) => BoardSnapshot | null) => selector(board),
    useSessions: (selector: (value: unknown) => unknown) => selector({ subagentsByParent }),
    sessionId: sessionId as never,
    setCatalogOpen: setCatalogOpen ?? (() => {}),
    t,
  } as unknown as SubagentBoardViewProps
}

describe('SubagentBoardView', () => {
  it('groups children by their ticket lifecycle with badges and titles', () => {
    const inProgress = ticket({
      id: 'ticket-0001', title: '重构登录页', column: 'in_progress',
      workerAgentId: 'child-aaaa00000001', workerSessionId: 'child-aaaa00000001',
    })
    const inTesting = ticket({
      id: 'ticket-0002', title: '修复回归缺陷', column: 'in_testing',
      reviewer: { agentId: 'child-bbbb00000002', label: 'reviewer child-bbbb' },
    })
    const board: BoardSnapshot = { boardId: 'default', name: '默认看板', tickets: [inProgress, inTesting] }
    const entries = [
      child({ id: 'child-aaaa00000001', label: 'worker 甲' }),
      child({ id: 'child-bbbb00000002', label: 'reviewer 乙' }),
      child({ id: 'child-cccc00000003', label: '闲逛子代理' }),
    ]
    render(createElement(SubagentBoardView, propsOf({ board, entries })))

    // Group headers in fixed order with counts.
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('测试中')).toBeTruthy()
    expect(screen.getByText('其他')).toBeTruthy()

    // Badges name the workflow states of the matched cards.
    expect(screen.getAllByText('In progress').length).toBeGreaterThan(0)
    expect(screen.getAllByText('In testing').length).toBeGreaterThan(0)

    // Ticket titles and the no-ticket fallback row.
    expect(screen.getByText('重构登录页')).toBeTruthy()
    expect(screen.getByText('修复回归缺陷')).toBeTruthy()
    expect(screen.getByText('（无工单归属）')).toBeTruthy()

    // Child labels and short session ids render per row.
    expect(screen.getByText('worker 甲')).toBeTruthy()
    expect(screen.getByText('child-aa')).toBeTruthy()
  })

  it('shows a red blocked badge for failed workers inside In progress', () => {
    const blocked = ticket({
      id: 'ticket-0009', title: '失败的工单', column: 'in_progress',
      workerAgentId: 'child-dddd00000009', workerSessionId: 'child-dddd00000009',
      status: 'blocked',
      failure: { reason: 'worker terminated', at: 2 },
    })
    const board: BoardSnapshot = { boardId: 'default', name: '默认看板', tickets: [blocked] }
    const entries = [child({ id: 'child-dddd00000009', label: '失败 worker' })]
    render(createElement(SubagentBoardView, propsOf({ board, entries })))

    expect(screen.getByText('阻塞')).toBeTruthy()
    expect(screen.getByText('失败的工单')).toBeTruthy()
    // The blocked row stays grouped under In progress.
    expect(screen.getByText('进行中')).toBeTruthy()
  })

  it('renders the empty state when the session has no subagents', () => {
    const board: BoardSnapshot = { boardId: 'default', name: '默认看板', tickets: [] }
    render(createElement(SubagentBoardView, propsOf({ board, entries: [] })))
    expect(screen.getByText('本会话暂无子代理任务')).toBeTruthy()
    expect(screen.getByText('子代理归类')).toBeTruthy()
  })

  it('shows the loading state while the board snapshot has not arrived', () => {
    render(createElement(SubagentBoardView, propsOf({ board: null, entries: [] })))
    expect(screen.getByText('加载中…')).toBeTruthy()
  })

  it('opens the live subagent catalog while mounted and closes it on unmount', () => {
    const setCatalogOpen = vi.fn()
    const view = render(createElement(SubagentBoardView, propsOf({ board: null, entries: [], setCatalogOpen })))
    // Mount opens the parent's catalog so subagent start/end refresh the tab.
    expect(setCatalogOpen).toHaveBeenCalledWith(true)
    // Unmount closes it so an invisible tab stops consuming live updates.
    view.unmount()
    expect(setCatalogOpen).toHaveBeenLastCalledWith(false)
  })

  it('matches cards through the reviewer attribution', () => {
    const reviewing = ticket({
      id: 'ticket-0010', title: '审核中的卡片', column: 'in_testing',
      reviewer: { agentId: 'child-eeee00000010', label: 'reviewer child-eeee' },
    })
    const board: BoardSnapshot = { boardId: 'default', name: '默认看板', tickets: [reviewing] }
    const entries = [child({ id: 'child-eeee00000010', label: '审核员' })]
    render(createElement(SubagentBoardView, propsOf({ board, entries })))

    expect(screen.getByText('审核中的卡片')).toBeTruthy()
    expect(screen.getAllByText('In testing').length).toBeGreaterThan(0)
  })
})
