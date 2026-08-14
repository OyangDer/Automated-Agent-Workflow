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