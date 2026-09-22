/**
 * The taskboard tab's business face: the injected verbs, the board state
 * source, and the derived component prop aliases. Everything is plain data
 * and callbacks over the JSON wire vocabulary.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BoardSnapshot, BoardView as HostBoardView, CreateTicketRequest, EditTicketRequest, MoveTicketRequest,
  RemoveTicketRequest, RemoveTicketResult, RequestReviewRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { CompactionCeilingFace } from './compaction-threshold.ts'

/**
 * The two board scopes the header selector groups by. A session-scoped board
 * is private to the session that created it; a project-scoped board is
 * shared by every session of its owning workspace.
 */
export type BoardScope = 'session' | 'project'

/**
 * One board row as the client consumes it. The V3-1 incremental host card
 * adds the dual-scope fields to the generated contract (same names and
 * types); the client declares them here so the selector grouping and the
 * new-board form are typed against the wire vocabulary before that host
 * commit lands.
 */
export interface BoardView extends HostBoardView {
  /** Session-private (owned by one session) or project-shared. */
  scope: BoardScope
  /** The owning session id of a session-private board; null when shared. */
  ownerSessionId: string | null
}

/** The live board state one tab binds: the active board plus the whole list. */
export interface BoardState {
  /** The board currently rendered (and targeted by every ticket mutation). */
  boardId: string
  /** Every board row (active and archived), for the header selector. */
  boards: BoardView[]
  /** The active board's ticket snapshot; null until the first load lands. */
  snapshot: BoardSnapshot | null
  /**
   * The owning workspace of the session this board list belongs to (the
   * host scopes every board verb to it); '' when the session is unowned or
   * the workspace baseline has not resolved yet. The selector shows boards
   * of this workspace plus the unowned (shared) ones.
   */
  workspaceId: string
  /** The active board's scope, surfaced for the header badge. */
  scope: BoardScope
  /** The active board's owning session id; null for project-shared boards. */
  ownerSessionId: string | null
  /** The active board's master seat holder; null while vacant. */
  masterAgentId: string | null
  /** When the active board's master seat was claimed; null while vacant. */
  masterClaimedAt: number | null
  /** When the active board's master seat lease expires; null while vacant. */
  masterExpiresAt: number | null
}

/** One board-creation request the client sends; scope picks the visibility. */
export interface CreateBoardRequest {
  name: string
  /** Session-private (default) or project-shared. */
  scope: BoardScope
  /**
   * TODO(V3-5): board-level worker/reviewer model+effort overrides
   * (workerModel/workerEffort/reviewerModel/reviewerEffort). The host board
   * record supports modelConfig and the master tool taskboard_board_config
   * writes it; the new-board form and a board settings path should offer
   * model/effort dropdowns (each with a "default" option). Deferred to keep
   * this UI change small — see the package README "Model and effort
   * selectors (V3-5, TODO)" section.
   */
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
  /** Create a board from a display name (session-private by default) and select it. */
  createBoard(name: string, scope?: BoardScope): Promise<BoardView>
  /** Archive a board; archiving the active board switches to the default one. */
  archiveBoard(boardId: string): Promise<BoardView>
  /** Live board state source; the renderer binds it into useBoard. */
  hooks: { board: HostObservable<BoardState> }
  /**
   * The automatic-compaction ceiling control (V6-2). Absent when the
   * deployment serves no `compaction-basic` settings namespace, so the tab
   * renders exactly the board it always did.
   */
  compaction?: CompactionCeilingFace
}
