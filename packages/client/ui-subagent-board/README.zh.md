---
description: "为用户和客户端投影维护者说明按 Taskboard 生命周期分组实时子 Agent 的 Web 会话页签。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent-board

[English](README.md) | 中文

## 概述

本包新增一个会话页签，把当前 Session 的子 Agent 按 Taskboard 生命周期分为 In progress、In testing 和未分配三组。它组合 Session controller 的子 Agent 快照与生成的 Taskboard Remote API，并通过转发的 `taskboard/changed` 事件刷新。

## 目录

- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="implementation"></a>
## 实现

Node 入口让 Loader 可以寻址该浏览器功能。客户端入口注册会话页签，`SubagentBoardView.tsx` 负责分组和呈现。所有变更仍经由 Taskboard 服务执行，不在客户端维护独立状态。

不发布运行时不变量伴生入口，因为这个只读分组界面不拥有持久事件流或可变的跨插件关系；客户端专项测试覆盖注册、刷新、分组与卸载。

<a id="model-experience"></a>
## 模型体验

### 浏览器子 Agent 分组

#### 模型看到的内容

无。本包只根据 `taskboard/changed` 快照向用户呈现已有的 Session 与 Taskboard 状态，不改变 prompt、消息、工具或 provider 请求。

#### Token 影响

零。打开或刷新分组页签不会增加 prompt 或消息内容。

#### KV Cache 影响

相互独立。本包不修改模型请求或其可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **分类为只读快照**：该页签不派发或修改 Agent，刷新结果可能短暂落后于改变工单的主机事件。

<a id="dev-note"></a>
### 开发备注

无。
