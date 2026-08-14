// @vitest-environment jsdom
/**
 * Presentation-level acceptance of the taskboard tab: five column headers,
 * per-column card placement, detail-panel opening with review state,
 * drag-and-drop moves, and the new-ticket form. Props are fed directly —
 * no render machinery — per the component-test convention.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { TicketView } from '@deepseek-ai/dsh-taskboard/client'
import type { BoardScope, BoardView } from '../src/client/contract.ts'
import { TaskboardView, type TaskboardViewProps } from '../src/client/TaskboardView.tsx'
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
    createdAt: 1,
    updatedAt: 1,
    position: 0,
    assignee: null,
    reviewer: null,
    reviewAttempts: 0,
    lastReview: null,
    reviewOutcome: null,
    devNotes: '',
    targetBranch: '',
    filesScope: '',
    dependsOn: [],
    history: [],
    ...overrides,
  }
}

interface StubProps {
  board: TicketView[]
  boards?: BoardView[]
  boardId?: string
  /** Owning workspace of the session this board list belongs to. */
  workspaceId?: string
  /** Active board's scope; derived from the board list when omitted. */
  scope?: BoardScope
  /** Active board's owning session id; derived when omitted. */
  ownerSessionId?: string | null
  /** Active board's master seat holder; derived when omitted. */
  masterAgentId?: string | null
  /** When the active board's master seat was claimed; derived when omitted. */
  masterClaimedAt?: number | null
  /** When the active board's master lease expires; derived when omitted. */
  masterExpiresAt?: number | null
  selectedId?: string | null
  create?: (request: unknown) => Promise<TicketView>
  move?: (request: unknown) => Promise<TicketView>
  selectBoard?: (boardId: string) => Promise<void>
  createBoard?: (name: string, scope?: BoardScope) => Promise<BoardView>
  archiveBoard?: (boardId: string) => Promise<BoardView>
}

/**
 * One board row fixture; project-shared (workspaceId '', scope 'project')
 * unless overridden. A session-private board passes its owning session id.
 */
function boardRow(
  boardId: string,
  name: string,
  workspaceId = '',
  scope: BoardScope = 'project',
  ownerSessionId: string | null = null,
): BoardView {
  return {
    boardId, name, workspaceId, scope, ownerSessionId,
    masterAgentId: null, masterClaimedAt: null, masterExpiresAt: null, handoverNotes: '', archivedAt: null,
  }
}

/** Assemble the four shares the component destructures. */
function propsOf({
  board, boards = [], boardId = 'default', workspaceId = '', scope, ownerSessionId,
  masterAgentId, masterClaimedAt, masterExpiresAt,
  selectedId = null, create, move, selectBoard, createBoard, archiveBoard,
}: StubProps): TaskboardViewProps {
  const active = boards.find(item => item.boardId === boardId)
  const state = {
    boardId,
    boards,
    snapshot: { boardId, name: boardId, tickets: board },
    workspaceId,
    scope: scope ?? active?.scope ?? 'project',
    ownerSessionId: ownerSessionId !== undefined ? ownerSessionId : (active?.ownerSessionId ?? null),
    masterAgentId: masterAgentId !== undefined ? masterAgentId : (active?.masterAgentId ?? null),
    masterClaimedAt: masterClaimedAt !== undefined ? masterClaimedAt : (active?.masterClaimedAt ?? null),
    masterExpiresAt: masterExpiresAt !== undefined ? masterExpiresAt : (active?.masterExpiresAt ?? null),
  }
  const storeState = { selectedId }
  return {
    useBoard: (selector: (value: typeof state) => typeof state) => selector(state),
    useStore: (selector: (value: { selectedId: string | null }) => string | null) => selector(storeState),
    actions: { select: vi.fn() },
    create: create ?? (async () => ticket()),
    move: move ?? (async () => ticket()),
    edit: async () => ticket(),
    remove: async () => ({ removedId: 'ticket-0001' }),
    requestReview: async () => ticket(),
    refresh: () => {},
    selectBoard: selectBoard ?? (async () => {}),
    createBoard: createBoard ?? (async (name: string, picked: BoardScope = 'session') =>
      boardRow('board-new', name, picked === 'session' ? '' : 'workspace-1', picked)),
    archiveBoard: archiveBoard ?? (async () => boardRow('default', 'default')),
    hooks: { board: { getSnapshot: () => state, subscribe: () => () => {} } },
    t,
  } as unknown as TaskboardViewProps
}

/** A minimal drag-data transfer stub for fireEvent. */
function dragTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: '' }
}

describe('TaskboardView', () => {
  it('renders the five canonical columns in order', () => {
    render(createElement(TaskboardView, propsOf({ board: [] })))
    const headers = screen.getAllByRole('heading')
    const columns = ['Backlog', 'Not started', 'In progress', 'In testing', 'Done']
    for (const name of columns) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    expect(headers.length).toBeGreaterThan(0)
  })

  it('places cards in their column and shows review badges', () => {
    const backlog = ticket({ id: 'ticket-0001', title: '待办卡片' })
    const inTesting = ticket({
      id: 'ticket-0002', title: '测试中的卡片', column: 'in_testing',
      reviewer: { agentId: 'r1', label: 'reviewer abcdef12' },
    })
    const rejected = ticket({
      id: 'ticket-0003', title: '被驳回的卡片', column: 'in_progress', reviewAttempts: 1,
      lastReview: {
        outcome: 'rejected', feedback: '缺少错误处理', attempt: 1, at: 1,
        reviewer: { agentId: 'r1', label: 'reviewer abcdef12' },
      },
    })
    render(createElement(TaskboardView, propsOf({ board: [backlog, inTesting, rejected] })))
    expect(screen.getByText('待办卡片')).toBeTruthy()
    expect(screen.getByText('测试中的卡片')).toBeTruthy()
    expect(screen.getByText('被驳回的卡片')).toBeTruthy()
    expect(screen.getByText('审核中')).toBeTruthy()
    expect(screen.getByText('已驳回，返修中')).toBeTruthy()
    expect(screen.getByText('审核 1 次')).toBeTruthy()
  })

  it('opens the detail panel on card click through the viewing store', () => {
    const card = ticket({ title: '细节卡片', devNotes: '已实现并自测' })
    render(createElement(TaskboardView, propsOf({ board: [card] })))
    fireEvent.click(screen.getByText('细节卡片'))
    // Selection lives in the store; the test drives it through props, so a
    // second render with the selection set shows the panel.
    cleanup()
    render(createElement(TaskboardView, propsOf({ board: [card], selectedId: card.id })))
    expect(screen.getByRole('dialog', { name: '细节卡片' })).toBeTruthy()
    expect(screen.getByText('开发备注')).toBeTruthy()
    expect(screen.getByText('已实现并自测')).toBeTruthy()
  })

  it('shows the rejection feedback inside the detail panel', () => {
    const card = ticket({
      id: 'ticket-0009',
      column: 'in_progress',
      reviewAttempts: 1,
      lastReview: {
        outcome: 'rejected', feedback: '解析函数缺少错误处理', attempt: 1, at: 2,
        reviewer: { agentId: 'r9', label: 'reviewer 99999999' },
      },
    })
    render(createElement(TaskboardView, propsOf({ board: [card], selectedId: card.id })))
    expect(screen.getByText('解析函数缺少错误处理')).toBeTruthy()
    expect(screen.getByText('最近审核 · 驳回')).toBeTruthy()
  })

  it('moves a card through drag and drop', () => {
    const move = vi.fn(async () => ticket({ column: 'in_progress' }))
    const card = ticket({ id: 'ticket-0100', title: '拖拽卡片' })
    render(createElement(TaskboardView, propsOf({ board: [card], move })))
    const cardEl = screen.getByText('拖拽卡片').closest('article')
    expect(cardEl).not.toBeNull()
    fireEvent.dragStart(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
    // Columns render as sections with data-column attributes.
    const target = document.querySelector('[data-column="in_progress"]')
    expect(target).not.toBeNull()
    fireEvent.dragOver(target as HTMLElement, { dataTransfer: dragTransfer() })
    fireEvent.drop(target as HTMLElement, { dataTransfer: dragTransfer() })
    expect(move).toHaveBeenCalledWith({
      ticketId: 'ticket-0100', column: 'in_progress', beforeTicketId: null, afterTicketId: null,
    })
  })

  it('creates a ticket through the new-ticket form', async () => {
    const create = vi.fn(async () => ticket({ id: 'ticket-0200', title: '新功能' }))
    render(createElement(TaskboardView, propsOf({ board: [], create })))
    fireEvent.click(screen.getByText('新建工单'))
    const dialog = screen.getByRole('dialog', { name: '新建工单' })
    const input = dialog.querySelector('input')
    expect(input).not.toBeNull()
    fireEvent.change(input as HTMLInputElement, { target: { value: '新功能' } })
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: '新功能', priority: 'normal' }))
    })
  })

  it('offers re-review from the detail panel for In testing tickets', () => {
    const requestReview = vi.fn(async () => ticket())
    const card = ticket({ id: 'ticket-0300', column: 'in_testing', reviewer: null })
    const base = propsOf({ board: [card], selectedId: card.id })
    render(createElement(TaskboardView, {
      ...base,
      requestReview,
    } as unknown as TaskboardViewProps))
    fireEvent.click(screen.getByText('重新送审'))
    expect(requestReview).toHaveBeenCalledWith({ ticketId: 'ticket-0300' })
  })

  it('renders the board selector with active and archived boards', () => {
    const boards: BoardView[] = [
      boardRow('default', 'default'),
      boardRow('board-1', '迭代一'),
      { ...boardRow('board-2', '迭代二'), archivedAt: 2 },
    ]
    render(createElement(TaskboardView, propsOf({ board: [], boards, boardId: 'board-1' })))
    const select = screen.getByLabelText('选择看板') as HTMLSelectElement
    expect(select.value).toBe('board-1')
    const values = Array.from(select.options).map(option => option.value)
    expect(values).toEqual(['default', 'board-1', 'board-2'])
    // Active project-shared boards land in the project group; the archived
    // one collapses into its own group.
    const groupLabels = Array.from(select.querySelectorAll('optgroup')).map(group => group.getAttribute('label'))
    expect(groupLabels).toEqual(['项目共享板', '已归档'])
  })

  it('filters the board selector to the current workspace', () => {
    // A board list spanning several workspaces (plus the shared unowned
    // default): only this project's boards render, active and archived.
    const boards: BoardView[] = [
      boardRow('default', 'default'),
      boardRow('board-own', '本项目的板', 'workspace-1'),
      boardRow('board-other', '他项目的板', 'workspace-2'),
      { ...boardRow('board-own-archived', '本项目已归档', 'workspace-1'), archivedAt: 5 },
      { ...boardRow('board-other-archived', '他项目已归档', 'workspace-2'), archivedAt: 6 },
    ]
    render(createElement(TaskboardView, propsOf({
      board: [], boards, boardId: 'board-own', workspaceId: 'workspace-1',
    })))
    const select = screen.getByLabelText('选择看板') as HTMLSelectElement
    expect(select.value).toBe('board-own')
    const values = Array.from(select.options).map(option => option.value)
    expect(values).toEqual(['default', 'board-own', 'board-own-archived'])
    const groupLabels = Array.from(select.querySelectorAll('optgroup')).map(group => group.getAttribute('label'))
    expect(groupLabels).toEqual(['项目共享板', '已归档'])
    // Other workspaces' boards never appear, not even as archived labels.
    expect(screen.queryByText('他项目的板')).toBeNull()
    expect(screen.queryByText('他项目已归档')).toBeNull()
  })

  it('switches boards through the selector, calling selectBoard', () => {
    const selectBoard = vi.fn(async () => {})
    const boards = [boardRow('default', 'default'), boardRow('board-1', '迭代一')]
    render(createElement(TaskboardView, propsOf({ board: [], boards, selectBoard })))
    const select = screen.getByLabelText('选择看板') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'board-1' } })
    expect(selectBoard).toHaveBeenCalledWith('board-1')
  })

  it('creates a board through the inline form', async () => {
    const createBoard = vi.fn(async (name: string, scope: BoardScope = 'session') =>
      boardRow('board-9', name, scope === 'session' ? '' : 'workspace-1', scope))
    render(createElement(TaskboardView, propsOf({ board: [], createBoard })))
    fireEvent.click(screen.getByText('新建板'))
    const input = screen.getByLabelText('看板名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新看板' } })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => {
      expect(createBoard).toHaveBeenCalledWith('新看板', 'session')
    })
  })

  it('groups the board selector by scope with badges', () => {
    const boards: BoardView[] = [
      boardRow('default', 'default'),
      boardRow('board-private', '草稿板', '', 'session', 'session-1'),
      boardRow('board-shared', '团队板', 'workspace-1'),
      { ...boardRow('board-private-archived', '旧草稿', '', 'session', 'session-1'), archivedAt: 9 },
    ]
    render(createElement(TaskboardView, propsOf({
      board: [], boards, boardId: 'board-private', workspaceId: 'workspace-1',
    })))
    const select = screen.getByLabelText('选择看板') as HTMLSelectElement
    const groups = Array.from(select.querySelectorAll('optgroup'))
    expect(groups.map(group => group.getAttribute('label'))).toEqual(['本会话私有板', '项目共享板', '已归档'])
    // Session-private boards under the session group, project boards under
    // the project group, archived ones collapsed at the end.
    expect(Array.from(groups[0]!.querySelectorAll('option')).map(option => option.value)).toEqual(['board-private'])
    expect(Array.from(groups[1]!.querySelectorAll('option')).map(option => option.value)).toEqual(['default', 'board-shared'])
    expect(Array.from(groups[2]!.querySelectorAll('option')).map(option => option.value)).toEqual(['board-private-archived'])
    // Every option carries a scope badge next to its name.
    expect(select.querySelector('option[value="board-private"]')?.textContent).toContain('（本会话私有）')
    expect(select.querySelector('option[value="board-shared"]')?.textContent).toContain('（项目共享）')
    expect(select.querySelector('option[value="default"]')?.textContent).toContain('（项目共享）')
  })

  it('shows the active board scope badge', () => {
    const boards: BoardView[] = [
      boardRow('default', 'default'),
      boardRow('board-private', '草稿板', '', 'session', 'session-1'),
    ]
    const { rerender } = render(createElement(TaskboardView, propsOf({
      board: [], boards, boardId: 'board-private',
    })))
    // The active session-private board reads its scope in the header badge.
    const badge = screen.getByText('本会话私有')
    expect(badge.getAttribute('data-scope')).toBe('session')
    rerender(createElement(TaskboardView, propsOf({ board: [], boards, boardId: 'default' })))
    expect(screen.getByText('项目共享').getAttribute('data-scope')).toBe('project')
  })

  it('creates a board with the chosen scope through the inline form', async () => {
    const createBoard = vi.fn(async (name: string, scope: BoardScope = 'session') =>
      boardRow('board-9', name, scope === 'session' ? '' : 'workspace-1', scope))
    render(createElement(TaskboardView, propsOf({ board: [], createBoard })))
    fireEvent.click(screen.getByText('新建板'))
    // The scope picker defaults to the session scope.
    const scopeSelect = screen.getByLabelText('作用域') as HTMLSelectElement
    expect(scopeSelect.value).toBe('session')
    const input = screen.getByLabelText('看板名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '团队板' } })
    fireEvent.change(scopeSelect, { target: { value: 'project' } })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => {
      expect(createBoard).toHaveBeenCalledWith('团队板', 'project')
    })
  })

  it('shows the type badge on cards', () => {
    const bugfix = ticket({ id: 'ticket-0004', title: '缺陷卡片', type: 'bugfix' })
    const spike = ticket({ id: 'ticket-0005', title: '探索卡片', type: 'spike' })
    render(createElement(TaskboardView, propsOf({ board: [bugfix, spike] })))
    expect(screen.getByText('缺陷修复')).toBeTruthy()
    expect(screen.getByText('探索')).toBeTruthy()
  })

  it('shows the vacant seat banner with a copy-takeover button', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const boards = [boardRow('default', 'default')]
    render(createElement(TaskboardView, propsOf({ board: [], boards })))
    expect(screen.getByText('席位空缺')).toBeTruthy()
    fireEvent.click(screen.getByText('复制接管指令'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    const script = writeText.mock.calls[0]![0]
    expect(script).toContain('taskboard_claim_master')
    expect(script).toContain('boardId "default"')
    expect(script).toContain('taskboard_assign')
    expect(script).toContain('taskboard_resolve_review')
    await vi.waitFor(() => {
      expect(screen.getByText('已复制')).toBeTruthy()
    })
  })

  it('shows the held banner with the master short id and the expiring warning', () => {
    const boards = [{
      ...boardRow('default', 'default'),
      masterAgentId: 'session-abcdef0123456789',
      masterClaimedAt: Date.now() - 850000,
      masterExpiresAt: Date.now() + 50000,
    }]
    render(createElement(TaskboardView, propsOf({
      board: [], boards, boardId: 'default', masterAgentId: 'session-abcdef0123456789',
      masterClaimedAt: Date.now() - 850000, masterExpiresAt: Date.now() + 50000,
    })))
    const text = screen.getByText(/席位由 abcdef01 持有/)
    expect(text.getAttribute('data-expiring')).toBe('true')
    expect(screen.getByText(/租期将尽/)).toBeTruthy()
    expect(screen.queryByText('复制接管指令')).toBeNull()
  })

  it('shows the held banner without the expiring warning inside the lease', () => {
    const boards = [{
      ...boardRow('default', 'default'),
      masterAgentId: 'session-abcdef0123456789',
      masterClaimedAt: Date.now() - 60000,
      masterExpiresAt: Date.now() + 600000,
    }]
    render(createElement(TaskboardView, propsOf({
      board: [], boards, masterAgentId: 'session-abcdef0123456789',
      masterClaimedAt: Date.now() - 60000, masterExpiresAt: Date.now() + 600000,
    })))
    expect(screen.getByText(/席位由 abcdef01 持有/)).toBeTruthy()
    expect(screen.queryByText('租期将尽')).toBeNull()
  })

  it('reports a failed clipboard copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied') }) },
      configurable: true,
    })
    const boards = [boardRow('default', 'default')]
    render(createElement(TaskboardView, propsOf({ board: [], boards })))
    fireEvent.click(screen.getByText('复制接管指令'))
    await vi.waitFor(() => {
      expect(screen.getByText('复制失败')).toBeTruthy()
    })
  })

  it('archives the active board after inline confirmation', async () => {
    const archiveBoard = vi.fn(async (boardId: string) => ({ ...boardRow(boardId, boardId), archivedAt: 3 }))
    const boards = [boardRow('default', 'default'), boardRow('board-1', '迭代一')]
    render(createElement(TaskboardView, propsOf({ board: [], boards, boardId: 'board-1', archiveBoard })))
    fireEvent.click(screen.getByText('归档'))
    fireEvent.click(screen.getByText('确认'))
    await vi.waitFor(() => {
      expect(archiveBoard).toHaveBeenCalledWith('board-1')
    })
  })
})
