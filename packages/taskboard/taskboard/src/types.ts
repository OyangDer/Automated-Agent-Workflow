/**
 * Client-safe vocabulary of the taskboard domain: the five column ids, the
 * wire snapshots the browser renders, the RPC request payloads, and the one
 * forwarded host event. Pure data module — the browser imports this outlet
 * (directly or through the `./client` re-export) without dragging host
 * services into the client program, and the forwarded-event allowlist reads
 * the `taskboard/changed` declaration from here.
 * @module @deepseek-ai/dsh-taskboard
 */

/** The five workflow columns in canonical left-to-right order. */
export const TASKBOARD_COLUMNS = ['backlog', 'not_started', 'in_progress', 'in_testing', 'done'] as const

/** One kanban column id. */
export type ColumnId = typeof TASKBOARD_COLUMNS[number]

/** The three ticket priority levels. */
export const TASKBOARD_PRIORITIES = ['low', 'normal', 'high'] as const

/** One ticket priority. */
export type Priority = typeof TASKBOARD_PRIORITIES[number]

/** The ticket kind vocabulary, shown as a badge on the card. */
export const TASKBOARD_TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'merge', 'infra', 'chore', 'spike'] as const

/** One ticket kind. */
export type TicketType = typeof TASKBOARD_TYPES[number]

/** The worker lifecycle of one card (v2 dispatch protocol). */
export const TASKBOARD_WORKER_STATUSES = ['ready', 'claimed', 'running', 'blocked'] as const

/** One worker lifecycle state. */
export type TicketWorkerStatus = typeof TASKBOARD_WORKER_STATUSES[number]

/** One durable worker-failure record, written by taskboard_fail or auto-reclamation. */
export interface TicketFailure {
  /** Human-readable failure reason. */
  reason: string
  /** Unix epoch milliseconds when the failure was recorded. */
  at: number
}

/** Compact attribution of a card to one agent (developer or reviewer). */
export interface TicketAssignee {
  /** The owning agent/session id. */
  agentId: string
  /** Display label (short id or session title when available). */
  label: string
}

/** One durable review decision recorded on the ticket. */
export interface TicketReview {
  outcome: 'approved' | 'rejected'
  /** Approve: the review summary. Reject: concrete rework feedback. */
  feedback: string
  reviewer: TicketAssignee
  /** 1-based review round this decision belongs to. */
  attempt: number
  at: number
}

/** One structured reviewer report written back from a report-mode reviewer run. */
export interface TicketReviewOutcome {
  /** The reviewer's conclusion; the master acts on it through taskboard_resolve_review. */
  verdict: 'approve' | 'reject'
  /** What the reviewer inspected and concluded. */
  summary: string
  /** Concrete rework problems; empty on approval. */
  problems: string[]
  /** Unix epoch milliseconds when the report was recorded. */
  at: number
}

/** One display-only history row kept on the ticket. */
export interface TicketHistoryEntry {
  at: number
  /** Stable event kind, e.g. "create", "claim", "approve". */
  kind: string
  /** Human-readable detail in the board language. */
  detail: string
}

/** The full wire view of one ticket. */
export interface TicketView {
  id: string
  title: string
  description: string
  column: ColumnId
  priority: Priority
  /** The board this ticket belongs to; one Sprint one board. */
  boardId: string
  /** Ticket kind badge. */
  type: TicketType
  /** Worker lifecycle; blocked marks a failed/terminated worker (card stays In progress). */
  status: TicketWorkerStatus
  /** The spawned worker agent/session id; absent until taskboard_assign spawns one. */
  workerAgentId?: string | undefined
  /** The spawned worker run session id (equals workerAgentId for in-process spawns). */
  workerSessionId?: string | undefined
  /** Last worker failure; null while the card is healthy. */
  failure: TicketFailure | null
  createdAt: number
  updatedAt: number
  /** Sort key inside a column; lower sorts first. */
  position: number
  /** The claiming developer; null until an agent claims the ticket. */
  assignee: TicketAssignee | null
  /** The designated reviewer; null outside review or when no reviewer is assigned. */
  reviewer: TicketAssignee | null
  /** Completed review rounds; increments on every approve/reject decision. */
  reviewAttempts: number
  lastReview: TicketReview | null
  /** The latest structured reviewer report (report mode); null outside report-mode review. */
  reviewOutcome: TicketReviewOutcome | null
  /** Developer's completion notes, filled when the ticket enters testing. */
  devNotes: string
  /** Master-confirmed target branch for merge tickets; empty for other types. */
  targetBranch: string
  /**
   * Declared scope of files/directories this card touches ('' when not
   * declared). The master reads it when dispatching to judge whether two
   * parallel workers may run in the same shared workspace without stepping
   * on each other, and to spot soft (file-level) dependencies between cards.
   */
  filesScope: string
  /** Hard ordering constraints: every listed ticket must be in Done before claim. */
  dependsOn: string[]
  history: TicketHistoryEntry[]
}

/** One durable master-seat transition recorded on the board, for hierarchy-tree rendering. */
export interface MasterHistoryEntry {
  /** The previous master session id; null when the seat was empty. */
  fromAgentId: string | null
  /** The session id taking the seat. */
  toAgentId: string
  /** Unix epoch milliseconds when the transition was recorded. */
  at: number
  /** Handover notes carried by a transfer; empty for a claim. */
  notes: string
}

/** One board row surfaced by the Remote API and the master-seat domain operations. */
export interface BoardView {
  boardId: string
  name: string
  /** The owning workspace id; empty when the board is unowned (shared across workspaces). */
  workspaceId: string
  /**
   * Board visibility scope: 'session' boards are private to the creating
   * session (ownerSessionId); 'project' boards are shared by every session
   * of their owning workspace.
   */
  scope: 'session' | 'project'
  /** The creating session id of a session-scoped board; null for project and legacy boards. */
  ownerSessionId: string | null
  /** The session agent holding the master seat, or null when unclaimed. */
  masterAgentId: string | null
  /** When the master seat was claimed; null while unclaimed. */
  masterClaimedAt: number | null
  /**
   * When the current master's seat lease expires (claim time plus the
   * configured lease), derived by the host on every read; null while the
   * seat is vacant. The browser banner uses it to flag a lease about to
   * expire.
   */
  masterExpiresAt: number | null
  /** Handover notes written on transferMaster/taskboard_handover, for the next master. */
  handoverNotes: string
  /** Durable master-seat transitions (claim/transfer), for hierarchy-tree rendering. */
  masterHistory?: MasterHistoryEntry[]
  /** When the board was archived; null while active. */
  archivedAt: number | null
}

/** Whole-board snapshot returned by the Remote API. */
export interface BoardSnapshot {
  boardId: string
  name: string
  tickets: TicketView[]
}

/** Mutation verbs surfaced by the forwarded `taskboard/changed` event. */
export type TaskboardOperation =
  | 'create' | 'move' | 'edit' | 'remove'
  | 'claim' | 'complete' | 'approve' | 'reject' | 'review-claim'
  | 'assign' | 'report' | 'fail' | 'reassign' | 'resolve-review'

/** The durable-change notification forwarded to the browser. */
export interface TaskboardChanged {
  operation: TaskboardOperation
  ticketId: string
  /** The board the mutation targeted. */
  boardId: string
  /** Full post-mutation view; null only for a removal. */
  ticket: TicketView | null
}

/** User creates a ticket; it always lands in Backlog. */
export interface CreateTicketRequest {
  title: string
  description: string
  priority: Priority
  /** Ticket ids this ticket waits for; all must exist and be open to completion. */
  dependsOn: string[]
  /** Target board; defaults to "default" for v1 compatibility. */
  boardId?: string
  /** Master-confirmed target branch for a merge ticket. */
  targetBranch?: string
  /** Declared file scope (paths this card touches); '' when not declared. */
  filesScope?: string
}

/** User drags a ticket to another column, optionally next to an anchor. */
export interface MoveTicketRequest {
  ticketId: string
  column: ColumnId
  /** Insert immediately before this ticket's position; null to ignore. */
  beforeTicketId: string | null
  /** Insert immediately after this ticket's position; used when before is null. */
  afterTicketId: string | null
  /** Board the ticket lives on; defaults to "default" for v1 compatibility. */
  boardId?: string
}

/** User edits ticket content and ordering constraints. */
export interface EditTicketRequest {
  ticketId: string
  title: string
  description: string
  priority: Priority
  dependsOn: string[]
  /** Board the ticket lives on; defaults to "default" for v1 compatibility. */
  boardId?: string
  /** Master-confirmed target branch for a merge ticket. */
  targetBranch?: string
  /** Declared file scope (paths this card touches); omitted keeps the current scope. */
  filesScope?: string
}

/** User deletes a ticket from the board. */
export interface RemoveTicketRequest {
  ticketId: string
  /** Board the ticket lives on; defaults to "default" for v1 compatibility. */
  boardId?: string
}

/** User asks the board to (re)assign a reviewer for an In testing ticket. */
export interface RequestReviewRequest {
  ticketId: string
  /** Board the ticket lives on; defaults to "default" for v1 compatibility. */
  boardId?: string
}

/** User creates a board through the Remote API. */
export interface CreateBoardRequest {
  name: string
  /**
   * Board visibility scope: 'session' (default) keeps the board private to
   * the creating session; 'project' shares it with every session of the
   * caller's workspace (the workspace is stamped from the session cwd).
   */
  scope?: 'session' | 'project'
  /** Ignored by the host: the board's workspace is stamped from the caller's session cwd. */
  workspaceId?: string
}

/** User archives a board through the Remote API. */
export interface ArchiveBoardRequest {
  boardId: string
}

/** Result of a removal. */
export interface RemoveTicketResult {
  removedId: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One durable taskboard mutation has committed. Forwarded to the browser
     * verbatim; the payload is the fresh post-mutation ticket (null on
     * removal) and the board the mutation targeted.
     * @param change - the committed mutation with its post-state ticket.
     * @mode emit
     */
    'taskboard/changed'(change: TaskboardChanged): void
  }
}
