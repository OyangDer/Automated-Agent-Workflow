# 工单看板

[English](taskboard.md) | 中文

五列看板工单域的类型与工作流。工单通过 [storage-domain 接口](storage.md) 持久化；Agent 使用 `taskboard_*` 工具驱动工作流，浏览器页签通过 Remote API 渲染同一份状态。包的 [README](../../packages/taskboard/taskboard/README.md) 定义了可调用 API 与模型可见契约。

## 列与工作流

五列固定为规范顺序：`backlog`、`not_started`、`in_progress`、`in_testing`、`done`。用户在 Backlog 新建工单，把它拖到 Not started 表示"可以开始"；Agent 领取 Not started 的工单（依赖与容量门控）、实现、并交付进入 In testing。看板指派一名全新审核 Agent，其唯一权限是通过进入 Done，或驳回工单并附上具体反馈打回 In progress。

```ts
/** The five workflow columns in canonical left-to-right order. */
type ColumnId = 'backlog' | 'not_started' | 'in_progress' | 'in_testing' | 'done'
```

```ts
/** The three ticket priority levels. */
type Priority = 'low' | 'normal' | 'high'
```

## 工单状态

一张工单是一条扁平的持久化记录：内容、列、位置、领取开发、指定审核员、审核轮次与开发备注。审核决定内联记录；历史行仅用于展示且有界。

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

## 排序约束

`dependsOn` 列出必须先行到达 Done 的工单。创建与编辑会对照实时看板校验这些边：未知 id、重复条目、自依赖与传递环都会被拒绝。

## 请求与通知

浏览器 Remote 动词（`snapshot`、`create`、`move`、`edit`、`delete`、`requestReview`）与 Agent 工具走同一服务变更状态，看板因此是唯一事实源。每次提交的变更都会转发一条 `taskboard/changed` 事件；删除转发携带空工单的墓碑。

```ts
/** The durable-change notification forwarded to the browser. */
interface TaskboardChanged {
  operation: TaskboardOperation
  ticketId: string
  /** Full post-mutation view; null only for a removal. */
  ticket: TicketView | null
}
```

## 服务行为

[`TaskboardService`](../../packages/taskboard/taskboard/src/service.ts) 执行工作流转换（领取归属、依赖门控、进行中容量、指定审核员权限、驳回返修）、通过存储域持久化每条记录、在工单进入 In testing 时经子代理接口派出审核子代理，并注入 `taskboard:workflow` 系统提示词段落，向每个会话传授按序领取与不得自审自卡的规则。

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
 * board the caller may see: its own workspace's boards plus the unowned
 * ones. A board owned by another workspace is denied as not found.
 * @param agent - the calling session agent; its workspace scopes the board.
 * @param boardId - the board to snapshot, or undefined for the caller's default board.
 * @returns the live board snapshot.
 */
@Remote('snapshot') async snapshot(agent: Agent, boardId?: string): Promise<BoardSnapshot>

/**
 * List every board the caller may see: its own workspace's boards plus the
 * unowned ones. The implicit unowned "default" board row is reported first
 * when no record exists for it yet (v1 compatibility).
 * @param agent - the calling session agent; its workspace scopes the listing.
 * @returns the visible board rows.
 */
@Remote('listBoards') async listBoards(agent: Agent): Promise<BoardView[]>

/**
 * Create one board through the Remote boundary. The board is stamped with
 * the caller's workspace ('' when unowned); any workspaceId in the request
 * is ignored.
 * @param agent - the calling session agent; its workspace owns the board.
 * @param request - the board name.
 * @returns the created board.
 */
@Remote('createBoard') async createBoardRemote(agent: Agent, request: CreateBoardRequest): Promise<BoardView>

/**
 * Archive one board through the Remote boundary.
 * @param request - the board to archive.
 * @returns the archived board.
 */
@Remote('archiveBoard') async archiveBoardRemote(request: ArchiveBoardRequest): Promise<BoardView>

/**
 * Create one ticket in Backlog through the Remote boundary.
 * @param request - title, description, priority, ordering dependencies, and optional boardId.
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
 * Claim the master seat of one board; a stale seat (past the lease) can be
 * preempted, and an unclaimed board is claimed by this agent.
 * @param boardId - the board to claim.
 * @param agent - the claiming session agent.
 * @returns the board with its fresh master.
 */
async claimMaster(boardId: string, agent: Agent): Promise<BoardView>

/**
 * Release the master seat of one board; only the current master may.
 * @param boardId - the board to release.
 * @param agent - the current master.
 * @returns the board with an empty seat.
 */
async releaseMaster(boardId: string, agent: Agent): Promise<BoardView>

/**
 * Transfer the master seat to another session agent with handover notes.
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

Source: [`packages/taskboard/taskboard/src/service.ts:288`](../../packages/taskboard/taskboard/src/service.ts)

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

Source: [`packages/taskboard/taskboard/src/types.ts:241`](../../packages/taskboard/taskboard/src/types.ts)
<!-- END GENERATED cordis-surface -->