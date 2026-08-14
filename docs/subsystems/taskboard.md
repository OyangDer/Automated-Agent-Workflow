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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskboard--taskboardservice"></a>

### `ctx.taskboard` — `TaskboardService`

The taskboard service (ctx.taskboard): storage-backed tickets, workflow transitions, the browser Remote surface, and the model-facing tools.

```ts cordis-catalog
/**
 * Whole-board snapshot, sorted by column then position.
 * @returns the live board snapshot.
 */
@Remote('snapshot') async snapshot(): Promise<BoardSnapshot>

/**
 * Create one ticket in Backlog through the Remote boundary.
 * @param request - title, description, priority, and ordering dependencies.
 * @returns the created ticket.
 */
@Remote('create') createRemote(request: CreateTicketRequest): Promise<TicketView>

/**
 * Move one ticket through the Remote boundary; entering In testing also
 * assigns a fresh reviewer through the subagent seam.
 * @param agent - the session agent driving the move (reviewer parent).
 * @param request - target column and optional position anchors.
 * @returns the moved ticket.
 */
@Remote('move') moveRemote(agent: Agent, request: MoveTicketRequest): Promise<TicketView>

/**
 * Edit one ticket through the Remote boundary.
 * @param request - replacement content and dependency edges.
 * @returns the edited ticket.
 */
@Remote('edit') async editRemote(request: EditTicketRequest): Promise<TicketView>

/**
 * Remove one ticket through the Remote boundary.
 * @param request - the ticket to remove.
 * @returns the removal receipt.
 */
@Remote('delete') async removeRemote(request: RemoveTicketRequest): Promise<RemoveTicketResult>

/**
 * (Re)assign a reviewer for one In testing ticket through the Remote
 * boundary.
 * @param agent - the session agent spawning the reviewer child.
 * @param request - the In testing ticket to review.
 * @returns the ticket with its fresh reviewer attached.
 */
@Remote('requestReview') async requestReviewRemote(agent: Agent, request: RequestReviewRequest): Promise<TicketView>

/**
 * Agent claims a Not started ticket and becomes its owner.
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
 * reviewer.
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

Source: [`packages/taskboard/taskboard/src/service.ts:151`](../../packages/taskboard/taskboard/src/service.ts)

<a id="taskboard-events"></a>

### `taskboard/*` events

<a id="taskboardchanged--emit"></a>

#### `taskboard/changed` — emit

One durable taskboard mutation has committed. Forwarded to the browser verbatim; the payload is the fresh post-mutation ticket (null on removal).

```ts cordis-catalog
/**
 * One durable taskboard mutation has committed. Forwarded to the browser
 * verbatim; the payload is the fresh post-mutation ticket (null on
 * removal).
 * @param change - the committed mutation with its post-state ticket.
 * @mode emit
 */
'taskboard/changed'(change: TaskboardChanged): void
```

Source: [`packages/taskboard/taskboard/src/types.ts:146`](../../packages/taskboard/taskboard/src/types.ts)
<!-- END GENERATED cordis-surface -->