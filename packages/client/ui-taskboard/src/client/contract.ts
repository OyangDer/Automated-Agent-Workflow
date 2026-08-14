/**
 * The taskboard tab's business face: the injected verbs, the board state
 * source, and the derived component prop aliases. Everything is plain data
 * and callbacks over the JSON wire vocabulary.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BoardSnapshot, BoardView, CreateTicketRequest, EditTicketRequest, MoveTicketRequest,
  RemoveTicketRequest, RemoveTicketResult, RequestReviewRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'

/** The live board state one tab binds: the active board plus the whole list. */
export interface BoardState {
  /** The board currently rendered (and targeted by every ticket mutation). */
  boardId: string
  /** Every board row (active and archived), for the header selector. */
  boards: BoardView[]
  /** The active board's ticket snapshot; null until the first load lands. */
  snapshot: BoardSnapshot | null
}

/** The browser actions one TaskboardView surface may take. */
export interface TaskboardInjected {
  create(request: CreateTicketRequest): Promise<TicketView>
  move(request: MoveTicketRequest): Promise<TicketView>
  edit(request: EditTicketRequest): Promise<TicketView>
  remove(request: RemoveTicketRequest): Promise<RemoveTicketResult>
  requestReview(request: RequestReviewRequest): Promise<TicketView>
  /** Force a snapshot refresh (errors surface in the panel, not here). */
  refresh(): void
  /** Switch the rendered board; refetches the board list and the snapshot. */
  selectBoard(boardId: string): Promise<void>
  /** Create a board from a display name and select it. */
  createBoard(name: string): Promise<BoardView>
  /** Archive a board; archiving the active board switches to the default one. */
  archiveBoard(boardId: string): Promise<BoardView>
  /** Live board state source; the renderer binds it into useBoard. */
  hooks: { board: HostObservable<BoardState> }
}
