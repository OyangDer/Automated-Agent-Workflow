/**
 * TaskboardView: the five-column kanban tab. Columns render from the live
 * board snapshot; cards drag between columns with HTML5 drag events; the
 * detail panel and the new-ticket form overlay the board. All verbs come from
 * the injected face, all live data from the bound useBoard hook.
 */
import { useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BoardView, ColumnId, MoveTicketRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { TaskboardInjected } from './contract.ts'
import { createTaskboardStore } from './stores.ts'
import { TicketCard } from './TicketCard.tsx'
import { TicketDetail } from './TicketDetail.tsx'
import { NewTicketForm } from './NewTicketForm.tsx'
import css from './Board.module.css'

/** The five workflow columns in canonical left-to-right order. */
const COLUMNS: readonly ColumnId[] = ['backlog', 'not_started', 'in_progress', 'in_testing', 'done']

export type TaskboardViewProps = ConvViewProps
  & InjectFace<TaskboardInjected>
  & PropsLocale<'taskboard'>
  & PropsStore<ReturnType<typeof createTaskboardStore>>

/** One drop target: a column plus the card to insert before (null = append). */
interface DropTarget {
  column: ColumnId
  beforeTicketId: string | null
}

export function TaskboardView({
  useBoard, useStore, actions, create, move, edit, remove, requestReview,
  selectBoard, createBoard, archiveBoard, t,
}: TaskboardViewProps) {
  const boardState = useBoard(state => state)
  const board = boardState.snapshot
  const selectedId = useStore(state => state.selectedId)
  const [formOpen, setFormOpen] = useState(false)
  const [newBoardOpen, setNewBoardOpen] = useState(false)
  const [boardName, setBoardName] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Column id → ordered tickets, derived purely from the snapshot. */
  const byColumn = useMemo(() => {
    const map = new Map<ColumnId, TicketView[]>()
    for (const column of COLUMNS) map.set(column, [])
    for (const ticket of board?.tickets ?? []) {
      const rows = map.get(ticket.column)
      if (rows !== undefined) rows.push(ticket)
    }
    return map
  }, [board])

  const selected = board === null ? null : board.tickets.find(ticket => ticket.id === selectedId) ?? null
  const ticketCount = board?.tickets.length ?? 0

  /**
   * Active boards for the selector; archived ones collapse into a group.
   * Only the current project's boards render (the host already filters, so
   * this is defense-in-depth): a board owned by another workspace is never
   * selectable here, while unowned boards stay shared across workspaces.
   */
  const workspaceId = boardState.workspaceId
  const inWorkspace = (item: BoardView): boolean => item.workspaceId === workspaceId || item.workspaceId === ''
  const activeBoards = boardState.boards.filter(item => item.archivedAt === null && inWorkspace(item))
  const archivedBoards = boardState.boards.filter(item => item.archivedAt !== null && inWorkspace(item))

  /** Create one board from the inline name field and open it. */
  const handleCreateBoard = async (): Promise<void> => {
    const name = boardName.trim()
    if (name === '') return
    try {
      await createBoard(name)
      setNewBoardOpen(false)
      setBoardName('')
      setError(null)
    } catch {
      setError(t('error.generic'))
    }
  }

  /** Archive the active board after the inline confirmation. */
  const handleArchive = async (): Promise<void> => {
    try {
      await archiveBoard(boardState.boardId)
      setError(null)
    } catch {
      setError(t('error.generic'))
    }
  }

  /** Commit one drag-drop move and surface failures in the banner. */
  const handleDrop = async (column: ColumnId): Promise<void> => {
    const id = draggingId
    const before = dropTarget !== null && dropTarget.column === column ? dropTarget.beforeTicketId : null
    setDraggingId(null)
    setDropTarget(null)
    if (id === null) return
    const request: MoveTicketRequest = { ticketId: id, column, beforeTicketId: before, afterTicketId: null }
    try {
      await move(request)
      setError(null)
    } catch {
      setError(t('error.generic'))
    }
  }

  /** Arm one drag session from a card. */
  const handleDragStart = (id: string): void => {
    setDraggingId(id)
    setDropTarget(null)
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <h1 className={css.title}>{t('view.taskboard')}</h1>
        <span className={css.count}>{String(ticketCount)}</span>
        <div className={css.boardSelector}>
          <select
            className={css.boardSelect}
            aria-label={t('board.select')}
            value={boardState.boardId}
            onChange={(event) => { void selectBoard(event.target.value) }}
          >
            {activeBoards.map(boardRow => (
              <option key={boardRow.boardId} value={boardRow.boardId}>
                {boardRow.name || boardRow.boardId}
              </option>
            ))}
            {archivedBoards.length > 0 && (
              <optgroup label={t('board.archived')}>
                {archivedBoards.map(boardRow => (
                  <option key={boardRow.boardId} value={boardRow.boardId} disabled>
                    {boardRow.name || boardRow.boardId}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {!confirmArchive ? (
            <button type="button" className={css.archiveButton} onClick={() => setConfirmArchive(true)}>
              {t('board.archive')}
            </button>
          ) : (
            <span className={css.archiveConfirm}>
              <span className={css.archiveConfirmText}>{t('board.archiveConfirm')}</span>
              <button type="button" className={css.confirmButton} onClick={() => { setConfirmArchive(false); void handleArchive() }}>
                {t('board.confirm')}
              </button>
              <button type="button" className={css.cancelButton} onClick={() => setConfirmArchive(false)}>
                {t('action.cancel')}
              </button>
            </span>
          )}
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.secondaryButton} onClick={() => setNewBoardOpen(open => !open)}>
            {t('board.new')}
          </button>
          <button type="button" className={css.newButton} onClick={() => setFormOpen(true)}>
            {t('action.new')}
          </button>
        </div>
      </header>
      {newBoardOpen && (
        <form
          className={css.newBoardForm}
          onSubmit={(event) => { event.preventDefault(); void handleCreateBoard() }}
        >
          <input
            className={css.boardNameInput}
            value={boardName}
            onChange={event => setBoardName(event.target.value)}
            placeholder={t('board.newName')}
            aria-label={t('board.newName')}
          />
          <button type="submit" className={css.createButton} disabled={boardName.trim() === ''}>
            {t('board.create')}
          </button>
          <button type="button" className={css.cancelButton} onClick={() => { setNewBoardOpen(false); setBoardName('') }}>
            {t('action.cancel')}
          </button>
        </form>
      )}
      {error !== null && (
        <div className={css.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" className={css.errorClose} onClick={() => setError(null)} aria-label={t('action.close')}>×</button>
        </div>
      )}
      <div className={css.board}>
        {COLUMNS.map((column) => {
          const tickets = byColumn.get(column) ?? []
          const gloss = t(('column.' + column + '.gloss') as never)
          const isDropTarget = dropTarget !== null && dropTarget.column === column
          return (
            <section
              key={column}
              className={css.column + (isDropTarget ? ' ' + css.columnDropTarget : '')}
              data-column={column}
              onDragOver={(event) => {
                if (draggingId === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTarget({ column, beforeTicketId: null })
              }}
              onDrop={(event) => {
                event.preventDefault()
                void handleDrop(column)
              }}
            >
              <div className={css.columnHeader}>
                <span className={css.columnName}>{t(('column.' + column) as never)}</span>
                {gloss !== '' && <span className={css.columnGloss}>{gloss}</span>}
                <span className={css.columnCount}>{String(tickets.length)}</span>
              </div>
              <div className={css.cards}>
                {tickets.map(ticket => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    selected={ticket.id === selectedId}
                    dragging={ticket.id === draggingId}
                    t={t}
                    onSelect={() => { actions.select(ticket.id) }}
                    onDragStart={() => { handleDragStart(ticket.id) }}
                    onDragEnd={() => {
                      setDraggingId(null)
                      setDropTarget(null)
                    }}
                    onDragOverCard={() => { setDropTarget({ column, beforeTicketId: ticket.id }) }}
                  />
                ))}
                {tickets.length === 0 && ticketCount === 0 && column === 'backlog' && (
                  <p className={css.empty}>{t('board.empty')}</p>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {selected !== null && (
        <TicketDetail
          ticket={selected}
          board={board?.tickets ?? []}
          t={t}
          onClose={() => { actions.select(null) }}
          onEdit={edit}
          onRemove={remove}
          onRequestReview={requestReview}
          onMove={(target) => { void handleMove(target) }}
          onError={(message) => { setError(message) }}
        />
      )}
      {formOpen && (
        <NewTicketForm
          board={board?.tickets ?? []}
          t={t}
          onSubmit={async (request) => {
            try {
              await create(request)
              setFormOpen(false)
              setError(null)
            } catch {
              setError(t('error.generic'))
            }
          }}
          onCancel={() => setFormOpen(false)}
        />
      )}
    </div>
  )

  /** Adjacent-column moves from the detail panel reuse the same verb. */
  async function handleMove(target: ColumnId): Promise<void> {
    if (selected === null) return
    const request: MoveTicketRequest = { ticketId: selected.id, column: target, beforeTicketId: null, afterTicketId: null }
    try {
      await move(request)
      setError(null)
    } catch {
      setError(t('error.generic'))
    }
  }
}
