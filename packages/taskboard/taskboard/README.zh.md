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
```

## 工作流

用户在 Backlog 新建工单，并把它拖到 Not started 表示"可以开始"。Agent 用 `taskboard_claim` 领取（受依赖与容量约束），实现后用 `taskboard_complete` 交付。看板随即把卡片移到 In testing 并自动派出一名全新审核 Agent，其唯一权限是 `taskboard_approve` / `taskboard_reject`。驳回会把卡片打回 In progress 并附上具体反馈；开发者返修后再次交付。工单通过 storage-domain 持久化，每次变更都会广播 `taskboard/changed` 事件。

## 席位

看板的 master（用 `taskboard_claim_master` 认领）把 Not started 卡片派给全新 worker 子代理（`taskboard_assign`，仅限顶层会话 Agent）、重新派发被阻塞的工作（`taskboard_reassign`），并裁决 report 模式审核（`taskboard_resolve_review`）。worker 以 `taskboard_report`（完成）或 `taskboard_fail`（失败）收尾；当 worker 上报、失败或终止，或审核结论落板时，master 的在线收件箱会收到一条轻量通知。`taskboard_handover` 将结构化交接笔记（各卡状态、worker 身份、审核席位、待办摘要与 master 历史）写入看板并释放席位；后继者通过 `taskboard_claim_master` 认领时，其返回结果携带这些笔记。

## 模型体验

- `taskboard_list` — 看板行列表，可按列或本人筛选。
- `taskboard_view` — 单个工单全貌：描述、审核状态、反馈。
- `taskboard_claim` — 领取一个 Not started 工单（按序、依赖门控）。
- `taskboard_complete` — 把本人持有的工单连同开发备注送入 In testing。
- `taskboard_claim_review` — 接管空的审核席位（自动派遣失败时的兜底）。
- `taskboard_approve` / `taskboard_reject` — 审核员的唯一决定。
- `taskboard_update` — 修改本人持有工单的内容。
- `taskboard_claim_master` / `taskboard_release_master` — 认领或释放 master 席位；认领结果携带前任 master 的交接笔记。
- `taskboard_handover` — 写入结构化交接笔记并释放 master 席位。
- `taskboard_assign` / `taskboard_reassign` — 派出全新 worker（仅限顶层会话）或重新派发被阻塞的工作。
- `taskboard_report` / `taskboard_fail` — worker 仅有的两种收尾工具。
- `taskboard_resolve_review` — 应用审核员回报的结论。

`taskboard:workflow` 系统提示词段落向每个会话注入按序领取、用子代理并行、不得自审自卡等规则。`taskboard:master` 段落传授席位职责：派单、裁决、以结构化笔记交接。
