/**
 * TaskboardView: the five-column kanban tab. Columns render from the live
 * board snapshot; cards drag between columns with HTML5 drag events; the
 * detail panel and the new-ticket form overlay the board. All verbs come from
 * the injected face, all live data from the bound useBoard hook.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ColumnId, MoveTicketRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { BoardScope, BoardView, TaskboardInjected } from './contract.ts'
import {
  DRAG_AUTO_SCROLL_DEFAULTS, autoScrollDelta, insertionIndexAt, insertionSlot,
  type DragAutoScrollOptions,
} from './dragScroll.ts'
import { createTaskboardStore } from './stores.ts'
import { CompactionCeilingRow } from './CompactionCeilingRow.tsx'
import { TicketCard } from './TicketCard.tsx'
import { TicketDetail } from './TicketDetail.tsx'
import { NewTicketForm } from './NewTicketForm.tsx'
import css from './Board.module.css'

/** The five workflow columns in canonical left-to-right order. */
const COLUMNS: readonly ColumnId[] = ['backlog', 'not_started', 'in_progress', 'in_testing', 'done']

/** How close to the master-lease expiry the banner starts warning. */
const SEAT_LEASE_WARNING_MS = 60_000

/** Short display handle for one session id (strips the session- prefix). */
function shortSessionId(id: string): string {
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
  return bare.length > 8 ? bare.slice(0, 8) : bare
}

export type TaskboardViewProps = ConvViewProps
  & InjectFace<TaskboardInjected>
  & PropsLocale<'taskboard'>
  & PropsStore<ReturnType<typeof createTaskboardStore>>
  & {
    /** Edge auto-scroll tuning while a card drag is active (optional). */
    dragAutoScroll?: Partial<DragAutoScrollOptions>
  }

/** One drop target: a column plus the card to insert before (null = append). */
interface DropTarget {
  column: ColumnId
  beforeTicketId: string | null
}

export function TaskboardView({
  useBoard, useStore, actions, create, move, edit, remove, requestReview,
  selectBoard, createBoard, archiveBoard, t, dragAutoScroll, compaction,
}: TaskboardViewProps) {
  const boardState = useBoard(state => state)
  const board = boardState.snapshot
  const selectedId = useStore(state => state.selectedId)
  const [formOpen, setFormOpen] = useState(false)
  const [newBoardOpen, setNewBoardOpen] = useState(false)
  const [boardName, setBoardName] = useState('')
  const [boardScope, setBoardScope] = useState<BoardScope>('session')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  /** The scrollable board strip (horizontal auto-scroll while dragging). */
  const boardRef = useRef<HTMLDivElement | null>(null)
  /** Last drag pointer position plus the column under it (vertical scroll). */
  const dragPointRef = useRef<{ clientX: number; clientY: number; columnEl: HTMLElement | null } | null>(null)
  /** Pending animation-frame id of the drag auto-scroll loop. */
  const autoScrollRafRef = useRef<number | null>(null)

  /** Edge auto-scroll tuning; caller-supplied values win over the defaults. */
  const autoScrollConfig: DragAutoScrollOptions = {
    threshold: dragAutoScroll?.threshold ?? DRAG_AUTO_SCROLL_DEFAULTS.threshold,
    speed: dragAutoScroll?.speed ?? DRAG_AUTO_SCROLL_DEFAULTS.speed,
  }

  /** Stop the drag auto-scroll loop and forget the pointer. */
  const stopAutoScroll = (): void => {
    if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current)
    autoScrollRafRef.current = null
    dragPointRef.current = null
  }

  // A drag in flight when the tab unmounts must not keep the rAF loop alive.
  useEffect(() => () => {
    if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current)
    autoScrollRafRef.current = null
    dragPointRef.current = null
  }, [])

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
   * The board's roster (V6-1) and its current pair count. Pairs are the unit
   * of the fixed headcount, so the count is the number of worker members (or
   * of reviewer members when only those exist yet).
   */
  const roster = board?.members ?? []
  const pairCount = roster.filter(member => member.role === 'worker').length
    || roster.filter(member => member.role === 'reviewer').length

  /**
   * Master-seat banner state for the active board: vacant, held (with a
   * lease about to expire warning) or expired. The host reports
   * masterExpiresAt (claim time plus the configured lease), so the expiring
   * and expired states are exact. A lapsed lease means the seat is
   * preemptable again, so the banner reads as expired rather than being
   * permanently "about to expire" and re-offers the takeover affordance.
   */
  const masterLabel = boardState.masterAgentId === null
    ? null
    : shortSessionId(boardState.masterAgentId)
  const masterHeld = boardState.masterAgentId !== null && boardState.masterExpiresAt !== null
  const masterExpired = masterHeld && boardState.masterExpiresAt !== null && boardState.masterExpiresAt <= Date.now()
  const masterExpiring = masterHeld
    && !masterExpired
    && boardState.masterExpiresAt !== null
    && boardState.masterExpiresAt - Date.now() < SEAT_LEASE_WARNING_MS

  /** Copy the standard takeover script for a vacant seat into the clipboard. */
  const copyTakeover = async (): Promise<void> => {
    const script = t('seat.takeover')
      .replaceAll('{boardId}', boardState.boardId)
      .replaceAll('{boardName}', board?.name ?? boardState.boardId)
    try {
      // lib.dom types clipboard non-optional, but insecure contexts omit it —
      // the write then throws straight into the failure state below.
      await navigator.clipboard.writeText(script)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  /**
   * Active boards for the selector, grouped by scope; archived ones collapse
   * into a group. Only the current project's boards render (the host already
   * filters, so this is defense-in-depth): a board owned by another workspace
   * is never selectable here, while unowned boards stay shared. A session-
   * private board (scope 'session') is shown only through its own session's
   * list; anything without a scope marker reads as project-shared.
   */
  const workspaceId = boardState.workspaceId
  const inWorkspace = (item: BoardView): boolean => item.workspaceId === workspaceId || item.workspaceId === ''
  const activeBoards = boardState.boards.filter(item => item.archivedAt === null && inWorkspace(item))
  const archivedBoards = boardState.boards.filter(item => item.archivedAt !== null && inWorkspace(item))
  const sessionBoards = activeBoards.filter(item => item.scope === 'session')
  const projectBoards = activeBoards.filter(item => item.scope !== 'session')

  /** One option label: the board name plus its scope badge. */
  const boardLabel = (item: BoardView): string => {
    const name = item.name || item.boardId
    const scopeKey = item.scope === 'session' ? 'session' : 'project'
    return name + '（' + t(('board.scope.' + scopeKey) as never) + '）'
  }

  /** Create one board from the inline name and scope fields and open it. */
  const handleCreateBoard = async (): Promise<void> => {
    const name = boardName.trim()
    if (name === '') return
    try {
      await createBoard(name, boardScope)
      setNewBoardOpen(false)
      setBoardName('')
      setBoardScope('session')
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

  /** One auto-scroll tick: scroll the column vertically and the board horizontally. */
  const autoScrollTick = (): void => {
    autoScrollRafRef.current = null
    const point = dragPointRef.current
    if (point === null) return
    const { clientX, clientY, columnEl } = point
    if (columnEl !== null) {
      const rect = columnEl.getBoundingClientRect()
      const deltaY = autoScrollDelta(clientY, rect.top, rect.height, autoScrollConfig.threshold, autoScrollConfig.speed)
      if (deltaY !== 0) {
        columnEl.scrollTop = Math.max(0, columnEl.scrollTop + deltaY)
      }
    }
    const board = boardRef.current
    if (board !== null) {
      const rect = board.getBoundingClientRect()
      const deltaX = autoScrollDelta(clientX, rect.left, rect.width, autoScrollConfig.threshold, autoScrollConfig.speed)
      if (deltaX !== 0) {
        board.scrollLeft = Math.max(0, board.scrollLeft + deltaX)
      }
    }
    autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
  }

  /** Keep the auto-scroll loop alive while a drag is in flight. */
  const ensureAutoScroll = (clientX: number, clientY: number, columnEl: HTMLElement | null): void => {
    dragPointRef.current = { clientX, clientY, columnEl }
    if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
    }
  }

  /** Commit one drag-drop move and surface failures in the banner. */
  const handleDrop = async (column: ColumnId): Promise<void> => {
    const id = draggingId
    const before = dropTarget !== null && dropTarget.column === column ? dropTarget.beforeTicketId : null
    setDraggingId(null)
    setDropTarget(null)
    stopAutoScroll()
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
    dragPointRef.current = null
    if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = requestAnimationFrame(autoScrollTick)
    }
  }

  /** Track the pointer for auto-scroll while dragging over one column. */
  const handleColumnDragOver = (event: DragEvent<HTMLElement>): void => {
    if (draggingId === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    ensureAutoScroll(event.clientX, event.clientY, event.currentTarget)
  }

  /** Track the pointer for horizontal auto-scroll over the board strip. */
  const handleBoardDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (draggingId === null) return
    // A dragover over a column bubbles here with a child target; only claim
    // the pointer when the board itself is under it, so the column's vertical
    // scroll anchor is not clobbered by the bubbling handler.
    if (event.target !== event.currentTarget) return
    ensureAutoScroll(event.clientX, event.clientY, null)
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
            {sessionBoards.length > 0 && (
              <optgroup label={t('board.group.session')}>
                {sessionBoards.map(boardRow => (
                  <option key={boardRow.boardId} value={boardRow.boardId}>
                    {boardLabel(boardRow)}
                  </option>
                ))}
              </optgroup>
            )}
            {projectBoards.length > 0 && (
              <optgroup label={t('board.group.project')}>
                {projectBoards.map(boardRow => (
                  <option key={boardRow.boardId} value={boardRow.boardId}>
                    {boardLabel(boardRow)}
                  </option>
                ))}
              </optgroup>
            )}
            {archivedBoards.length > 0 && (
              <optgroup label={t('board.archived')}>
                {archivedBoards.map(boardRow => (
                  <option key={boardRow.boardId} value={boardRow.boardId} disabled>
                    {boardLabel(boardRow)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <span className={css.scopeBadge} data-scope={boardState.scope}>
            {t(('board.scope.' + boardState.scope) as never)}
          </span>
          {!confirmArchive ? (
            <button type="button" className={css.archiveButton} onClick={() => { setConfirmArchive(true) }}>
              {t('board.archive')}
            </button>
          ) : (
            <span className={css.archiveConfirm}>
              <span className={css.archiveConfirmText}>{t('board.archiveConfirm')}</span>
              <button type="button" className={css.confirmButton} onClick={() => { setConfirmArchive(false); void handleArchive() }}>
                {t('board.confirm')}
              </button>
              <button type="button" className={css.cancelButton} onClick={() => { setConfirmArchive(false) }}>
                {t('action.cancel')}
              </button>
            </span>
          )}
        </div>
        <div className={css.seatBanner} data-seat={boardState.masterAgentId === null ? 'vacant' : masterExpired ? 'expired' : 'held'}>
          {boardState.masterAgentId === null || masterExpired ? (
            <>
              <span className={css.seatText} data-expired={masterExpired || undefined}>
                {boardState.masterAgentId === null ? t('seat.vacant') : t('seat.expired')}
              </span>
              <button type="button" className={css.copyButton} onClick={() => { void copyTakeover() }}>
                {t('seat.copyTakeover')}
              </button>
              {copyState !== 'idle' && (
                <span className={css.seatCopyState} data-copy={copyState}>
                  {copyState === 'copied' ? t('seat.copied') : t('seat.copyFailed')}
                </span>
              )}
            </>
          ) : (
            <span className={css.seatText} data-expiring={masterExpiring}>
              {t('seat.holder').replace('{holder}', masterLabel ?? '')}
              {masterExpiring ? ' · ' + t('seat.expiring') : ''}
            </span>
          )}
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.secondaryButton} onClick={() => { setNewBoardOpen(open => !open) }}>
            {t('board.new')}
          </button>
          <button type="button" className={css.newButton} onClick={() => { setFormOpen(true) }}>
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
            onChange={(event) => { setBoardName(event.target.value) }}
            placeholder={t('board.newName')}
            aria-label={t('board.newName')}
          />
          <select
            className={css.boardScopeSelect}
            value={boardScope}
            onChange={(event) => { setBoardScope(event.target.value as BoardScope) }}
            aria-label={t('board.scope')}
          >
            <option value="session">{t('board.scope.session')}</option>
            <option value="project">{t('board.scope.project')}</option>
          </select>
          <button type="submit" className={css.createButton} disabled={boardName.trim() === ''}>
            {t('board.create')}
          </button>
          <button type="button" className={css.cancelButton} onClick={() => { setNewBoardOpen(false); setBoardName(''); setBoardScope('session') }}>
            {t('action.cancel')}
          </button>
        </form>
      )}
      {error !== null && (
        <div className={css.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" className={css.errorClose} onClick={() => { setError(null) }} aria-label={t('action.close')}>×</button>
        </div>
      )}
      {/*
        V6-2: the automatic-compaction ceiling. It renders the Host's
        `compaction-basic` settings section, so the value shown is the one
        every engine compacts under — no restart, no board reload.
      */}
      {compaction !== undefined && <CompactionCeilingRow ceiling={compaction} t={t} />}
      {/*
        V6-1 visualization base: the board's fixed roster — member id, role,
        fixed partner, derived load and the SHORT work summary the master
        matches on. It is a read-only strip: dispatching stays with the master
        (taskboard_assign) and the queue is drained by the board itself.
      */}
      {roster.length > 0 && (
        <div className={css.roster} data-testid="taskboard-roster">
          <span className={css.rosterTitle}>
            {t('roster.title')}
            <span className={css.rosterCapacity}>{t('roster.capacity').replace('{count}', String(pairCount))}</span>
          </span>
          {roster.map(member => (
            <span key={member.id} className={css.rosterChip} data-status={member.status}>
              <b className={css.rosterId}>{member.id}</b>
              <span className={css.rosterPartner}>{'↔ ' + member.partnerId}</span>
              <span className={css.rosterState}>
                {member.status === 'busy'
                  ? t('roster.busy').replace('{ticket}', member.currentTicketId ?? '')
                  : t('roster.idle')}
              </span>
              <span className={css.rosterSummary} title={member.summary}>{member.summary}</span>
            </span>
          ))}
        </div>
      )}
      <div className={css.board} ref={boardRef} onDragOver={handleBoardDragOver}>
        {COLUMNS.map((column) => {
          const tickets = byColumn.get(column) ?? []
          const gloss = t(('column.' + column + '.gloss') as never)
          const isDropTarget = dropTarget !== null && dropTarget.column === column
          const columnClass = css.column ?? ''
          /** Slot the drop lands in: the index to insert before (length = append). */
          const dropSlot = isDropTarget
            ? insertionSlot(tickets.map(ticket => ticket.id), dropTarget.beforeTicketId)
            : -1
          return (
            <section
              key={column}
              className={isDropTarget ? `${columnClass} ${css.columnDropTarget ?? ''}` : columnClass}
              data-column={column}
              onDragOver={(event) => {
                handleColumnDragOver(event)
                if (draggingId === null) return
                // The pointer's vertical position picks the insertion slot:
                // above a card's midpoint inserts before it, below appends.
                const spans = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-ticket-id]'))
                  .map((element) => {
                    const rect = element.getBoundingClientRect()
                    return { top: rect.top, bottom: rect.bottom }
                  })
                const index = insertionIndexAt(event.clientY, spans)
                const beforeTicketId = index < tickets.length ? tickets[index]?.id ?? null : null
                setDropTarget({ column, beforeTicketId })
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
                {tickets.map((ticket, index) => (
                  <Fragment key={ticket.id}>
                    {dropSlot === index && <div className={css.dropIndicator} data-testid="drop-indicator" />}
                    <TicketCard
                      ticket={ticket}
                      selected={ticket.id === selectedId}
                      dragging={ticket.id === draggingId}
                      t={t}
                      onSelect={() => { actions.select(ticket.id) }}
                      onDragStart={() => { handleDragStart(ticket.id) }}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setDropTarget(null)
                        stopAutoScroll()
                      }}
                    />
                  </Fragment>
                ))}
                {dropSlot === tickets.length && (
                  <div className={css.dropIndicator} data-testid="drop-indicator" />
                )}
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
          onCancel={() => { setFormOpen(false) }}
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
