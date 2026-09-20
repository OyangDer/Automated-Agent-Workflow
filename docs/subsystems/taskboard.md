# Taskboard tickets

English | [中文](taskboard.zh.md)

Types and workflow of the five-column kanban ticket domain. Tickets persist through the [storage-domain seam](storage.md); agents drive the workflow with the `taskboard_*` tools, and the browser tab renders the same state through the Remote API. The package [README](../../packages/taskboard/taskboard/README.md) defines the callable API and model-visible contract.

## Columns and workflow

The five columns are fixed in canonical order: `backlog`, `not_started`, `in_progress`, `in_testing`, `done`. The master plans requirements with the user (every agreed requirement becomes a Backlog card) and dispatches the phase's cards with `taskboard_assign`, which accepts a Backlog or Not started card directly — no move is ever required before dispatch. Not started is the scheduling display for the next queue: the master can move a card there with `taskboard_move` to show what is next without starting it, and a user drag into Not started still wakes the master with a "user-scheduled" notice. Agents claim Not started tickets (dependency-gated), implement them, and complete them into In testing. The board assigns a fresh reviewer agent whose only authority is approving into Done or rejecting the ticket back to In progress with concrete feedback.

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

[`TaskboardService`](../../packages/taskboard/taskboard/src/service.ts) enforces the workflow transitions (master-only claim ownership, dependency gating, designated-reviewer authority, reject-and-rework), persists every record through a storage domain, spawns the reviewer child through the subagent seam when a ticket enters In testing, and injects the `taskboard:workflow` system-prompt section that teaches every session the master-only claim rule (workers/reviewers receive cards via `taskboard_assign` / `taskboard_reassign`) and never-review-your-own-ticket rules.

The seat self-healing pass (`reconcileLostWorkers` + `reconcileStaleReviewers`, run at startup and on the configured interval) closes the lost-seat loop: a worker session absent from the live agent registry is lost immediately, a registered-but-idle worker with no activity past `lostWorkerTimeoutMs` is judged stuck, and a reviewer seat with no verdict past `reviewerStaleTimeoutMs` (or whose session is gone) is released. Lost workers are auto-redispatched up to `workerAutoRetryLimit` times per card — the card description carries a "续做勿回滚" annotation so the fresh worker continues the preserved working tree — and the card is blocked with a master notice once the budget is exhausted. Every recovery is reentry-safe (one recovery per card per loss), coexists with the worker run-settlement callback (exactly one wins), writes card history, and never lets a notification fault block the recovery.

## Master seat and handover

One board has one master seat (claim with `taskboard_claim_master`, held against a lease). The master dispatches cards (`taskboard_assign` — restricted to the top-level session agent, never a spawned child), re-dispatches blocked work, and adjudicates report-mode reviews. `taskboard_handover` productizes the seat handover: it generates structured notes (every card's status, each in-flight worker's identity, the In testing review seats, the backlog summary, and the master history), writes them onto the board's `handoverNotes`, and releases the seat. The successor's `taskboard_claim_master` result carries those notes, so a new session can continue dispatching without polling. The board row also reports `masterExpiresAt` (claim time plus the configured lease) so the browser banner can flag a lease about to expire.

## Master inbox notices

When a worker reports (`taskboard_report`), fails (`taskboard_fail`), or terminates without reporting, or when a reviewer verdict lands on a card, the service injects a lightweight notice into the live inbox of the board's master (following the goal-round driver's inbox-injection precedent). The master's agent loop claims it as ordinary input — adjudicate with `taskboard_resolve_review`, re-dispatch with `taskboard_reassign` — so the master never needs to poll the board. A vacant seat or a not-loaded master session silently skips the notice.

## Installation and mounting

The `@deepseek-ai/dsh-web-app` bundle does not mount this plugin. Each plugin package carries its own patch — the manifest declares the `dsh.bundle.patch` field as `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, and that patch inserts one row — so installing the package is what mounts it. The host layer carries `taskboard`; the browser tab arrives with `@deepseek-ai/dsh-client-ui-taskboard`.

### Package-declared mounting (recommended)

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-taskboard @deepseek-ai/dsh-client-ui-taskboard
```

`dsh plugin add` installs the package and, because the installed manifest declares `dsh.bundle`, appends it to the profile's `dsh.profile.bundles`, so the package's patch applies as one further layer; no profile-side `insert` is needed on that path. Use this form for every new deployment — the profile then carries no taskboard mounting text of its own.

### Hand-written mounting (the active profile on this machine)

A profile can instead declare the packages by hand: a `link:` or version dependency written straight into its own `package.json` never has `bundles` reconciled, so the rows must be mounted in the profile's own `cordis.patch.yml`:

```yaml
- insert:
    - id: taskboard
      name: '@deepseek-ai/dsh-taskboard'
    - id: ui-taskboard
      name: '@deepseek-ai/dsh-client-ui-taskboard'
```

This machine's active profile (`$DSH_HOME/profiles/web/`) is in exactly that state:

- `package.json` — three local dependencies: `"@deepseek-ai/dsh-taskboard": "link:<checkout>/packages/taskboard/taskboard"`, `"@deepseek-ai/dsh-client-ui-taskboard": "link:<checkout>/packages/client/ui-taskboard"`, and the unrelated machine-local `dsh-whale-widget`. `dsh.profile.bundles` lists only `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `dsh-whale-widget` — neither taskboard package is a bundle layer, because the `insert` block below is what mounts them.
- `cordis.patch.yml` — the `insert` block above, followed by a second `- id: taskboard` entry whose `config` carries this deployment's `preflightRepos`.

Both rows were written by hand when the board was decoupled from the web-app bundle (V3-27).

### Never mix the two forms

Mounting one id both ways inserts the row twice, so the same plugin is mounted twice. The trap is live: running any `dsh plugin add` — `update`, or installing one unrelated plugin — in a hand-written profile reconciles the whole dependency list, so the two `link:` dependencies join `dsh.profile.bundles` while the explicit `insert` block stays, leaving both forms active at once. Switch forms within one change: drop the `insert` rows once the `bundles` entries land, or keep the rows and never run `dsh plugin add` on that profile.

### Migration order and smoke testing

Whichever direction the switch runs, it takes more than one edit, and the intermediate state is worse than a missing tab: while the composition root no longer mounts the row but the profile does not declare the package yet, the Loader and the request-extension contributor resolve the tree against different bases, so request-extension preparation throws `REQUEST_EXTENSION` and every model request fails. Land the profile-side declaration first — the `package.json` dependency plus the `insert` rows, or one `dsh plugin add` — verify it, and only then remove the old bundle mount or restart the host. Smoke-test in a throwaway `$DSH_HOME` profile, never on the active one: a custom profile defaults to `patchReload: live`, so saving a half-migrated `cordis.patch.yml` recomposes the live plugin tree on the spot.

### Acceptance check

With neither package installed, `dsh web` boots an ordinary Web surface: no board tab and no `taskboard` Remote namespace. With both installed, the tab renders and the `/api/taskboard/*` Remote endpoints answer.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskboard--taskboardservice"></a>

### `ctx.taskboard` — `TaskboardService`

The taskboard service (ctx.taskboard): storage-backed tickets and boards, the master seat, workflow transitions, the browser Remote surface, and the model-facing tools.

```ts cordis-catalog
/**
 * Report one reviewer verdict from a continuable reviewer session (V3-28).
 * A durable reviewer child cannot carry an outputSchema — structured output
 * is a one-shot-only subagent capability — so instead of the
 * structured-output capture it calls the taskboard_review_verdict tool,
 * which lands the same { verdict, summary, problems } report through the one
 * landing path. The reviewer still never decides the card: the master
 * resolves it with taskboard_resolve_review.
 * @param agent - the reviewer session agent.
 * @param ticketId - the In testing ticket under review.
 * @param verdict - 'approve' or 'reject'.
 * @param summary - what the reviewer inspected and concluded.
 * @param problems - concrete rework items (empty when approving).
 * @returns the card with reviewOutcome recorded.
 */
async submitReviewVerdict( agent: Agent, ticketId: string, verdict: 'approve' | 'reject', summary: string, problems: readonly string[], ): Promise<TicketView>

/**
 * One worker-liveness reconciliation pass: every In progress/running card
 * whose worker is lost — absent from the live agent registry (restart /
 * hard death) or registered but idle with no activity past the configured
 * timeout — is recovered through {@link recoverLostWorker}: auto-redispatch
 * while the per-card budget lasts, block with a master notice once
 * exhausted. Shared by the startup scan and the periodic scanner.
 *
 * Liveness authority research (service dependency surface): the agent
 * registry is the exact "is this session's agent alive right now" authority
 * — agents.get(id) returns the live Agent or undefined; presence means
 * live (an idle agent is still alive, only an unregistered session is
 * lost), which is precisely the restart scenario where the in-memory run
 * settlement callbacks are gone. The session event log supplies the
 * activity tail for the idle-staleness arm. The subagent seam's
 * listChildren / listDescendants are parent-rooted tree listings that
 * throw without a mounted projection registry + session store, and the
 * session store tracks persisted sessions rather than live agent loops —
 * neither is a general flat liveness probe, so the registry is used
 * directly, and a missing registry (never in the host, where 'agents' is
 * an injected dependency) degrades to a silent skip without blocking
 * anything.
 *
 * Idempotent by construction and coexistent with the settlement callback:
 * only running cards are considered, and the guarded recovery re-checks
 * column/status/worker identity atomically on the committed record, so a
 * card the settlement callback already recovered (or whose worker came
 * back) is returned untouched — exactly one recovery ever lands per card.
 * @returns how many cards this pass recovered (redispatched or blocked).
 */
async reconcileLostWorkers(): Promise<number>

/**
 * One reviewer-staleness reconciliation pass: every In testing card that
 * still has a review seat but no reviewOutcome is checked against the live
 * agent registry and the review-start clock:
 * - a reviewer session absent from the registry is a ghost seat and is
 *   released immediately (no ghost seats, per the spec);
 * - a reviewer that is registered but idle — no running tool — with the
 *   review pending longer than reviewerStaleTimeoutMs is judged stuck and
 *   the seat is released.
 * On release the card history gets one 'review-release' row, the master is
 * notified, and a fresh reviewer is auto-redispatched when a live master
 * session exists to spawn from; otherwise the seat is left vacant so
 * taskboard_claim_review can take it.
 *
 * Reentry-safe: the guarded mutate only releases a seat that still names
 * the same reviewer and is still In testing without an outcome, so a card
 * another path already released (or resolved) is returned untouched.
 * @returns how many seats this pass released.
 */
async reconcileStaleReviewers(): Promise<number>

/**
 * One master-seat liveness pass (V3-25, revised by V3-32 and V3-34): every
 * board whose seat names a session that is gone for good is released. Seat
 * ownership follows the session, not the process: a holder merely absent
 * from the live agent registry (host restart, idle eviction) but still
 * carrying a stored session record keeps the seat and is never released —
 * the reported "master keeps dropping" fault. Only a holder that has left
 * the registry *and* has no stored record (the session was deleted or
 * cleaned up) is released. A registered holder keeps the seat however long
 * it stays silent: silence is not death, and a master that ends its turn
 * after dispatching and waits for a notice must not be evicted for it.
 *
 * A release changes seat ownership only: in-flight cards keep their workers
 * and reviewers untouched, and no card is ever re-dispatched by this pass.
 * The board gets one masterHistory row (empty target = vacant seat) and a
 * durable notice the successor reads back from taskboard_claim_master /
 * taskboard_notices; taskboard_handover remains the explicit takeover path
 * while the holder is still alive.
 *
 * Reentry-safe: the guarded release only clears the seat that still names
 * the judged holder, so concurrent passes release each board exactly once.
 * @returns how many seats this pass released.
 */
async reconcileMasterSeats(): Promise<number>

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
 * Claim the master seat of one board. V3-25/V3-34: the seat is no longer
 * leased by a wall clock and no longer follows the process either — only a
 * holder session that is gone for good (absent from the live agent registry
 * *and* holding no stored session record) is preempted here, so the
 * successor takes a genuinely vacant seat immediately; a holder the host
 * merely restarted or unloaded still owns it. A preemption leaves a
 * masterHistory row plus a durable board notice the claimant reads back from
 * this claim. A board the caller cannot see is denied as not found (no
 * existence leak), so the master seat of a foreign session-private board
 * cannot be seized.
 *
 * The liveness judgment runs before the (synchronous) board updater because
 * the stored-record probe is asynchronous; the updater then re-checks that
 * the judged holder is still the one on the row, and a seat that changed
 * hands in between fails closed as held rather than preempted on stale
 * evidence.
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
 * Master assigns a Backlog or Not started ticket to a freshly spawned
 * worker: the card moves to In progress, status running, and a worker
 * subagent is spawned immediately; on success its id is recorded on the
 * card. Not started remains the scheduling display for the next queue,
 * but a card needs no move before dispatch — assign accepts it straight
 * from Backlog (V3-6 relaxation).
 * @param agent - the master session agent.
 * @param ticketId - the Backlog or Not started ticket to dispatch.
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
 * to running, failure cleared), "backlog" returns the card to Not started,
 * and "continue" (V3-28) wakes the card's existing worker session instead of
 * spawning a replacement — the manual entry into the same wake path the
 * automatic recovery uses for a running, blocked, or paused card. A refused
 * wake (no continuation state, dead session, no seam) degrades to the
 * historic fresh spawn, so "continue" never leaves the card without a
 * worker.
 * @param agent - the master session agent.
 * @param ticketId - the In progress card to re-dispatch.
 * @param action - retry, backlog, or continue.
 * @param workerLabel - optional display label for a retry worker.
 * @returns the re-dispatched card plus the worker-spawn outcome.
 */
async reassign( agent: Agent, ticketId: string, action: 'retry' | 'backlog' | 'continue', workerLabel?: string, ): Promise<ReassignTicketResult>

/**
 * Master pauses one In progress/running card (taskboard_pause): the
 * in-flight worker run is aborted through the card's recorded handle, the
 * card status flips to 'paused' (column unchanged, one 'pause' history row
 * naming the pauser and the reason), and the master is notified. A paused
 * card is never marked blocked: the settlement callback and the
 * worker-liveness reconciliation only ever act on status 'running', so the
 * paused status alone keeps the card out of V3-13/V3-9 reclamation. Resume
 * with taskboard_reassign action "retry", which clears the paused status
 * and spawns a fresh worker.
 * @param agent - the master session agent.
 * @param ticketId - the In progress card whose worker to pause.
 * @param reason - why the master pauses the card (recorded in history).
 * @returns the paused card.
 */
async pause(agent: Agent, ticketId: string, reason: string): Promise<TicketView>

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
 * Master claims a Not started ticket and schedules it to In progress.
 * V3-7 closes the free claim: under the dispatch system only the master
 * of the ticket's board may claim — workers and reviewers receive cards
 * through taskboard_assign (dispatch) or taskboard_reassign (re-dispatch),
 * never by claiming. The caller must hold the master seat.
 * @param agent - the master session agent.
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
 * @param detail - "compact" (default) returns the compact row; "full" also
 * carries description, devNotes and the pending review report (V3-21 card
 * read layering: compact by default, full when an anomaly needs it).
 * @returns the matching rows in position order.
 */
async listRows( column: ColumnId | null, mine: boolean, agentId: string, detail: 'compact' | 'full' = 'compact', ): Promise<TicketRow[]>

/**
 * One full ticket for the model.
 * @param ticketId - the ticket to read.
 * @returns the full ticket view.
 */
async viewTicket(ticketId: string): Promise<TicketView>

/**
 * Read the durable master notices of one board — the in-board fallback
 * inbox. Every notifyMaster event lands a row here synchronously, so the
 * master can see what happened even when live followup or persistent inbox
 * delivery could not reach it. A board the caller cannot see is denied as
 * not found (no existence leak).
 * @param boardId - the board to read.
 * @param agent - the calling session agent.
 * @returns the board id and its notices, newest last.
 */
async boardNotices(boardId: string, agent: Agent): Promise<{ boardId: string; notices: BoardNotice[] }>
```

Types: [Agent](core.md)

Source: [`packages/taskboard/taskboard/src/service.ts`](../../packages/taskboard/taskboard/src/service.ts)

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

Source: [`packages/taskboard/taskboard/src/types.ts`](../../packages/taskboard/taskboard/src/types.ts)
<!-- END GENERATED cordis-surface -->