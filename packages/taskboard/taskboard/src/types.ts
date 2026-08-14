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
  /** Developer's completion notes, filled when the ticket enters testing. */
  devNotes: string
  /** Hard ordering constraints: every listed ticket must be in Done before claim. */
  dependsOn: string[]
  history: TicketHistoryEntry[]
}

/** Whole-board snapshot returned by the Remote API. */
export interface BoardSnapshot {
  tickets: TicketView[]
}

/** Mutation verbs surfaced by the forwarded `taskboard/changed` event. */
export type TaskboardOperation =
  | 'create' | 'move' | 'edit' | 'remove'
  | 'claim' | 'complete' | 'approve' | 'reject' | 'review-claim'

/** The durable-change notification forwarded to the browser. */
export interface TaskboardChanged {
  operation: TaskboardOperation
  ticketId: string
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
}

/** User drags a ticket to another column, optionally next to an anchor. */
export interface MoveTicketRequest {
  ticketId: string
  column: ColumnId
  /** Insert immediately before this ticket's position; null to ignore. */
  beforeTicketId: string | null
  /** Insert immediately after this ticket's position; used when before is null. */
  afterTicketId: string | null
}

/** User edits ticket content and ordering constraints. */
export interface EditTicketRequest {
  ticketId: string
  title: string
  description: string
  priority: Priority
  dependsOn: string[]
}

/** User deletes a ticket from the board. */
export interface RemoveTicketRequest {
  ticketId: string
}

/** User asks the board to (re)assign a reviewer for an In testing ticket. */
export interface RequestReviewRequest {
  ticketId: string
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
     * removal).
     * @param change - the committed mutation with its post-state ticket.
     * @mode emit
     */
    'taskboard/changed'(change: TaskboardChanged): void
  }
}
