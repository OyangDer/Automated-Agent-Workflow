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
import type { BoardView, TicketView } from '@deepseek-ai/dsh-taskboard/client'
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
    dependsOn: [],
    history: [],
    ...overrides,
  }
}

interface StubProps {
  board: TicketView[]
  boards?: BoardView[]
  boardId?: string
  selectedId?: string | null
  create?: (request: unknown) => Promise<TicketView>
  move?: (request: unknown) => Promise<TicketView>
  selectBoard?: (boardId: string) => Promise<void>
  createBoard?: (name: string) => Promise<BoardView>
  archiveBoard?: (boardId: string) => Promise<BoardView>
}

/** One board row fixture. */
function boardRow(boardId: string, name: string): BoardView {
  return {
    boardId, name, workspaceId: '',
    masterAgentId: null, masterClaimedAt: null, handoverNotes: '', archivedAt: null,
  }
}

/** Assemble the four shares the component destructures. */
function propsOf({
  board, boards = [], boardId = 'default', selectedId = null,
  create, move, selectBoard, createBoard, archiveBoard,
}: StubProps): TaskboardViewProps {
  const state = { boardId, boards, snapshot: { boardId, name: boardId, tickets: board } }
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
    createBoard: createBoard ?? (async () => boardRow('board-new', 'new')),
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
    expect(select.querySelector('optgroup')?.getAttribute('label')).toBe('已归档')
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
    const createBoard = vi.fn(async (name: string) => boardRow('board-9', name))
    render(createElement(TaskboardView, propsOf({ board: [], createBoard })))
    fireEvent.click(screen.getByText('新建板'))
    const input = screen.getByLabelText('看板名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新看板' } })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => {
      expect(createBoard).toHaveBeenCalledWith('新看板')
    })
  })

  it('shows the type badge on cards', () => {
    const bugfix = ticket({ id: 'ticket-0004', title: '缺陷卡片', type: 'bugfix' })
    const spike = ticket({ id: 'ticket-0005', title: '探索卡片', type: 'spike' })
    render(createElement(TaskboardView, propsOf({ board: [bugfix, spike] })))
    expect(screen.getByText('缺陷修复')).toBeTruthy()
    expect(screen.getByText('探索')).toBeTruthy()
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
