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

/**
 * The worker lifecycle of one card (v2 dispatch protocol, extended by the V6-1
 * fixed-headcount roster). `queued` is the roster's visible waiting state: the
 * card stayed in its column (Backlog/Not started) because every member that
 * could take it is busy and the headcount cap is reached — it never silently
 * stops moving, and the wait reason is readable on the card itself.
 */
export const TASKBOARD_WORKER_STATUSES = ['ready', 'claimed', 'running', 'blocked', 'paused', 'queued'] as const

/** One worker lifecycle state. */
export type TicketWorkerStatus = typeof TASKBOARD_WORKER_STATUSES[number]

/** The two roster roles; every member is exactly one of them. */
export const TASKBOARD_MEMBER_ROLES = ['worker', 'reviewer'] as const

/** One roster role. */
export type MemberRole = typeof TASKBOARD_MEMBER_ROLES[number]

/**
 * One durable roster member (V6-1). A member is NOT a session: the member
 * identity survives session rotation — its number,履历 (modules/recent cards)
 * and short summary persist — while {@link MemberRecord.sessionId} names the
 * session currently bound to it, which may be woken (continue) or replaced on
 * a threshold without ever changing the headcount.
 */
export interface MemberRecord {
  /** Stable per-board member id: "W1"/"W2" for workers, "R1"/"R2" for reviewers. */
  id: string
  /** The board this member belongs to (member ids are per board). */
  boardId: string
  role: MemberRole
  /** The fixed partner member id: W1 <-> R1, W2 <-> R2 (one pair owns one card). */
  partnerId: string
  /** The session currently bound to the member; '' before its first dispatch. */
  sessionId: string
  /**
   * The member's short work summary (capped at MEMBER_SUMMARY_LIMIT
   * characters), built from its familiar modules, recently finished cards and
   * current load. This is the ONLY thing the master reads for matching
   * (the master never reads a member's full context), and it is persisted
   * server-side so a later office view can render it.
   */
  summary: string
  /** Familiar module keywords (lower-case path segments harvested from filesScope). */
  modules: string[]
  /** Recently finished ticket ids, newest first (capped). */
  recentTickets: string[]
  /**
   * When the member was archived (V6-3); null while the member is active.
   * Archive is never a delete: the record — number, partner, module履历 and
   * summary — is kept, the member is skipped by every dispatch, and the user
   * can restore it later. Absent on records written before the field existed
   * and read back as null.
   */
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/** One roster member as the wire serves it: the durable record plus derived load. */
export interface MemberView extends MemberRecord {
  /**
   * Derived load: `busy` holds a card that has not reached Done yet,
   * `archived` is excluded from dispatch (V6-3) and `idle` is ready for a card.
   */
  status: 'idle' | 'busy' | 'archived'
  /** The card the member currently holds (In progress or In testing); null when idle. */
  currentTicketId: string | null
}

/**
 * One card's visible queue state (V6-1). Set when a dispatch had to wait:
 * every member that could take the card is busy and the headcount cap is
 * reached. The card keeps its column and carries the reason, so the wait is
 * readable instead of the card silently standing still.
 */
export interface TicketQueue {
  /** Why the card is waiting, in the board language (names the busy members). */
  reason: string
  /** Unix epoch milliseconds when the card entered the queue. */
  enqueuedAt: number
  /** 1-based first-come-first-served position among this board's queued cards. */
  position: number
}

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
  /** The board (stage, V6-4) this ticket belongs to; one stage one board. */
  boardId: string
  /** Ticket kind badge. */
  type: TicketType
  /** Worker lifecycle; blocked marks a failed/terminated worker, paused a master-paused card (both stay In progress). */
  status: TicketWorkerStatus
  /** The spawned worker agent/session id; absent until taskboard_assign spawns one. */
  workerAgentId?: string | undefined
  /** The spawned worker run session id (equals workerAgentId for in-process spawns). */
  workerSessionId?: string | undefined
  /**
   * The fixed roster member that owns this card as worker (V6-1), e.g. "W1".
   * Absent on cards dispatched before the roster existed. The member identity
   * outlives its session, so a rework after a rejection goes back to this
   * member instead of picking someone new.
   */
  workerMemberId?: string | undefined
  /**
   * The fixed roster member holding this card's review seat (V6-1), e.g.
   * "R1" — the fixed partner of {@link workerMemberId}. Kept across rework
   * rounds so the same reviewer re-reviews the same card.
   */
  reviewerMemberId?: string | undefined
  /**
   * The card's visible wait state; null (or absent on old records) while the
   * card is not waiting for a free member.
   */
  queue?: TicketQueue | null | undefined
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
  /**
   * Automatic reviewer redispatch attempts for this card (V3-43 loop brake):
   * every time the reviewer-staleness reconciliation releases this card's seat
   * and auto-redispatches a fresh reviewer, this counter increments. When it
   * reaches the configured reviewerAutoRetryLimit the seat is still released
   * but the card is blocked with the reason instead of getting yet another
   * reviewer; a deliberate reseat (a fresh worker completion, a master
   * request, a manual claim) resets it to 0. Absent on records written before
   * the field existed and read back as 0.
   */
  reviewerRetries?: number | undefined
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
  /**
   * Hard ordering constraints: every listed ticket must be in Done before
   * claim, and (V6-4 C) every one of them must live on the SAME stage — a
   * cross-stage dependency is only accepted when it was declared explicitly
   * with a reason, which is recorded here.
   */
  dependsOn: string[]
  /**
   * V6-4 C: the reason a card was allowed to keep a dependency pointing at
   * another stage. Empty when every dependency is same-stage (the default).
   */
  crossStageReason?: string
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
  /**
   * Per-board roster headcount overrides (V6-3); an absent field falls back to
   * the host config's workerCapacity/reviewerCapacity. Kept on the board record
   * so the headcount survives a restart and every session sees the same one.
   */
  rosterConfig?: BoardRosterConfig
  /** When the board was archived; null while active. */
  archivedAt: number | null
  /**
   * V6-4 stage ordering: the 1-based position of this board in the caller
   * workspace's stage chain (stage 1 is the oldest kept stage, so the legacy
   * "default" board becomes stage 1). Absent on a board created before stages
   * existed; the stage list fills the gap lazily.
   */
  stageIndex?: number
  /** V6-4 stage display name ("阶段 2"); absent falls back to {@link name}. */
  stageName?: string
  /**
   * V6-4: true on the workspace's CURRENT stage — the board every read and
   * defaulted write resolves to. Exactly one visible stage is current; a board
   * without the field reads as not current (v1 behaviour: "default").
   */
  active?: boolean
}

/**
 * Per-board roster headcount (V6-3): how many WORKER and how many REVIEWER
 * members this board keeps. Both fall back to the host config when absent, and
 * the headcount is a cap, not a fixture — a slot is materialized as a member
 * when the user raises the cap and needs a free member.
 */
export interface BoardRosterConfig {
  /** Max worker members on this board; absent inherits the host config. */
  workerCapacity?: number | undefined
  /** Max reviewer members on this board; absent inherits the host config. */
  reviewerCapacity?: number | undefined
}

/** Whole-board snapshot returned by the Remote API. */
export interface BoardSnapshot {
  boardId: string
  name: string
  tickets: TicketView[]
  /** The board's durable master notices, newest last; absent on old hosts. */
  notices?: BoardNotice[]
  /**
   * The board's roster (V6-1), ordered by role then member index; absent on
   * old hosts. Each row carries the member's short work summary, its derived
   * load and the card it currently holds — the server-side data the office
   * view reads, with no member context on the wire.
   */
  members?: MemberView[]
  /**
   * The board's effective roster headcount per role (V6-3); absent on old
   * hosts. The office view reads it for the headcount controls, so what the
   * user raises or lowers is the cap dispatch actually runs under.
   */
  capacity?: { worker: number; reviewer: number }
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
  /**
   * V6-4 C: the reason a dependency pointing at ANOTHER stage is declared on
   * purpose. Omit it for the default (same-stage) dependency rule.
   */
  crossStageReason?: string
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
  /** V6-4 C: the explicit reason for a cross-stage dependency (see CreateTicketRequest). */
  crossStageReason?: string
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

/**
 * One development stage (V6-4) as the stage list surfaces it: the board that
 * holds it, its stage bookkeeping, and its card census. Cards, Done and card
 * history belong to the stage; members, headcount, seats and model config are
 * carried across stages so a new stage never needs its team rebuilt.
 */
export interface StageView {
  boardId: string
  /** The board's own name. */
  name: string
  /** The stage display name; the board name when no stage name is set. */
  stageName: string
  /** 1-based position in the caller workspace's stage chain. */
  stageIndex: number
  /** True on the workspace's current stage: what every read defaults to. */
  active: boolean
  /** When the stage ended; null while it is still live. */
  archivedAt: number | null
  scope: 'session' | 'project'
  workspaceId: string
  /** Cards per column on this stage. */
  counts: Record<ColumnId, number>
  /** Total cards on this stage (every column). */
  total: number
}

/** One compact stage row, as the stage tool and the stage list report it (V6-4). */
export interface StageRow {
  boardId: string
  /** The stage display name. */
  stageName: string
  /** 1-based position in the stage chain. */
  stageIndex: number
  /** True on the workspace's current stage. */
  active: boolean
  /** True when the stage ended: its history is readable, commands are refused. */
  archived: boolean
  /** Cards on the stage (every column). */
  total: number
  /** Cards in the Done column. */
  done: number
}

/** V6-4: start the next stage, leaving the previous one as read-only history. */
export interface CreateStageRequest {
  /** Stage display name; defaults to "阶段 <n>". */
  name?: string
  /** The stage this one succeeds; defaults to the caller's current stage. */
  fromBoardId?: string
}

/**
 * V6-4: make one stage current. Switching to an ended (archived) stage
 * re-activates it — the explicit "switch back" that sanctions editing that
 * stage's history again.
 */
export interface SwitchStageRequest {
  boardId: string
}

/**
 * V6-4 (G/H): migrate an explicit batch of cards to another stage in one
 * operation. Card history, devNotes, dependencies and the Done column travel
 * with the cards; the tool reports exactly which cards moved where.
 */
export interface MigrateTicketsRequest {
  ticketIds: string[]
  targetBoardId: string
}

/** V6-4: the receipt of one migration. */
export interface MigrateTicketsResult {
  targetBoardId: string
  /** The migrated card ids, in the order given. */
  moved: string[]
  /** The stages the cards came from, first-seen order. */
  fromBoardIds: string[]
}

/**
 * User changes one role's roster headcount (V6-3). Raising the cap creates the
 * missing member(s) — numbered and immediately dispatchable. Lowering it is
 * only accepted together with {@link archiveMemberId}: the user names which
 * member to archive, because the system must never pick a member itself.
 */
export interface SetRosterCapacityRequest {
  boardId?: string
  /** Which roster the headcount belongs to. */
  role: MemberRole
  /** The role's new cap; must be a positive integer. */
  count: number
  /**
   * The member of this role to archive, named by the user. Required exactly
   * when `count` is below the role's current cap (one step at a time), and
   * refused when that member currently holds a card.
   */
  archiveMemberId?: string
}

/** User restores one archived roster member (V6-3); it takes cards again. */
export interface RestoreMemberRequest {
  boardId?: string
  /** The archived member to bring back. */
  memberId: string
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
