// @vitest-environment jsdom
/**
 * Presentation-level acceptance of the V6-4 stage bar: the current-stage
 * readout, the stage list with its census and archived (read-only) badge,
 * switching, starting a new stage, and the explicit card migration. Props are
 * fed directly — no render machinery and no Remote transport — per the
 * component-test convention; one wiring test mounts TaskboardView with the
 * stage list on its board state so the bar is proven to sit at the tab top.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type {
  ColumnId, CreateStageRequest, MigrateTicketsRequest, MigrateTicketsResult, StageView, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { BoardScope, BoardView } from '../src/client/contract.ts'
import { StageBar, type StageBarProps } from '../src/client/StageBar.tsx'
import { TaskboardView, type TaskboardViewProps } from '../src/client/TaskboardView.tsx'
import type { TaskboardT } from '../src/client/TicketCard.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as unknown as TaskboardT

afterEach(cleanup)

/** One stage row fixture; the card census defaults to an empty stage. */
function stage(boardId: string, stageName: string, stageIndex: number, overrides: Partial<StageView> = {}): StageView {
  return {
    boardId,
    name: stageName,
    stageName,
    stageIndex,
    active: false,
    archivedAt: null,
    scope: 'project',
    workspaceId: '',
    counts: { backlog: 0, not_started: 0, in_progress: 0, in_testing: 0, done: 0 },
    total: 0,
    ...overrides,
  }
}

/** A census with the given total and Done count, everything else in Backlog. */
function census(total: number, done: number): Pick<StageView, 'counts' | 'total'> {
  return {
    counts: { backlog: total - done, not_started: 0, in_progress: 0, in_testing: 0, done },
    total,
  }
}

/** One minimal card fixture. */
function ticket(id: string, title: string, column: ColumnId = 'backlog'): TicketView {
  return {
    id,
    title,
    description: '',
    column,
    priority: 'normal',
    boardId: 'board-2',
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
  }
}

interface StubProps {
  stages?: StageView[]
  currentBoardId?: string
  tickets?: TicketView[]
  currentArchived?: boolean
  switchStage?: (boardId: string) => Promise<unknown>
  createStage?: (request: CreateStageRequest) => Promise<unknown>
  migrateTickets?: (request: MigrateTicketsRequest) => Promise<MigrateTicketsResult>
}

/** Assemble the stage bar props, defaulting every verb to a no-op. */
function propsOf({
  stages = [], currentBoardId = 'board-2', tickets = [], currentArchived = false,
  switchStage, createStage, migrateTickets,
}: StubProps): StageBarProps {
  return {
    stages,
    currentBoardId,
    tickets,
    currentArchived,
    switchStage: switchStage ?? (async () => {}),
    createStage: createStage ?? (async () => {}),
    migrateTickets: migrateTickets ?? (async (request: MigrateTicketsRequest) => ({
      targetBoardId: request.targetBoardId, moved: request.ticketIds, fromBoardIds: [currentBoardId],
    })),
    t,
  }
}

/** The two-stage fixture: stage 1 ended with history, stage 2 current. */
function twoStages(): StageView[] {
  return [
    stage('board-1', '阶段一', 1, { archivedAt: 5, ...census(3, 1) }),
    stage('board-2', '迭代二', 2, { active: true, ...census(5, 2) }),
  ]
}

describe('StageBar', () => {
  it('renders the current stage with its name, index and current marker', () => {
    render(createElement(StageBar, propsOf({ stages: twoStages(), currentBoardId: 'board-2' })))
    const current = screen.getByTestId('taskboard-stage-current')
    expect(current.textContent).toContain('#2')
    expect(current.textContent).toContain('迭代二')
    expect(screen.getByTestId('taskboard-stage-current-marker').textContent).toBe('当前')
    expect(screen.getByTestId('taskboard-stage-bar').getAttribute('data-archived')).toBeNull()
  })

  it('lists every stage with its census, current marker and archived badge', () => {
    render(createElement(StageBar, propsOf({ stages: twoStages(), currentBoardId: 'board-2' })))
    fireEvent.click(screen.getByTestId('stage-list-toggle'))

    expect(screen.getByTestId('stage-census-board-1').textContent).toBe('共 3 张 · 已完成 1')
    expect(screen.getByTestId('stage-census-board-2').textContent).toBe('共 5 张 · 已完成 2')
    // The ended stage is history: visibly read-only, still selectable.
    expect(screen.getByTestId('stage-row-board-1').getAttribute('data-archived')).toBe('true')
    expect(screen.getByTestId('stage-archived-board-1').textContent).toBe('已归档')
    expect(screen.getByTestId('stage-row-board-1').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('stage-row-board-2').getAttribute('data-current')).toBe('true')
  })

  it('switches to the chosen stage, archived ones included for review', () => {
    const switchStage = vi.fn(async (_boardId: string) => {})
    render(createElement(StageBar, propsOf({
      stages: twoStages(), currentBoardId: 'board-2', switchStage,
    })))
    fireEvent.click(screen.getByTestId('stage-list-toggle'))

    // The current stage offers no switch; the ended one does (回看 re-opens it).
    expect(screen.getByTestId('stage-switch-board-2')).toHaveProperty('disabled', true)
    const archivedSwitch = screen.getByTestId('stage-switch-board-1')
    expect(archivedSwitch).toHaveProperty('disabled', false)
    fireEvent.click(archivedSwitch)

    expect(switchStage).toHaveBeenCalledWith('board-1')
  })

  it('offers a new stage and calls createStage with the typed name', async () => {
    const createStage = vi.fn(async (_request: CreateStageRequest) => {})
    render(createElement(StageBar, propsOf({ stages: twoStages(), createStage })))
    fireEvent.click(screen.getByTestId('stage-create-toggle'))
    fireEvent.change(screen.getByTestId('stage-name-input'), { target: { value: '  第三阶段  ' } })
    fireEvent.click(screen.getByTestId('stage-create-submit'))

    await waitFor(() => { expect(createStage).toHaveBeenCalledWith({ name: '第三阶段' }) })
  })

  it('starts an unnamed stage with an empty request', async () => {
    const createStage = vi.fn(async (_request: CreateStageRequest) => {})
    render(createElement(StageBar, propsOf({ stages: twoStages(), createStage })))
    fireEvent.click(screen.getByTestId('stage-create-toggle'))
    fireEvent.click(screen.getByTestId('stage-create-submit'))

    await waitFor(() => { expect(createStage).toHaveBeenCalledWith({}) })
  })

  it('migrates exactly the ticked cards, Done included, and reports the receipt', async () => {
    const migrateTickets = vi.fn(async (request: MigrateTicketsRequest): Promise<MigrateTicketsResult> => ({
      targetBoardId: request.targetBoardId, moved: request.ticketIds, fromBoardIds: ['board-2'],
    }))
    const tickets = [ticket('ticket-1', '待办卡片'), ticket('ticket-2', '完成卡片', 'done')]
    render(createElement(StageBar, propsOf({
      stages: twoStages(), currentBoardId: 'board-2', tickets, migrateTickets,
    })))
    fireEvent.click(screen.getByTestId('stage-migrate-toggle'))

    // The Done card is part of the batch, exactly like any other column.
    fireEvent.click(screen.getByTestId('stage-migrate-card-ticket-1').querySelector('input')!)
    fireEvent.click(screen.getByTestId('stage-migrate-card-ticket-2').querySelector('input')!)
    fireEvent.change(screen.getByTestId('stage-migrate-target'), { target: { value: 'board-1' } })
    fireEvent.click(screen.getByTestId('stage-migrate-submit'))

    await waitFor(() => {
      expect(migrateTickets).toHaveBeenCalledWith({ ticketIds: ['ticket-1', 'ticket-2'], targetBoardId: 'board-1' })
    })
    const receipt = screen.getByTestId('taskboard-stage-receipt')
    expect(receipt.textContent).toContain('已迁移 2 张卡片到 第 1 阶段 阶段一')
    expect(receipt.textContent).toContain('待办卡片')
    expect(receipt.textContent).toContain('完成卡片')
  })

  it('moves nothing until a batch and a target are both chosen', () => {
    const migrateTickets = vi.fn(async (request: MigrateTicketsRequest): Promise<MigrateTicketsResult> => ({
      targetBoardId: request.targetBoardId, moved: request.ticketIds, fromBoardIds: ['board-2'],
    }))
    render(createElement(StageBar, propsOf({
      stages: twoStages(), currentBoardId: 'board-2', tickets: [ticket('ticket-1', '待办卡片')], migrateTickets,
    })))
    fireEvent.click(screen.getByTestId('stage-migrate-toggle'))

    const submit = screen.getByTestId('stage-migrate-submit')
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('stage-migrate-card-ticket-1').querySelector('input')!)
    // A batch without a target is still not a migration.
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByTestId('stage-migrate-target'), { target: { value: 'board-1' } })
    expect(submit).toHaveProperty('disabled', false)
    expect(migrateTickets).not.toHaveBeenCalled()
  })

  it('refuses an ended stage as a migration target', () => {
    render(createElement(StageBar, propsOf({
      stages: twoStages(), currentBoardId: 'board-2', tickets: [ticket('ticket-1', '待办卡片')],
    })))
    fireEvent.click(screen.getByTestId('stage-migrate-toggle'))
    const option = screen.getByTestId('stage-migrate-target').querySelector('option[value="board-1"]')
    expect(option).toHaveProperty('disabled', true)
    expect(option?.textContent).toContain('（只读，不能作为目标）')
  })

  it('marks the current stage read-only when it has ended', () => {
    const ended = [stage('board-1', '阶段一', 1, { active: true, archivedAt: 7 })]
    render(createElement(StageBar, propsOf({
      stages: ended, currentBoardId: 'board-1', currentArchived: true,
    })))
    expect(screen.getByTestId('taskboard-stage-current-archived').textContent).toBe('历史只读')
    expect(screen.getByTestId('taskboard-stage-readonly').textContent).toContain('只读历史')
  })

  it('surfaces the host refusal reason verbatim', async () => {
    const switchStage = vi.fn(async (_boardId: string) => {
      throw new Error('stage "阶段一" (board-1) is archived — switching is refused on an ended stage')
    })
    render(createElement(StageBar, propsOf({
      stages: twoStages(), currentBoardId: 'board-2', switchStage,
    })))
    fireEvent.click(screen.getByTestId('stage-list-toggle'))
    fireEvent.click(screen.getByTestId('stage-switch-board-1'))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent)
        .toBe('stage "阶段一" (board-1) is archived — switching is refused on an ended stage')
    })
  })
})

/** Minimal board row for the wiring test: the stage row plus the board fields. */
function boardRow(item: StageView): BoardView {
  return {
    ...item,
    scope: item.scope as BoardScope,
    ownerSessionId: null,
    masterAgentId: null,
    masterClaimedAt: null,
    masterExpiresAt: null,
    handoverNotes: '',
  }
}

/** Assemble the whole TaskboardView props from one board state. */
function viewProps(stages: StageView[], board: TicketView[], boardId: string): TaskboardViewProps {
  const state = {
    boardId,
    boards: stages.map(boardRow),
    stages,
    snapshot: { boardId, name: boardId, tickets: board },
    workspaceId: '',
    scope: 'project' as const,
    ownerSessionId: null,
    masterAgentId: null,
    masterClaimedAt: null,
    masterExpiresAt: null,
  }
  const store = { selectedId: null as string | null }
  return {
    useBoard: (selector: (value: typeof state) => unknown) => selector(state),
    useStore: (selector: (value: typeof store) => unknown) => selector(store),
    actions: { select: () => {} },
    create: async () => board[0]!,
    move: async () => board[0]!,
    edit: async () => board[0]!,
    remove: async () => ({ removedId: boardId }),
    requestReview: async () => board[0]!,
    refresh: () => {},
    selectBoard: async () => {},
    createBoard: async () => boardRow(stages[0]!),
    archiveBoard: async () => boardRow(stages[0]!),
    setRosterCapacity: async () => state.snapshot,
    restoreMember: async () => state.snapshot,
    switchStage: async () => {},
    createStage: async () => {},
    migrateTickets: async (request: MigrateTicketsRequest) => ({
      targetBoardId: request.targetBoardId, moved: request.ticketIds, fromBoardIds: [boardId],
    }),
    hooks: { board: { getSnapshot: () => state, subscribe: () => () => {} } },
    t,
  } as unknown as TaskboardViewProps
}

describe('TaskboardView stage wiring', () => {
  it('renders the stage bar at the top of the tab from the board state', () => {
    render(createElement(TaskboardView, viewProps(twoStages(), [], 'board-2')))
    const bar = screen.getByTestId('taskboard-stage-bar')
    expect(bar.textContent).toContain('迭代二')
    expect(screen.getByTestId('taskboard-stage-current').textContent).toContain('#2')
  })

  it('renders no stage bar when the host serves no stage list', () => {
    render(createElement(TaskboardView, viewProps([], [], 'board-2')))
    expect(screen.queryByTestId('taskboard-stage-bar')).toBeNull()
  })
})
