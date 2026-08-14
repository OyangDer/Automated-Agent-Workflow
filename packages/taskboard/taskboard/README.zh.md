# @deepseek-ai/dsh-taskboard

[English](README.md) | 中文

DeepSeek Harness 的五列看板工单系统：持久化工作流域（Backlog → Not started →
In progress → In testing → Done）、面向 Agent 的工作流工具、自动审核员派遣，以及
供 `dsh-client-ui-taskboard` 看板页签使用的浏览器 Remote API。

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

用户在 Backlog 新建工单，并把它拖到 Not started 表示"可以开始"。Agent 用
`taskboard_claim` 领取（受依赖与容量约束），实现后用 `taskboard_complete`
交付。看板随即把卡片移到 In testing 并自动派出一名全新审核 Agent，其唯一权限是
`taskboard_approve` / `taskboard_reject`。驳回会把卡片打回 In progress 并附上
具体反馈；开发者返修后再次交付。工单通过 storage-domain 持久化，每次变更都会
广播 `taskboard/changed` 事件。

## 模型体验

- `taskboard_list` — 看板行列表，可按列或本人筛选。
- `taskboard_view` — 单个工单全貌：描述、审核状态、反馈。
- `taskboard_claim` — 领取一个 Not started 工单（按序、依赖门控）。
- `taskboard_complete` — 把本人持有的工单连同开发备注送入 In testing。
- `taskboard_claim_review` — 接管空的审核席位（自动派遣失败时的兜底）。
- `taskboard_approve` / `taskboard_reject` — 审核员的唯一决定。
- `taskboard_update` — 修改本人持有工单的内容。

`taskboard:workflow` 系统提示词段落向每个会话注入按序领取、用子代理并行、
不得自审自卡等规则。
