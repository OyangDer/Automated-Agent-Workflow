# 工单看板

[English](taskboard.md) | 中文

五列看板工单域的类型与工作流。工单通过 [storage-domain 接口](storage.zh.md) 持久化；Agent 使用 `taskboard_*` 工具驱动工作流，浏览器页签通过 Remote API 渲染同一份状态。包的 [README](../../packages/taskboard/taskboard/README.zh.md) 定义了可调用 API 与模型可见契约。

## 列与工作流

五列固定为规范顺序：`backlog`、`not_started`、`in_progress`、`in_testing`、`done`。master 与用户一起规划需求（每个达成一致的需求都会落成 Backlog 卡片），并用 `taskboard_assign` 派发本阶段卡片——assign 直接接受 Backlog 或 Not started 卡片，派单前无需搬卡。Not started 是「下一步队列」的排期展示列：master 可以用 `taskboard_move` 把卡片移过去展示接下来要做什么而暂不开工，用户把卡片拖进 Not started 也仍会以 "user-scheduled" 通知唤醒 master。Agent 领取 Not started 的工单（依赖门控）、实现、并交付进入 In testing。看板指派一名全新审核 Agent，其唯一权限是通过进入 Done，或驳回工单并附上具体反馈打回 In progress。

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

[`TaskboardService`](../../packages/taskboard/taskboard/src/service.ts) 执行工作流转换（仅 master 领取归属、依赖门控、指定审核员权限、驳回返修）、通过存储域持久化每条记录、在工单进入 In testing 时经子代理接口派出审核子代理，并注入 `taskboard:workflow` 系统提示词段落，向每个会话传授仅 master 领卡的规则（worker/reviewer 通过 `taskboard_assign` / `taskboard_reassign` 获得卡片）与不得自审自卡的规则。

席位自愈通道（`reconcileLostWorkers` + `reconcileStaleReviewers`，启动时与配置的周期扫描运行）闭合失联席位闭环：worker 会话不在 live agent 注册表立即判失联，已注册但空闲且超过 `lostWorkerTimeoutMs` 无活动判卡死，reviewer 席位超过 `reviewerStaleTimeoutMs` 仍无结论（或会话已消失）则释放。失联 worker 每卡最多自动重派 `workerAutoRetryLimit` 次——卡片描述会附加"续做勿回滚"标注，让新 worker 从保留的工作树继续——预算耗尽后卡片标 blocked 并通知 master。所有恢复动作防重入（每次失联每卡只恢复一次）、与 worker run 结算回调共存去重（二者只有一个生效）、写入卡片历史，且通知故障不会阻断恢复。

## 席位与交接

每个看板有一个 master 席位（用 `taskboard_claim_master` 认领，受租期约束）。master 负责派单（`taskboard_assign` —— 仅限顶层会话 Agent，子代理一律拒绝）、重新派发被阻塞的卡片，并裁决 report 模式审核。`taskboard_handover` 将席位交接产品化：生成结构化交接笔记（各卡状态、每个进行中 worker 的身份、In testing 审核席位、待办摘要与 master 历史），写入看板 `handoverNotes` 并释放席位。后继者通过 `taskboard_claim_master` 认领时，其返回结果携带这些笔记，新会话无需轮询即可继续派单。看板行还上报 `masterExpiresAt`（认领时间加配置租期），供浏览器横幅标记租期将尽。

## master 收件箱通知

当 worker 上报完成（`taskboard_report`）、上报失败（`taskboard_fail`）或未上报即终止，或审核结论落到卡片上时，服务会向看板 master 的在线收件箱注入一条轻量通知（沿用 goal 驱动的收件箱注入先例）。master 的 agent loop 会把它作为普通输入处理——用 `taskboard_resolve_review` 裁决、用 `taskboard_reassign` 重新派单——因此 master 无需轮询看板。席位空缺或 master 会话未加载时静默跳过通知。

## 安装与挂载

`@deepseek-ai/dsh-web-app` bundle 不再挂载本插件。每个插件包自带补丁 —— manifest 通过 `dsh.bundle.patch` 字段声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，该补丁插入一行 —— 因此安装插件包就是挂载它。宿主层提供 `taskboard`，浏览器页签由 `@deepseek-ai/dsh-client-ui-taskboard` 带来。

### 包自带挂载（推荐）

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-taskboard @deepseek-ai/dsh-client-ui-taskboard
```

`dsh plugin add` 会安装该包，并因已安装的 manifest 声明了 `dsh.bundle` 而把它追加进 profile 的 `dsh.profile.bundles`，于是该包的补丁作为又一层生效；这条路径不需要 profile 侧再写 `insert`。新部署一律采用这一形态 —— profile 里不再有任何 taskboard 专属的挂载文本。

### 手写挂载（本机活动 profile）

profile 也可以改为手写声明这两个包：把 `link:` 或版本依赖直接写进自己的 `package.json`，其 `bundles` 不会被 reconcile，此时必须把这两行挂载在自己的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: taskboard
      name: '@deepseek-ai/dsh-taskboard'
    - id: ui-taskboard
      name: '@deepseek-ai/dsh-client-ui-taskboard'
```

本机活动 profile（`$DSH_HOME/profiles/web/`）正是这一形态：

- `package.json` —— 三个本地依赖：`"@deepseek-ai/dsh-taskboard": "link:<checkout>/packages/taskboard/taskboard"`、`"@deepseek-ai/dsh-client-ui-taskboard": "link:<checkout>/packages/client/ui-taskboard"`，以及与本卡无关的本机 `dsh-whale-widget`；而 `dsh.profile.bundles` 只列了 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-whale-widget` —— 两个 taskboard 包都不在 bundle 层里，它们靠下面的 `insert` 块挂载。
- `cordis.patch.yml` —— 上面那个 `insert` 块，随后是一个 `- id: taskboard` 条目，其 `config` 承载本部署的 `preflightRepos`。

这两行是看板从 web-app bundle 解耦（V3-27）时手写补上的。

### 两种形态切勿混用

同一个 id 两种方式都挂会插入两次 —— 同一个插件被挂两次。这个坑是活的：在手写 profile 上跑任何一次 `dsh plugin add`（`update`，或只是装一个无关插件）都会 reconcile 整份依赖表，于是那两个 `link:` 依赖进入 `dsh.profile.bundles`，而显式 `insert` 块仍在原地，两种形态同时生效。切换形态必须落在同一次改动里：`bundles` 条目落地后就删掉 `insert` 行，或者保留 `insert` 行并且永远不要在该 profile 上跑 `dsh plugin add`。

### 迁移顺序与冒烟

无论往哪个方向切，都不是一次编辑能完成的，而且中间态比「少一个页签」更糟：当组合根已经不再挂载该行、profile 却还没声明该包时，Loader 与 request-extension 贡献方的解析基准不同，扩展准备会抛 `REQUEST_EXTENSION`，所有模型请求都会失败。正确顺序是先把 profile 侧落好 —— `package.json` 依赖加 `insert` 行，或跑一次 `dsh plugin add` —— 验证通过后再移除旧的 bundle 挂载或重启宿主。冒烟只放在临时 `$DSH_HOME` 的干净 profile 上，绝不要用活动 profile：自定义 profile 默认 `patchReload: live`，存下一个半成品 `cordis.patch.yml` 会当场重组在线插件树。

### 验收口径

两个包都不装时，`dsh web` 启动的是普通 Web 界面：没有看板页签，也没有 `taskboard` Remote 命名空间。两个包都装好后，页签渲染出来，`/api/taskboard/*` Remote 端点可用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskboard--taskboardservice"></a>

### `ctx.taskboard` — `TaskboardService`

The taskboard service (ctx.taskboard): storage-backed tickets and boards, the master seat, workflow transitions, the browser Remote surface, and the model-facing tools.

```ts cordis-catalog
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
 * to running, failure cleared), "backlog" returns the card to Not started.
 * @param agent - the master session agent.
 * @param ticketId - the In progress card to re-dispatch.
 * @param action - retry or backlog.
 * @param workerLabel - optional display label for a retry worker.
 * @returns the re-dispatched card plus the worker-spawn outcome.
 */
async reassign(agent: Agent, ticketId: string, action: 'retry' | 'backlog', workerLabel?: string): Promise<ReassignTicketResult>

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

Types: [Agent](core.zh.md)

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
