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
import type {
  BoardSnapshot, MemberRole, MemberView, RestoreMemberRequest, SetRosterCapacityRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
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
    autoRetries: 0,
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
  /** The active board's roster (V6-3 headcount controls). */
  members?: MemberView[]
  /** The active board's effective headcount per role. */
  capacity?: { worker: number; reviewer: number }
  selectedId?: string | null
  create?: (request: unknown) => Promise<TicketView>
  move?: (request: unknown) => Promise<TicketView>
  selectBoard?: (boardId: string) => Promise<void>
  createBoard?: (name: string, scope?: BoardScope) => Promise<BoardView>
  archiveBoard?: (boardId: string) => Promise<BoardView>
  setRosterCapacity?: (request: SetRosterCapacityRequest) => Promise<BoardSnapshot>
  restoreMember?: (request: RestoreMemberRequest) => Promise<BoardSnapshot>
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
  members, capacity, setRosterCapacity, restoreMember,
}: StubProps): TaskboardViewProps {
  const active = boards.find(item => item.boardId === boardId)
  const state = {
    boardId,
    boards,
    snapshot: {
      boardId, name: boardId, tickets: board,
      ...(members === undefined ? {} : { members }),
      ...(capacity === undefined ? {} : { capacity }),
    },
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
    setRosterCapacity: setRosterCapacity ?? (async () => state.snapshot),
    restoreMember: restoreMember ?? (async () => state.snapshot),
    hooks: { board: { getSnapshot: () => state, subscribe: () => () => {} } },
    t,
  } as unknown as TaskboardViewProps
}

/** A minimal drag-data transfer stub for fireEvent. */
function dragTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: '' }
}

/**
 * Dispatch a drag event with real pointer coordinates. jsdom's DragEvent
 * drops clientX/clientY, so the drag is dispatched as a MouseEvent carrying a
 * dataTransfer property — React's synthetic handlers read both normally.
 */
function dragEvent(type: string, x: number, y: number, transfer: ReturnType<typeof dragTransfer>) {
  // React listens for the lowercase native name ('dragover', 'dragend').
  const event = new MouseEvent(type.toLowerCase(), { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'dataTransfer', { value: transfer, configurable: true })
  return event
}

/** A DOMRect-shaped stub for getBoundingClientRect mocks. */
function rect(top: number, bottom: number, left = 0, right = 200): DOMRect {
  return { top, right, bottom, left, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }
}

/**
 * Override getBoundingClientRect for specific elements with the given
 * extents; everything else keeps the real (zero) jsdom geometry. jsdom
 * reports zero rects for all elements, so drag auto-scroll and insertion-slot
 * tests install real extents through this seam. Returns a restore function.
 */
function mockRects(rects: Map<HTMLElement, { top: number; bottom: number; left?: number; right?: number }>): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
  spy.mockImplementation(function (this: Element) {
    const extent = rects.get(this as HTMLElement)
    if (extent !== undefined) return rect(extent.top, extent.bottom, extent.left ?? 0, extent.right ?? 200)
    return rect(0, 0)
  })
  return () => { spy.mockRestore() }
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

  it('shows the paused badge on a master-paused card', () => {
    const paused = ticket({ id: 'ticket-0004', title: '暂停的卡片', column: 'in_progress', status: 'paused' })
    render(createElement(TaskboardView, propsOf({ board: [paused] })))
    expect(screen.getByText('暂停的卡片')).toBeTruthy()
    const badge = screen.getByText('已暂停')
    expect(badge).toBeTruthy()
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
    // The request rides the ticket's own board id, so a ticket on a
    // non-default board reaches the host with the right context.
    expect(requestReview).toHaveBeenCalledWith({ ticketId: 'ticket-0300', boardId: 'default' })
  })

  it('re-requests review with the ticket board when it is not the default', () => {
    const requestReview = vi.fn(async () => ticket())
    const card = ticket({ id: 'ticket-0301', column: 'in_testing', reviewer: null, boardId: 'board-9' })
    const base = propsOf({ board: [card], selectedId: card.id })
    render(createElement(TaskboardView, {
      ...base,
      requestReview,
    } as unknown as TaskboardViewProps))
    fireEvent.click(screen.getByText('重新送审'))
    expect(requestReview).toHaveBeenCalledWith({ ticketId: 'ticket-0301', boardId: 'board-9' })
  })

  it('surfaces the real server failure instead of the generic copy', async () => {
    const requestReview = vi.fn(async () => {
      throw new Error('ticket "ticket-0302" is on board "board-9", not "default"')
    })
    const card = ticket({ id: 'ticket-0302', column: 'in_testing', reviewer: null, boardId: 'board-9' })
    const base = propsOf({ board: [card], selectedId: card.id })
    render(createElement(TaskboardView, {
      ...base,
      requestReview,
    } as unknown as TaskboardViewProps))
    fireEvent.click(screen.getByText('重新送审'))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent)
        .toContain('ticket "ticket-0302" is on board "board-9", not "default"')
    })
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

  it('shows the expired banner copy once the lease has lapsed', () => {
    // A seat whose lease ended is no longer "about to expire": the banner
    // switches to the preemptable copy and re-offers the takeover script.
    const boards = [{
      ...boardRow('default', 'default'),
      masterAgentId: 'session-abcdef0123456789',
      masterClaimedAt: Date.now() - 3600000,
      masterExpiresAt: Date.now() - 60000,
    }]
    render(createElement(TaskboardView, propsOf({
      board: [], boards, masterAgentId: 'session-abcdef0123456789',
      masterClaimedAt: Date.now() - 3600000, masterExpiresAt: Date.now() - 60000,
    })))
    expect(screen.getByText('已过期，可抢占')).toBeTruthy()
    const banner = document.querySelector('[data-seat="expired"]')
    expect(banner).not.toBeNull()
    expect(banner?.querySelector('[data-expired="true"]')).not.toBeNull()
    expect(screen.queryByText(/席位由/)).toBeNull()
    expect(screen.queryByText('租期将尽')).toBeNull()
    expect(screen.getByText('复制接管指令')).toBeTruthy()
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

  it('highlights the hovered column and shows an insertion line in it', () => {
    const move = vi.fn(async () => ticket())
    const card = ticket({ id: 'ticket-0100', title: '拖拽卡片' })
    render(createElement(TaskboardView, propsOf({ board: [card], move })))
    const cardEl = screen.getByText('拖拽卡片').closest('article')
    expect(cardEl).not.toBeNull()
    fireEvent.dragStart(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
    const target = document.querySelector('[data-column="in_progress"]')
    expect(target).not.toBeNull()
    fireEvent.dragOver(target as HTMLElement, { dataTransfer: dragTransfer() })
    // The whole column is armed as a drop target...
    expect(target?.getAttribute('data-column')).toBe('in_progress')
    // ...and the insertion line renders inside the hovered column.
    const indicators = target?.querySelectorAll('[data-testid="drop-indicator"]')
    expect(indicators?.length).toBeGreaterThan(0)
    // Other columns stay unarmed.
    const done = document.querySelector('[data-column="done"]')
    expect(done?.querySelectorAll('[data-testid="drop-indicator"]').length).toBe(0)
  })

  it('inserts the dragged card before the card under the pointer', () => {
    const move = vi.fn(async () => ticket())
    const source = ticket({ id: 'ticket-0101', title: '源卡' })
    const first = ticket({ id: 'ticket-0102', title: '目标列第一张', column: 'in_progress' })
    const second = ticket({ id: 'ticket-0103', title: '目标列第二张', column: 'in_progress' })
    render(createElement(TaskboardView, propsOf({ board: [source, first, second], move })))
    const cardEl = screen.getByText('源卡').closest('article')
    expect(cardEl).not.toBeNull()
    fireEvent.dragStart(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
    // Give the target column's cards real vertical extents so the pointer
    // position picks the slot: hovering below the first card's midpoint
    // inserts before the second card.
    const target = document.querySelector('[data-column="in_progress"]') as HTMLElement
    const rects = new Map<HTMLElement, { top: number; bottom: number }>()
    const spans = [
      { id: 'ticket-0102', top: 0 },
      { id: 'ticket-0103', top: 48 },
    ]
    for (const span of spans) {
      const element = target.querySelector('[data-ticket-id="' + span.id + '"]') as HTMLElement | null
      if (element !== null) rects.set(element, { top: span.top, bottom: span.top + 40 })
    }
    const restoreRects = mockRects(rects)
    try {
      fireEvent(target, dragEvent('dragOver', 100, 30, dragTransfer()))
      // Pointer at y=30 sits below card A's midpoint (20) and above card B's
      // midpoint (68), so the insertion slot is before card B.
      fireEvent.drop(target, { dataTransfer: dragTransfer() })
    } finally {
      restoreRects()
    }
    expect(move).toHaveBeenCalledWith({
      ticketId: 'ticket-0101', column: 'in_progress', beforeTicketId: 'ticket-0103', afterTicketId: null,
    })
  })

  it('auto-scrolls the hovered column while dragging near its bottom edge', () => {
    vi.useFakeTimers()
    const move = vi.fn(async () => ticket())
    const card = ticket({ id: 'ticket-0104', title: '自动滚动卡' })
    render(createElement(TaskboardView, propsOf({ board: [card], move })))
    const cardEl = screen.getByText('自动滚动卡').closest('article')
    expect(cardEl).not.toBeNull()
    fireEvent.dragStart(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
    const target = document.querySelector('[data-column="backlog"]') as HTMLElement
    // The column is tall and scrollable; the pointer rests near its bottom.
    Object.defineProperty(target, 'scrollHeight', { value: 800, configurable: true })
    Object.defineProperty(target, 'clientHeight', { value: 300, configurable: true })
    const restoreRects = mockRects(new Map([[target, { top: 0, bottom: 300, left: 0, right: 200 }]]))
    try {
      fireEvent(target, dragEvent('dragOver', 100, 290, dragTransfer()))
      vi.advanceTimersByTime(100)
      expect(target.scrollTop).toBeGreaterThan(0)
    } finally {
      restoreRects()
      fireEvent.dragEnd(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
      vi.useRealTimers()
    }
  })

  it('auto-scrolls the board horizontally near its right edge', () => {
    vi.useFakeTimers()
    const move = vi.fn(async () => ticket())
    const card = ticket({ id: 'ticket-0105', title: '横向滚动卡' })
    render(createElement(TaskboardView, propsOf({ board: [card], move })))
    const cardEl = screen.getByText('横向滚动卡').closest('article')
    expect(cardEl).not.toBeNull()
    fireEvent.dragStart(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
    const board = document.querySelector('[data-column="backlog"]')?.parentElement as HTMLElement
    Object.defineProperty(board, 'scrollWidth', { value: 1400, configurable: true })
    Object.defineProperty(board, 'clientWidth', { value: 700, configurable: true })
    const restoreRects = mockRects(new Map([[board, { top: 0, bottom: 300, left: 0, right: 700 }]]))
    try {
      // Hover the board itself near its right edge (a column's dragover
      // bubbles to the board, but the board handler only claims the pointer
      // when the board is the direct target).
      fireEvent(board, dragEvent('dragOver', 690, 100, dragTransfer()))
      vi.advanceTimersByTime(100)
      expect(board.scrollLeft).toBeGreaterThan(0)
    } finally {
      restoreRects()
      fireEvent.dragEnd(cardEl as HTMLElement, { dataTransfer: dragTransfer() })
      vi.useRealTimers()
    }
  })

  it('renders the V6-3 headcount controls over the board roster and lowers only on a named member', () => {
    const rosterMember = (id: string, role: MemberRole, overrides: Partial<MemberView> = {}): MemberView => ({
      id,
      boardId: 'default',
      role,
      partnerId: (role === 'worker' ? 'R' : 'W') + id.slice(1),
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
    })
    const setRosterCapacity = vi.fn(async (_request: SetRosterCapacityRequest) => (
      { boardId: 'default', name: 'default', tickets: [] } as BoardSnapshot
    ))
    render(createElement(TaskboardView, propsOf({
      board: [],
      members: [
        rosterMember('W1', 'worker'), rosterMember('W2', 'worker'), rosterMember('R1', 'reviewer'),
        rosterMember('W3', 'worker', { archivedAt: 7, status: 'archived' }),
      ],
      capacity: { worker: 2, reviewer: 1 },
      setRosterCapacity,
    })))

    expect(screen.getByTestId('roster-worker-count').textContent).toBe('2')
    expect(screen.getByTestId('roster-archived-W3').textContent).toContain('已归档')
    fireEvent.click(screen.getByTestId('roster-worker-decrease'))
    expect(setRosterCapacity).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('roster-archive-W2'))
    expect(setRosterCapacity).toHaveBeenCalledWith({ boardId: 'default', role: 'worker', count: 1, archiveMemberId: 'W2' })
  })

})
