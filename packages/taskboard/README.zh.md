---
description: "taskboard 包组：持久工单工作流、Agent 工具、Remote 投影与浏览器界面。"
kind: "package-group"
---

# taskboard/ — 持久 Agent 工作看板

[English](README.md) | 中文

## 概述

taskboard 包组负责用于规划、派发、审核和恢复 Agent 工作的五列工单流程。主机包持久化看板状态，并提供面向模型的工具和浏览器 Remote 界面；两个客户端包分别渲染看板，以及按工单生命周期归类子 Agent。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`taskboard/`](taskboard/README.zh.md) | 持久看板状态、工作流工具、worker/reviewer 派发与 Remote 投影 | `ctx.taskboard` |

<a id="related-documentation"></a>
## 相关文档

- [Taskboard 子系统](../../docs/subsystems/taskboard.zh.md)——持久化、工作流、服务、事件与 Remote 契约。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-taskboard)——向 Agent 暴露的 schema。
- [Taskboard 客户端](../client/ui-taskboard/README.zh.md)——五列浏览器页签。
- [Subagent board 客户端](../client/ui-subagent-board/README.zh.md)——子 Agent 生命周期分组页签。

<a id="dev-note"></a>
## 开发备注

无。
