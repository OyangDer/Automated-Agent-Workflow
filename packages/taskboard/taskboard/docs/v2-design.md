# Taskboard v2 设计文档（主 Agent 施工蓝图）

本文档是 v2 的唯一设计权威。所有实现 worker 子代理必须先读本文，再动工。
当前基线：git 分支 `taskboard-plugin`（commit 6387f8265f），v1 已全绿。

## 0. 模型分层（硬性要求）

- 主 Agent（master）：用户会话的模型（DeepSeek v4 pro max），由用户在模型选择器里选。
- worker / reviewer 子代理：**必须** DeepSeek v4 flash。
- 实现方式：派单与派审时在 `SubagentStartRequest.agentOptions` 里传
  `{ model: config.workerModel }`（`...requested` 覆盖父级继承，已核实
  `resolveChildAgentOptions`）。配置项 `masterModel` / `workerModel`
  默认 `'deepseek-v4-pro-max'` / `'deepseek-v4-flash'`，部署可用
  cordis.patch.yml 覆盖（模型名以该部署 `llm-deepseek` 注册的为准）。

## 1. P0：多板 + master 席位 + 派单制

### 1.1 数据模型（storage schema 演进，域版本保持 1）

给 `tickets` 表记录新增字段，全部带 zod 默认值，保证 v1 存量记录可加载：

- `boardId: zod.string().default('default')` —— 板标识；一个 Sprint 一块板。
- `type: zod.enum(['feature','bugfix','refactor','docs','test','merge','infra','chore','spike']).default('feature')`
- `status: zod.enum(['ready','claimed','running','blocked']).default('claimed')`
  —— worker 生命周期；`blocked` 用于失败回收标记（卡片仍留在 In progress，UI 显红）。
- `workerAgentId: zod.string().optional()` / `workerSessionId: zod.string().optional()`
  —— 干活的子代理身份（打回原窗口需要）。
- `failure: zod.object({ reason, at }).nullable().default(null)`
- `revision` 不需要——KvTable.update 原子 CAS 已够。

新增表 `boards`：`{ boardId -> { boardId, name, workspaceId, archivedAt } }`
（域 unit 已有 tickets 表，新增表在 json 后端下自动落成空表，无需迁移）。

### 1.2 master 席位

- 域操作：`claimMaster(boardId, agent)`（CAS：无主或原主失联可夺）、
  `releaseMaster(boardId, agent)`、`transferMaster(boardId, from, to, handoverNotes)`。
- 席位状态存 `boards` 表的 board 记录里：`masterAgentId`, `masterClaimedAt`,
  `handoverNotes`。席位绑定**会话 agent**（agentId），跨会话可交接。
- 只有 master 能调 `assign` / `dispatch` / `plan` / `createForBoard` / `moveForBoard`。
- **V3-25：席位释放按存活状态，不按墙上时钟。** 原先的时钟租约
  （`masterSeatTimeoutMs` / `masterExpiryOf = masterClaimedAt + leaseMs`）已删除，
  与 worker 的 `lost`、reviewer 的 `reviewerStaleTimeoutMs` 统一到会话注册表：
  - 持有会话**不在注册表**里（重启 / 硬死）→ 席位立即释放，落一条 `masterHistory`
    行（`toAgentId = ''`，即席位空置）+ 一条 `master-released` board notice 给继任
    master；`claimMaster` 也据此当场夺回失联席位（不再等租约到期）。
  - 可选 idle 臂 `masterIdleTimeoutMs`（默认 900000，0 = 关闭）：会话仍在注册表、
    但没有 running 工具且活动尾超过 N → 判定卡死并释放。
  - 释放只改**归属**：不动在跑的卡，也不会因此重派 In progress 的卡。
  - 接管入口不变：`taskboard_handover` + `claim_master` 的结构快照
    （cards / notices / pendingAdjudications / backlogSummary）仍是唯一的显式接管路径；
    `masterExpiresAt` 为兼容旧客户端保留，但恒为 `null`。

### 1.3 派单协议（取代自由领取）

- 新工具 `taskboard_assign`（仅 master）：`{ ticketId, workerLabel? }`
  把 Not started 卡移到 In progress，`status=running`，并**当场 spawn** 一个
  worker 子代理（spawn，非 fork），参数：
  - `label` = 工单标题（或 workerLabel）
  - `agentOptions.model = workerModel`（flash）
  - `toolFilter`：只保留实施需要的工具，**剪掉** `taskboard_claim/list/view/move/complete`
    等行政工具；只留 `taskboard_report`（新工具，worker 专用，见 1.4）与实施工具
    （read/write/edit/pwsh/…）。
  - prompt 内置工单内容 + 「完成后必须调 taskboard_report」。
- 卡上记录 `workerAgentId/workerSessionId`。
- worker 无领取入口 → 不可能乱领。多 worker 由 master 串行派发控制并行度。
- 保留 v1 的 `claim` 仅作兼容：无 master 席位时走旧流程（自由领取）。

### 1.4 worker 工具

- `taskboard_report`（仅 assignee worker）：`{ ticketId, devNotes }`
  → 卡进 In testing（等价 v1 complete），随后自动派审（见 1.5）。
- `taskboard_fail`（仅 assignee worker）：`{ ticketId, reason }`
  → 卡 `status=blocked` + `failure`，卡留在 In progress，发 `taskboard/changed`，
  由 master 决定重派/改派/退回 Not started。

### 1.5 失败回收

- 监听子代理终态（`subagents` 的 run 结束事件，或 `agent/session-end`）：
  若 worker 会话异常结束且卡仍在 In progress 且未 report → 自动
  `status=blocked` + failure=`'worker terminated' + stopReason`，事件通知 master。
- master 收到后可用 `taskboard_reassign`：重派（新 worker）或退回 Not started。

### 1.6 客户端 P0

- 板选择器：页签头部下拉，列出 `boards`（含 archived 折叠）；默认 `default` 板。
- 卡片显示 `type` 徽标（配色用现有 `--dsw-alias-state-*` 语义 token）。
- master/worker 徽标：卡上显示 master 名与 worker 名；blocked 红条。
- Remote API：`snapshot(boardId)`、`listBoards()`、`createBoard(name, workspaceId)`、
  `archiveBoard(boardId)`；所有旧端点加 boardId 参数（默认 'default'）。

## 2. P1：审核汇报制 + 打回原窗口 + 归档

- reviewer 仍是 spawn 的全新子代理（flash），但**只产出结构化结论**：
  `outputSchema = { verdict: 'approve'|'reject', summary, problems[] }`，
  它的 prompt 要求它检查工作区/测试后只返回结论，**不直接改卡**。
- master 工具 `taskboard_resolve_review`：master 读结论执行 approve/reject
  （master 不得推翻 reject；连续 reject 达 3 次 → 卡标 blocked，交用户裁决）。
- 打回原窗口：reject 后用**原 worker 的 continuable 子代理**发 followup
  （反馈 + 工单内容），worker 修完再 `taskboard_report`。若原 worker 会话已
  不可用（continuable 丢失/超时），master 改派新 worker（携带全部反馈）。
- 归档：卡 Done 时自动归档该卡的 worker 会话（子代理会话归档）；
  一个 worker 会话只服务一张卡，天然满足"一个对话一个功能"。
- 修订 v1 的「自动派审后 reviewer 直接 approve/reject」：v2 默认走汇报制
  （`config.reviewMode: 'report' | 'direct'`，direct 保留 v1 行为）。

## 3. P2：master 交接 + 子代理归类视图

- 交接：`taskboard_transfer`（1.2）+ master 系统提示词段落教它：
  context 不足先 compaction；真要换人，先给看板写 handoverNotes（含每卡状态、
  进行中 worker 的 continuable id），新 master `claimMaster` 接管后读看板继续；
  已派出的 worker 跑完手头卡即可（不跨会话 followup）。
- 子代理归类视图：新 client 插件 `packages/client/ui-subagent-board`
  （或并入 ui-taskboard）注册进 ui-subagent 的侧栏槽位：把本会话的子代理
  分组显示，打徽标 `In progress` / `In testing`（依据看板卡上的
  workerAgentId/reviewer 归属），并「收起」为一行主会话条目下可展开的组。
  完全隐藏子会话不可行（框架会话模型），这是等效实现。

## 4. P3：merge 验收线 + 讨论写板

- `type=merge` 的卡走专用 reviewer prompt（检查合并冲突、CI、diff 规模），
  且 master 必须确认目标分支。
- master 工具 `taskboard_create` / `taskboard_move` / `taskboard_plan`
  （计划态：在 Backlog 里排 dependsOn/优先级）。用户与 master 讨论后，
  master 落盘（R8）。

## 5. 实现纪律（所有 worker 必须遵守）

- 仓库：`C:\Users\O'yan'd'D'er\deepseek-harness`，分支 `taskboard-plugin`。
- 代码规范：packages/client/AGENTS.md（槽位四共享 props、store 工厂、CSS 语义 token）、
  docs/web-styling.zh.md；host 侧照 v1 的 GoalService/tool-todo 模式。
- 每个包改动后必须：`pnpm run build:lib:host` / `build:lib:client` 通过；
  跑 `npx vitest run packages/taskboard/taskboard/tests packages/client/ui-taskboard/tests` 全绿；
  Remote 契约变了要重跑 `pnpm run gen-cordis-catalog`、`gen-tool-catalog`、`gen-doc-graphs`。
- **不要 git commit**：改完留工作区，调 `taskboard_report` 汇报，master 审后统一提交。
- 文件冲突避免：host 改动只在 packages/taskboard/taskboard/src/*；
  客户端板选择器/标签在 packages/client/ui-taskboard/src/*；
  子代理视图在**新包** packages/client/ui-subagent-board/*（不要动 ui-subagent 本体）。

## 6. 验收

P0 完成后 master 亲自冒烟：真实 `dsh web` 启动 + HTTP 调
`taskboard/snapshot`（新 boardId 参数）+ 建板 + assign 派单走通一次。
