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
export const TASKBOARD_WORKER_STATUSES = ['ready', 'claimed', 'running', 'blocked', 'paused'] as const

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
  /** Worker lifecycle; blocked marks a failed/terminated worker, paused a master-paused card (both stay In progress). */
  status: TicketWorkerStatus
  /** The spawned worker agent/session id; absent until taskboard_assign spawns one. */
  workerAgentId?: string | undefined
  /** The spawned worker run session id (equals workerAgentId for in-process spawns). */
  workerSessionId?: string | undefined
  /** Last worker failure; null while the card is healthy. */
  failure: TicketFailure | null
  /**
   * Automatic worker redispatch attempts for this card (V3-9 liveness
   * self-healing): every time the reconcile pass finds the worker lost and
   * auto-redispatches a replacement, this counter increments. When it reaches
   * the configured workerAutoRetryLimit the card is blocked instead of being
   * redispatched again.
   */
  autoRetries: number
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

/**
 * One durable master notice recorded on the board (the in-board fallback
 * inbox). Every notifyMaster call lands one row here synchronously, so the
 * master can read back what happened even when live followup or persistent
 * inbox delivery could not reach it.
 */
export interface BoardNotice {
  /** Stable event kind, e.g. "worker-done", "worker-failed", "worker-lost". */
  kind: string
  /** Human-readable notice text in the board language. */
  text: string
  /** Unix epoch milliseconds when the notice was recorded. */
  at: number
  /** The ticket the notice refers to; '' for board-wide notices. */
  ticketId: string
}

/**
 * Per-board model/effort overrides for spawned workers and reviewers (V3-5).
 * Every field is optional: an absent field inherits the host config's
 * workerModel/workerEffort (and the reviewer knobs default to the worker
 * ones), so a board overrides only what it names.
 */
export interface BoardModelConfig {
  /** Board-level worker model; inherits the host workerModel when absent. */
  workerModel?: string | undefined
  /** Board-level worker reasoning effort; inherits the host workerEffort when absent. */
  workerEffort?: string | undefined
  /** Board-level reviewer model; inherits the host reviewerModel (default workerModel) when absent. */
  reviewerModel?: string | undefined
  /** Board-level reviewer reasoning effort; inherits the host reviewerEffort (default workerEffort) when absent. */
  reviewerEffort?: string | undefined
}

/** One durable master-seat transition recorded on the board, for hierarchy-tree rendering. */
export interface MasterHistoryEntry {
  /** The previous master session id; null when the seat was empty. */
  fromAgentId: string | null
  /**
   * The session id taking the seat; empty when the row records a V3-25
   * liveness release instead (the seat was vacated because its holder session
   * was gone, so no successor took it in that transition).
   */
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
   * Retired V3-25 wall-clock lease expiry. The master seat has no time lease
   * any more: it follows the holder session and is released by liveness
   * (V3-32/V3-34: only a session that has left the agent registry *and* holds
   * no stored session record releases it; silence alone never does) or handed
   * over explicitly. The host now always
   * reports null here; the field is kept on the wire so older clients keep
   * decoding a board row.
   */
  masterExpiresAt: number | null
  /** Handover notes written on transferMaster/taskboard_handover, for the next master. */
  handoverNotes: string
  /** Durable master-seat transitions (claim/transfer), for hierarchy-tree rendering. */
  masterHistory?: MasterHistoryEntry[]
  /** Durable master notices (the in-board fallback inbox); oldest rows drop past NOTICE_LIMIT. */
  notices?: BoardNotice[]
  /**
   * Per-board worker/reviewer model+effort overrides (V3-5); absent on old
   * records means the host config governs every spawn.
   */
  modelConfig?: BoardModelConfig
  /** When the board was archived; null while active. */
  archivedAt: number | null
}

/** Whole-board snapshot returned by the Remote API. */
export interface BoardSnapshot {
  boardId: string
  name: string
  tickets: TicketView[]
  /** The board's durable master notices, newest last; absent on old hosts. */
  notices?: BoardNotice[]
}

/**
 * The base/candidate relationship of one repo HEAD against the canonical
 * base commit (V3-20): 'equal' when HEAD sits exactly on the base, 'ahead'
 * when HEAD descends from the base, 'behind' when the base descends from
 * HEAD, 'diverged' when the two share no ancestor relationship, and
 * 'unknown' when the canonical commit could not be resolved at all.
 */
export type BaseCandidateRelationship = 'equal' | 'ahead' | 'behind' | 'diverged' | 'unknown'

/**
 * One deterministic repo/worktree preflight report (V3-20), computed fresh
 * at dispatch time from live git facts — never cached. Carries the raw,
 * checkable facts (canonical base branch+commit, assigned worktree, actual
 * branch, HEAD, dirty-file list, base/candidate relationship, declared file
 * scope, cross-card conflicts) plus the invariant judgment: {@link safe} is
 * true only when every invariant holds. A false report fails the dispatch
 * closed (card blocked, no worker spawned); a true report is inlined into
 * the worker prompt so the worker starts from deterministic facts instead of
 * archaeologying the repository. Pure data — the browser outlet imports this
 * module without dragging host services into the client program.
 */
export interface PreflightReport {
  /** True only when every invariant holds; false = the dispatch must fail closed. */
  safe: boolean
  /** Every concrete invariant violation; empty when safe. */
  violations: string[]
  /** The repo root the preflight ran against (git top-level). */
  repoRoot: string
  /** The authoritative baseline: branch + commit. */
  canonicalBase: { branch: string; commit: string }
  /** The worktree assigned to this dispatch (absolute path). */
  assignedWorktree: string
  /** The branch actually checked out ('(detached)' on a detached HEAD). */
  actualBranch: string
  /** The HEAD commit actually checked out. */
  head: string
  /** Uncommitted changes as porcelain entries (untracked included). */
  dirtyFiles: string[]
  /** Whether the current HEAD sits on/above/away from the canonical base. */
  baseCandidateRelationship: BaseCandidateRelationship
  /** The card's declared file scope. */
  filesScope: string
  /** Cross-card file-scope conflicts with other in-flight cards of the same board. */
  conflicts: string[]
  /** Unix epoch milliseconds when the facts were gathered. */
  checkedAt: number
}

/** Mutation verbs surfaced by the forwarded `taskboard/changed` event. */
export type TaskboardOperation =
  | 'create' | 'move' | 'edit' | 'remove'
  | 'claim' | 'complete' | 'approve' | 'reject' | 'review-claim' | 'review-release'
  | 'assign' | 'report' | 'fail' | 'reassign' | 'resolve-review' | 'pause'

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
