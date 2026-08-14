# Taskboard tickets

English | [中文](taskboard.zh.md)

Types and workflow of the five-column kanban ticket domain. Tickets persist through the [storage-domain seam](storage.md); agents drive the workflow with the `taskboard_*` tools, and the browser tab renders the same state through the Remote API. The package [README](../../packages/taskboard/taskboard/README.md) defines the callable API and model-visible contract.

## Columns and workflow

The five columns are fixed in canonical order: `backlog`, `not_started`, `in_progress`, `in_testing`, `done`. The user creates tickets in Backlog and drags them to Not started as the "start this" signal; agents claim Not started tickets (dependency- and capacity-gated), implement them, and complete them into In testing. The board assigns a fresh reviewer agent whose only authority is approving into Done or rejecting the ticket back to In progress with concrete feedback.

```ts
/** The five workflow columns in canonical left-to-right order. */
type ColumnId = 'backlog' | 'not_started' | 'in_progress' | 'in_testing' | 'done'
```

```ts
/** The three ticket priority levels. */
type Priority = 'low' | 'normal' | 'high'
```

## Ticket state

One ticket is a flat durable record: content, column, position, the claiming developer, the designated reviewer, review rounds, and the developer's completion notes. Review decisions are recorded inline; history rows are display-only and bounded.

```ts
/** One durable review decision recorded on the ticket. */
interface TicketReview {
  outcome: 'approved' | 'rejected'
  feedback: string
  reviewer: TicketAssignee
  attempt: number
  at: number
}
```

```ts
/** The full wire view of one ticket. */
interface TicketView {
  id: string
  title: string
  description: string
  column: ColumnId
  priority: Priority
  createdAt: number
  updatedAt: number
  position: number
  assignee: TicketAssignee | null
  reviewer: TicketAssignee | null
  reviewAttempts: number
  lastReview: TicketReview | null
  devNotes: string
  dependsOn: string[]
  history: TicketHistoryEntry[]
}
```

## Ordering constraints

`dependsOn` lists tickets that must reach Done before this ticket may be claimed. Creation and edits validate the edges against the live board: unknown ids, duplicate entries, self-dependencies, and transitive cycles are rejected.

## Requests and notifications

The browser Remote verbs (`snapshot`, `create`, `move`, `edit`, `delete`, `requestReview`) mutate through the same service as the agent tools, so the board is the single source of truth. Every committed mutation forwards one `taskboard/changed` event; removal forwards a tombstone with a null ticket.

```ts
/** The durable-change notification forwarded to the browser. */
interface TaskboardChanged {
  operation: TaskboardOperation
  ticketId: string
  /** Full post-mutation view; null only for a removal. */
  ticket: TicketView | null
}
```

## Service behavior

[`TaskboardService`](../../packages/taskboard/taskboard/src/service.ts) enforces the workflow transitions (claim ownership, dependency gating, in-progress capacity, designated-reviewer authority, reject-and-rework), persists every record through a storage domain, spawns the reviewer child through the subagent seam when a ticket enters In testing, and injects the `taskboard:workflow` system-prompt section that teaches every session the claim-in-order and never-review-your-own-ticket rules.

## Master seat and handover

One board has one master seat (claim with `taskboard_claim_master`, held against a lease). The master dispatches cards (`taskboard_assign` — restricted to the top-level session agent, never a spawned child), re-dispatches blocked work, and adjudicates report-mode reviews. `taskboard_handover` productizes the seat handover: it generates structured notes (every card's status, each in-flight worker's identity, the In testing review seats, the backlog summary, and the master history), writes them onto the board's `handoverNotes`, and releases the seat. The successor's `taskboard_claim_master` result carries those notes, so a new session can continue dispatching without polling. The board row also reports `masterExpiresAt` (claim time plus the configured lease) so the browser banner can flag a lease about to expire.

## Master inbox notices

When a worker reports (`taskboard_report`), fails (`taskboard_fail`), or terminates without reporting, or when a reviewer verdict lands on a card, the service injects a lightweight notice into the live inbox of the board's master (following the goal-round driver's inbox-injection precedent). The master's agent loop claims it as ordinary input — adjudicate with `taskboard_resolve_review`, re-dispatch with `taskboard_reassign` — so the master never needs to poll the board. A vacant seat or a not-loaded master session silently skips the notice.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskboard--taskboardservice"></a>

### `ctx.taskboard` — `TaskboardService`

The taskboard service (ctx.taskboard): storage-backed tickets and boards, the master seat, workflow transitions, the browser Remote surface, and the model-facing tools.

```ts cordis-catalog
/**
 * Whole-board snapshot, sorted by column then position, scoped to one
 * board the caller may see: its own session-private boards plus its
 * workspace's project boards and the unowned legacy ones. A board outside
 * the caller's scope is denied as not found so its existence is not leaked.
 * @param agent - the calling session agent; its session and workspace scope the board.
 * @param boardId - the board to snapshot, or undefined for the caller's default board.
 * @returns the live board snapshot.
 */
@Remote('snapshot') async snapshot(agent: Agent, boardId?: string): Promise<BoardSnapshot>

/**
 * List every board the caller may see: its session-private boards (scope
 * 'session' owned by this session), its workspace's project boards (scope
 * 'project' with a matching workspaceId), and the unowned legacy default
 * board awaiting adoption. Boards outside those scopes never appear, so a
 * foreign session-private board or a cross-workspace project board is not
 * leaked. The implicit unowned "default" board row is reported first when
 * no record exists for it yet (v1 compatibility).
 * @param agent - the calling session agent; its session and workspace scope the listing.
 * @returns the visible board rows.
 */
@Remote('listBoards') async listBoards(agent: Agent): Promise<BoardView[]>

/**
 * Create one board through the Remote boundary. A 'project' scope stamps
 * the board with the caller's workspace ('' when unowned) and shares it
 * with every session of that workspace; the default 'session' scope records
 * the creating session as the owner and keeps the board private to it. The
 * boardId is always a fresh unique id; any workspaceId in the request is
 * ignored. An unowned caller (no resolvable cwd) is forced into 'session'
 * scope regardless of the request: a 'project' request from an unowned
 * session would otherwise mint a workspaceId-'' board shared with every
 * unowned session (the unowned leak).
 * @param agent - the calling session agent; it owns session boards and its workspace owns project boards.
 * @param request - the board name and visibility scope.
 * @returns the created board.
 */
@Remote('createBoard') async createBoardRemote(agent: Agent, request: CreateBoardRequest): Promise<BoardView>

/**
 * Archive one board through the Remote boundary. A board the caller cannot
 * see is denied as not found (no existence leak).
 * @param agent - the calling session agent.
 * @param request - the board to archive.
 * @returns the archived board.
 */
@Remote('archiveBoard') async archiveBoardRemote(agent: Agent, request: ArchiveBoardRequest): Promise<BoardView>

/**
 * Create one ticket in Backlog through the Remote boundary. The target
 * board must be visible to the caller; an invisible board is denied as not
 * found (no existence leak).
 * @param agent - the calling session agent.
 * @param request - title, description, priority, ordering dependencies, and optional boardId.
 * @returns the created ticket.
 */
@Remote('create') createRemote(agent: Agent, request: CreateTicketRequest): Promise<TicketView>

/**
 * Move one ticket through the Remote boundary; entering In testing also
 * assigns a fresh reviewer through the subagent seam.
 * @param agent - the session agent driving the move (reviewer parent).
 * @param request - target column and optional position anchors.
 * @returns the moved ticket.
 */
@Remote('move') moveRemote(agent: Agent, request: MoveTicketRequest): Promise<TicketView>

/**
 * Edit one ticket through the Remote boundary. The ticket's board must be
 * visible to the caller; an invisible board is denied as not found (no
 * existence leak).
 * @param agent - the calling session agent.
 * @param request - replacement content and dependency edges.
 * @returns the edited ticket.
 */
@Remote('edit') async editRemote(agent: Agent, request: EditTicketRequest): Promise<TicketView>

/**
 * Remove one ticket through the Remote boundary. The ticket's board must be
 * visible to the caller; an invisible board is denied as not found (no
 * existence leak).
 * @param agent - the calling session agent.
 * @param request - the ticket to remove.
 * @returns the removal receipt.
 */
@Remote('delete') async removeRemote(agent: Agent, request: RemoveTicketRequest): Promise<RemoveTicketResult>

/**
 * (Re)assign a reviewer for one In testing ticket through the Remote
 * boundary.
 * @param agent - the session agent spawning the reviewer child.
 * @param request - the In testing ticket to review.
 * @returns the ticket with its fresh reviewer attached.
 */
@Remote('requestReview') async requestReviewRemote(agent: Agent, request: RequestReviewRequest): Promise<TicketView>

/**
 * Claim the master seat of one board; a stale seat (past the lease) can be
 * preempted, and an unclaimed board is claimed by this agent. A board the
 * caller cannot see is denied as not found (no existence leak), so the
 * master seat of a foreign session-private board cannot be seized.
 * @param boardId - the board to claim.
 * @param agent - the claiming session agent.
 * @returns the board with its fresh master.
 */
async claimMaster(boardId: string, agent: Agent): Promise<BoardView>

/**
 * Release the master seat of one board; only the current master may. A
 * board the caller cannot see is denied as not found (no existence leak).
 * @param boardId - the board to release.
 * @param agent - the current master.
 * @returns the board with an empty seat.
 */
async releaseMaster(boardId: string, agent: Agent): Promise<BoardView>

/**
 * Hand over the master seat (master only): generate the structured handover
 * notes — every card's status, each in-flight worker identity, the In
 * testing review seats, the backlog summary, and the master history —
 * write them onto the board's handoverNotes, and release the seat. The
 * successor claims the seat with taskboard_claim_master, whose result
 * carries the notes.
 * @param boardId - the board to hand over.
 * @param agent - the current master.
 * @returns the released board plus the generated notes.
 */
async handover(boardId: string, agent: Agent): Promise<HandoverResult>

/**
 * Transfer the master seat to another session agent with handover notes.
 * A board the caller cannot see is denied as not found (no existence leak).
 * @param boardId - the board to transfer.
 * @param fromAgent - the current master.
 * @param toAgentId - the receiving session agent id.
 * @param handoverNotes - notes for the next master.
 * @returns the board with the new master.
 */
async transferMaster(boardId: string, fromAgent: Agent, toAgentId: string, handoverNotes: string): Promise<BoardView>

/**
 * Master assigns a Not started ticket to a freshly spawned worker: the
 * card moves to In progress, status running, and a worker subagent is
 * spawned immediately; on success its id is recorded on the card.
 * @param agent - the master session agent.
 * @param ticketId - the Not started ticket to dispatch.
 * @param workerLabel - optional display label for the worker child.
 * @returns the card plus the worker-spawn outcome.
 */
async assign(agent: Agent, ticketId: string, workerLabel?: string): Promise<AssignTicketResult>

/**
 * The assigned worker reports development done; the ticket enters In
 * testing and a reviewer (same worker model) is spawned.
 * @param agent - the assigned worker session agent.
 * @param ticketId - the owned In progress ticket.
 * @param devNotes - what changed and how it was verified.
 * @returns the In testing ticket plus the reviewer-spawn outcome.
 */
async report(agent: Agent, ticketId: string, devNotes: string): Promise<CompleteTicketResult>

/**
 * The assigned worker reports failure; the card stays In progress but is
 * marked blocked with a durable failure record.
 * @param agent - the assigned worker session agent.
 * @param ticketId - the owned In progress ticket.
 * @param reason - the concrete failure reason.
 * @returns the blocked ticket.
 */
async fail(agent: Agent, ticketId: string, reason: string): Promise<TicketView>

/**
 * Master re-dispatches one card: "retry" spawns a fresh worker (card back
 * to running, failure cleared), "backlog" returns the card to Not started.
 * @param agent - the master session agent.
 * @param ticketId - the In progress card to re-dispatch.
 * @param action - retry or backlog.
 * @param workerLabel - optional display label for a retry worker.
 * @returns the re-dispatched card plus the worker-spawn outcome.
 */
async reassign(agent: Agent, ticketId: string, action: 'retry' | 'backlog', workerLabel?: string): Promise<ReassignTicketResult>

/**
 * Master records a new ticket on a board's Backlog (the discussion
 * whiteboard: the plan the master agreed with the user is written down).
 * Unlike the Remote create surface, the master tool also sets the ticket
 * type and may target any board the caller masters.
 * @param agent - the master session agent.
 * @param request - title, description, type, priority, dependencies, boardId and optional targetBranch.
 * @returns the created Backlog ticket.
 */
async createAsMaster( agent: Agent, request: CreateTicketRequest & { type?: TicketType; targetBranch?: string }, ): Promise<TicketView>

/**
 * Master schedules a ticket to another column, optionally next to an
 * anchor; entering In testing still auto-assigns a fresh reviewer. The
 * caller must hold the master seat of the ticket's board.
 * @param agent - the master session agent.
 * @param request - target column and optional position anchors.
 * @returns the moved ticket.
 */
async moveAsMaster(agent: Agent, request: MoveTicketRequest): Promise<TicketView>

/**
 * Master adjusts the planning attributes of one ticket: dependency edges,
 * priority, and ordering position inside the ticket's column. Dependencies
 * are validated against the live board; position is an index in the column
 * ordering (halving semantics, like an anchor move).
 * @param agent - the master session agent.
 * @param ticketId - the ticket to plan.
 * @param dependsOn - replacement dependency edges, or undefined to keep them.
 * @param priority - replacement priority, or undefined to keep it.
 * @param position - the desired index in the ticket's column, or undefined to keep it.
 * @returns the planned ticket.
 */
async planAsMaster( agent: Agent, ticketId: string, dependsOn: string[] | undefined, priority: Priority | undefined, position: number | undefined, ): Promise<TicketView>

/**
 * Agent claims a Not started ticket and becomes its owner (v1 path, kept
 * for boards without a master seat).
 * @param agent - the claiming agent.
 * @param ticketId - the Not started ticket to claim.
 * @returns the claimed ticket, now In progress.
 */
async claim(agent: Agent, ticketId: string): Promise<TicketView>

/**
 * Agent takes the empty review seat of one In testing ticket.
 * @param agent - the reviewing agent.
 * @param ticketId - the In testing ticket with no reviewer.
 * @returns the ticket with the reviewer attached.
 */
async claimReview(agent: Agent, ticketId: string): Promise<TicketView>

/**
 * Owner marks development done; the ticket enters In testing and gets a
 * reviewer (v1 path).
 * @param agent - the owning developer agent.
 * @param ticketId - the owned In progress ticket.
 * @param devNotes - what changed and how it was verified.
 * @returns the In testing ticket plus the reviewer-spawn outcome.
 */
async complete(agent: Agent, ticketId: string, devNotes: string): Promise<CompleteTicketResult>

/**
 * The designated reviewer approves; the ticket lands in Done.
 * @param agent - the designated reviewer agent.
 * @param ticketId - the In testing ticket under review.
 * @param summary - what was inspected and why it passes.
 * @returns the approved Done ticket.
 */
async approve(agent: Agent, ticketId: string, summary: string): Promise<TicketView>

/**
 * The designated reviewer rejects; the ticket is returned for rework.
 * @param agent - the designated reviewer agent.
 * @param ticketId - the In testing ticket under review.
 * @param feedback - concrete, actionable rework feedback.
 * @returns the rejected ticket, back In progress.
 */
async reject(agent: Agent, ticketId: string, feedback: string): Promise<TicketView>

/**
 * The master resolves a report-mode review against the reviewer-reported
 * verdict (taskboard_resolve_review). Approve lands the card in Done and
 * archives the worker session; reject returns the card for rework, tries to
 * follow up the original worker, and marks the card blocked on the third
 * consecutive reject for the user to decide. The master may not overturn a
 * rejection into an approval — the verdict is applied as reported.
 * @param agent - the master session agent.
 * @param ticketId - the In testing ticket under review.
 * @param verdict - the reviewer-reported conclusion to apply.
 * @param summary - what the reviewer inspected and concluded.
 * @param problems - concrete rework items (empty on approval).
 * @returns the resolved card plus the followup/archive outcomes.
 */
async resolveReview( agent: Agent, ticketId: string, verdict: string, summary: string, problems: string[], ): Promise<ResolveReviewResult>

/**
 * Edit own-ticket content through the model-facing surface.
 * @param agent - the owning developer agent.
 * @param ticketId - the owned ticket.
 * @param title - replacement title, or undefined to keep it.
 * @param description - replacement description, or undefined to keep it.
 * @param devNotes - replacement notes, or undefined to keep them.
 * @returns the updated ticket.
 */
async updateOwn( agent: Agent, ticketId: string, title: string | undefined, description: string | undefined, devNotes: string | undefined, ): Promise<TicketView>

/**
 * Whole-board rows for the model, optionally filtered.
 * @param column - column filter, or null for every column.
 * @param mine - when true, only rows assigned to agentId.
 * @param agentId - the calling agent's id.
 * @returns the matching rows in position order.
 */
async listRows(column: ColumnId | null, mine: boolean, agentId: string): Promise<TicketRow[]>

/**
 * One full ticket for the model.
 * @param ticketId - the ticket to read.
 * @returns the full ticket view.
 */
async viewTicket(ticketId: string): Promise<TicketView>
```

Types: [Agent](core.md)

Source: [`packages/taskboard/taskboard/src/service.ts:311`](../../packages/taskboard/taskboard/src/service.ts)

<a id="taskboard-events"></a>

### `taskboard/*` events

<a id="taskboardchanged--emit"></a>

#### `taskboard/changed` — emit

One durable taskboard mutation has committed. Forwarded to the browser verbatim; the payload is the fresh post-mutation ticket (null on removal) and the board the mutation targeted.

```ts cordis-catalog
/**
 * One durable taskboard mutation has committed. Forwarded to the browser
 * verbatim; the payload is the fresh post-mutation ticket (null on
 * removal) and the board the mutation targeted.
 * @param change - the committed mutation with its post-state ticket.
 * @mode emit
 */
'taskboard/changed'(change: TaskboardChanged): void
```

Source: [`packages/taskboard/taskboard/src/types.ts:276`](../../packages/taskboard/taskboard/src/types.ts)
<!-- END GENERATED cordis-surface -->