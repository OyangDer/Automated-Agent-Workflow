# @deepseek-ai/dsh-taskboard

[English](README.md) | 中文

DeepSeek Harness 的五列看板工单系统：持久化工作流域（Backlog → Not started → In progress → In testing → Done）、面向 Agent 的工作流工具、自动审核员派遣，以及供 `dsh-client-ui-taskboard` 看板页签使用的浏览器 Remote API。

## 组装

Web 配置挂载服务与看板页签：

```yaml
- id: taskboard
  name: '@deepseek-ai/dsh-taskboard'

- id: ui-taskboard
  name: '@deepseek-ai/dsh-client-ui-taskboard'
```

## 配置

```yaml
taskboard:
  maxInProgress: 4    # parallel developer cap; claims beyond it are rejected
  reviewProvider: spawn  # subagent provider for the reviewer child
  masterModel: deepseek-v4-pro-max  # 信息性：新 master 会话的建议模型（会话自身模型为准）
  masterEffort: high   # 信息性：新 master 会话的建议思考强度（off | high | max；缺省用适配器默认）
  workerModel: deepseek-v4-flash  # 每个派发的 worker 子会话的模型
  workerEffort: high   # 每个派发的 worker 子会话的思考强度（off | high | max；缺省用适配器默认）
  reviewerModel: deepseek-v4-flash  # 每个派发的 reviewer 子会话的模型；缺省沿用 workerModel
  reviewerEffort: high # 每个派发的 reviewer 子会话的思考强度；缺省沿用 workerEffort
  reconcileIntervalMs: 60000   # 席位自愈扫描间隔（0 关闭周期扫描）
  lostWorkerTimeoutMs: 600000  # 空闲失联阈值：注册但无活动达此时长即判失联（10 分钟）
  workerAutoRetryLimit: 2      # 每卡自动重派 worker 的上限，超出后卡片标 blocked
  reviewerStaleTimeoutMs: 900000  # In testing 席位超过此时长仍无结论即释放（15 分钟）
```

思考强度采用 deepseek 档位词汇（`off` | `high` | `max`）；无法识别的值回退为缺省（由子会话模型的适配器默认决定）。reviewer 的模型/思考强度缺省时沿 worker 的对应配置。看板级覆盖由 master 通过 `taskboard_board_config` 写入（看板记录上的 `modelConfig` 字段）；若派发 provider 未声明 `effort` 子代理能力，则只带模型、省略思考强度，并在卡片历史记录一条 `model-effort-downgrade` 降级记录，而不是让派发失败。`masterModel`/`masterEffort` 仅为信息性配置：master 会话自身的模型与思考强度始终为准，这两个值会写进 master 系统提示词段落，作为新会话的建议预设。

## 工作流

master 与用户一起规划需求——每个达成一致的需求都会落成 Backlog 卡片——然后用 `taskboard_assign` 派发本阶段的卡片；assign 直接接受 Backlog 或 Not started 卡片，派单前无需搬卡。Not started 是「下一步队列」的排期展示列：master 可以用 `taskboard_move` 把卡片移过去，向用户展示接下来要做什么而暂不开工。当用户直接把卡片拖进 Not started 时，该移动会以一条 "user-scheduled" 通知唤醒看板的 master，由它裁决是否开工或向用户说明拒绝理由。领卡是 master 的排期动作（V3-7）：只有看板当前的 master 才能用 `taskboard_claim` 领取 Not started 卡片（受依赖与容量约束）；worker 与 reviewer 一律不得自行领卡——它们通过 `taskboard_assign`（派单）或 `taskboard_reassign`（重派）获得卡片。看板随即把卡片移到 In testing 并自动派出一名全新审核 Agent，其唯一权限是 `taskboard_approve` / `taskboard_reject`。驳回会把卡片打回 In progress 并附上具体反馈；开发者返修后再次交付。工单通过 storage-domain 持久化，每次变更都会广播 `taskboard/changed` 事件。

## 席位

看板的 master（用 `taskboard_claim_master` 认领）把 Backlog 或 Not started 卡片派给全新 worker 子代理（`taskboard_assign`，仅限顶层会话 Agent）、重新派发被阻塞的工作（`taskboard_reassign`），并裁决 report 模式审核（`taskboard_resolve_review`）。worker 以 `taskboard_report`（完成）或 `taskboard_fail`（失败）收尾；当用户把卡片放入 Not started、worker 上报、失败或终止、worker 失联被自动重派，或审核结论落板时，master 的在线收件箱会收到一条轻量通知。`taskboard_handover` 将结构化交接笔记（各卡状态、worker 身份、审核席位、待办摘要与 master 历史）写入看板并释放席位；后继者通过 `taskboard_claim_master` 认领时，其返回结果携带这些笔记。

## 席位自愈（V3-9）

看板会自动修复卡死或失联的席位，避免卡片无声悬挂：

- **worker 存活判定**：启动扫描 + 周期扫描（`reconcileIntervalMs`）判定每一张 In progress/running 卡片。worker 会话不在 live agent 注册表中即判失联（重启/硬死亡）；已注册但空闲且超过 `lostWorkerTimeoutMs` 无会话活动则判卡死。失联 worker 会被自动重派——新 worker 从保留的工作树继续（卡片描述会附加"续做勿回滚"标注，新 worker 不会回滚）——每卡最多 `workerAutoRetryLimit` 次；超过上限卡片标 blocked 并通知 master；恢复动作都会写入卡片历史。
- **reviewer 失联释放**：对 In testing 且已占审核席位但尚无结论的卡片同样扫描。reviewer 会话不在注册表即为幽灵席位，立即释放；已注册但空闲、审核超过 `reviewerStaleTimeoutMs` 无结论则判卡死并释放席位。有 live master 时自动重派新 reviewer；否则席位保持空缺供 `taskboard_claim_review` 认领。
- 恢复动作防重入（每次失联每卡只恢复一次），与 worker run 结算回调共存去重（二者只有一个生效），通知故障不会阻断恢复。

## 模型体验

- `taskboard_list` — 看板行列表，可按列或本人筛选。
- `taskboard_view` — 单个工单全貌：描述、审核状态、反馈。
- `taskboard_claim` — master 领取一个 Not started 工单（按序、依赖门控；仅 master）。
- `taskboard_complete` — 把本人持有的工单连同开发备注送入 In testing。
- `taskboard_claim_review` — 接管空的审核席位（自动派遣失败时的兜底）。
- `taskboard_approve` / `taskboard_reject` — 审核员的唯一决定。
- `taskboard_update` — 修改本人持有工单的内容。
- `taskboard_claim_master` / `taskboard_release_master` — 认领或释放 master 席位；认领结果携带前任 master 的交接笔记。
- `taskboard_handover` — 写入结构化交接笔记并释放 master 席位。
- `taskboard_assign` / `taskboard_reassign` — 派出全新 worker（仅限顶层会话）或重新派发被阻塞的工作。
- `taskboard_report` / `taskboard_fail` — worker 仅有的两种收尾工具。
- `taskboard_resolve_review` — 应用审核员回报的结论。

`taskboard:workflow` 系统提示词段落向每个会话注入仅 master 领卡的规则（worker/reviewer 通过 `taskboard_assign` / `taskboard_reassign` 获得卡片）、以派单并行的方式，以及不得自审自卡等规则。`taskboard:master` 段落传授席位职责：领卡、派单、裁决、以结构化笔记交接。
