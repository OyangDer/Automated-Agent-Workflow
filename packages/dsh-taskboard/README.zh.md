---
description: "持久化五列 Taskboard 工作流域、面向模型的工具、worker 派发与 reviewer 生命周期。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-taskboard

[English](README.md) | 中文

## 概述

DeepSeek Harness 的五列看板工单系统：持久化工作流域（Backlog → Not started → In progress → In testing → Done）、面向 Agent 的工作流工具、自动审核员派遣，以及供 `dsh-client-ui-taskboard` 看板页签使用的浏览器 Remote API。

## 目录

- [组装](#assembly)
- [配置](#configuration)
- [工作流](#workflow)
- [席位](#master-seat)
- [席位自愈](#seat-self-healing)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="assembly"></a>
## 组装

本包自行挂载：manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，该补丁插入 `taskboard` 行。把本包与看板页签包一起装进 profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-taskboard
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-taskboard
```

`dsh plugin` 会把每个声明了 `dsh.bundle` 的已安装依赖追加进 profile 的 `dsh.profile.bundles`，补丁因此作为又一层生效；`@deepseek-ai/dsh-web-app` bundle 不再挂载这两行；两个包都不装的 profile 没有看板页签。

<a id="configuration"></a>
## 配置

```yaml
taskboard:
  reviewProvider: spawn  # subagent provider for the reviewer child
  masterModel: deepseek-v4-pro-max  # informational: suggested model for a NEW master session (the session's own model is authoritative)
  masterEffort: high   # informational: suggested reasoning effort for a NEW master session (off | high | max; unset = adapter default)
  workerModel: deepseek-v4-flash  # model for every spawned worker child
  workerEffort: high   # reasoning effort for every spawned worker child (off | high | max; unset = adapter default)
  reviewerModel: deepseek-v4-flash  # model for every spawned reviewer child; defaults to workerModel
  reviewerEffort: high # reasoning effort for every spawned reviewer child; defaults to workerEffort
  reconcileIntervalMs: 60000   # seat self-healing scan interval (0 disables the periodic scan)
  lostWorkerTimeoutMs: 600000  # idle-staleness: registered worker with no activity this long is judged lost (10 min)
  workerAutoRetryLimit: 2      # per-card automatic worker redispatch cap before the card is blocked
  reviewerStaleTimeoutMs: 900000  # registered-but-idle In testing seat without a verdict this long is released (15 min)
  reviewerAutoRetryLimit: 2    # per-card automatic reviewer re-review cap before the card is blocked
```

思考强度采用 deepseek 档位词汇（`off` | `high` | `max`）；无法识别的值回退为缺省（由子会话模型的适配器默认决定）。reviewer 的模型/思考强度缺省时沿 worker 的对应配置。看板级覆盖由 master 通过 `taskboard_board_config` 写入（看板记录上的 `modelConfig` 字段）；若派发 provider 未声明 `effort` 子代理能力，则只带模型、省略思考强度，并在卡片历史记录一条 `model-effort-downgrade` 降级记录，而不是让派发失败。`masterModel`/`masterEffort` 仅为信息性配置：master 会话自身的模型与思考强度始终为准，这两个值会写进 master 系统提示词段落，作为新会话的建议预设。

<a id="workflow"></a>
## 工作流

master 与用户一起规划需求——每个达成一致的需求都会落成 Backlog 卡片——然后用 `taskboard_assign` 派发本阶段的卡片；assign 直接接受 Backlog 或 Not started 卡片，派单前无需搬卡。Not started 是「下一步队列」的排期展示列：master 可以用 `taskboard_move` 把卡片移过去，向用户展示接下来要做什么而暂不开工。当用户直接把卡片拖进 Not started 时，该移动会以一条 "user-scheduled" 通知唤醒看板的 master，由它裁决是否开工或向用户说明拒绝理由。领卡是 master 的排期动作（V3-7）：只有看板当前的 master 才能用 `taskboard_claim` 领取 Not started 卡片（受依赖约束）；worker 与 reviewer 一律不得自行领卡——它们通过 `taskboard_assign`（派单）或 `taskboard_reassign`（重派）获得卡片。看板随即把卡片移到 In testing 并自动派出一名全新审核 Agent，其唯一权限是 `taskboard_approve` / `taskboard_reject`。驳回会把卡片打回 In progress 并附上具体反馈；开发者返修后再次交付。工单通过 storage-domain 持久化，每次变更都会广播 `taskboard/changed` 事件。

<a id="master-seat"></a>
## 席位

看板的 master（用 `taskboard_claim_master` 认领）把 Backlog 或 Not started 卡片派给全新 worker 子代理（`taskboard_assign`，仅限顶层会话 Agent）、重新派发被阻塞的工作（`taskboard_reassign`），并裁决 report 模式审核（`taskboard_resolve_review`）。worker 以 `taskboard_report`（完成）或 `taskboard_fail`（失败）收尾；当用户把卡片放入 Not started、worker 上报、失败或终止、worker 失联被自动重派，或审核结论落板时，master 的在线收件箱会收到一条轻量通知。`taskboard_handover` 将结构化交接笔记（各卡状态、worker 身份、审核席位、待办摘要与 master 历史）写入看板并释放席位；后继者通过 `taskboard_claim_master` 认领时，其返回结果携带这些笔记。

<a id="seat-self-healing"></a>
## 席位自愈（V3-9）

看板会自动修复卡死或失联的席位，避免卡片无声悬挂：

- **worker 存活判定**：启动扫描 + 周期扫描（`reconcileIntervalMs`）判定每一张 In progress/running 卡片。worker 会话不在 live agent 注册表中即判失联（重启/硬死亡）；已注册但空闲且超过 `lostWorkerTimeoutMs` 无会话活动则判卡死。失联 worker 会被自动重派——新 worker 从保留的工作树继续（卡片描述会附加"续做勿回滚"标注，新 worker 不会回滚）——每卡最多 `workerAutoRetryLimit` 次；超过上限卡片标 blocked 并通知 master；恢复动作都会写入卡片历史。
- **reviewer 存活与陈旧判定**：对 In testing 且已占审核席位但尚无结论的卡片同样扫描，并与 master 席位共用同一套会话存活判据（V3-43）：只有当持有者会话彻底消失——既不在 live agent 注册表、会话存储里也没有记录——才释放席位；report 模式 reviewer 本就是常驻会话存储（ready、非 live）的 durable 子会话，注册表缺席并不等于死亡。**已注册**但空闲、审核超过 `reviewerStaleTimeoutMs` 无结论则判卡死并释放席位。有 live master 时自动重派新 reviewer，每卡最多 `reviewerAutoRetryLimit` 次；超过上限则把卡片标 blocked、写明原因并通知 master，而不是无限重派。没有 live master 时席位保持空缺供 `taskboard_claim_review` 认领。
- 恢复动作防重入（每次失联每卡只恢复一次），与 worker run 结算回调共存去重（二者只有一个生效），通知故障不会阻断恢复。

<a id="model-experience"></a>
## 模型体验

### Taskboard 提示词、工具与结果

#### 模型看到的内容

模型会收到生成的 [`taskboard_*` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-taskboard)、紧凑调用／结果和 `taskboard:workflow` 策略；看板 master 还会收到用于领卡、派发、裁决与结构化交接的 `taskboard:master` 指引。worker 和 reviewer 只收到符合其角色的工作流说明，绝不会仅凭浏览器状态取得权限。

#### Token 影响

workflow 与 master 段落在作用域内增加有界的固定提示词成本。每次工具调用追加紧凑的调用与结果；`taskboard_list` 默认返回精简行，完整工单详情需显式请求。

#### KV Cache 影响

插件配置和可见性不变时，提示词段落与工具 schema 保持前缀稳定。工单变更与工具结果只追加在可复用前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **自动派发依赖可用的 subagent provider**：没有 provider 能派发所配置的 worker 或 reviewer 时，持久卡片仍会保留，供 master 重新派发或手动认领审核席位。

<a id="dev-note"></a>
### 开发备注

删除操作的 Remote 线上方法名为 `taskboard/delete`；实现函数可以继续命名为 `removeRemote`，但不得暴露 `taskboard/remove`，因为 namespace service 已继承名为 `remove` 的生命周期方法。
