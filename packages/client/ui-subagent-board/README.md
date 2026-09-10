---
description: "The Web conversation tab that groups live subagents by Taskboard lifecycle for users and maintainers of the client projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent-board

English | [中文](README.zh.md)

## Summary

This package adds a conversation tab that groups the current Session's child agents into In progress, In testing, and unassigned Taskboard categories. It combines the Session controller's child snapshot with the generated Taskboard Remote API and refreshes from the forwarded `taskboard/changed` event.

## Table of Contents

- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="implementation"></a>
## Implementation

The Node entry keeps the browser feature addressable by Loader. The client entry registers the conversation tab, while `SubagentBoardView.tsx` owns grouping and presentation. Mutations continue to flow through the Taskboard service rather than client-local state.

No runtime invariant companion is published because this read-only grouping surface owns no durable event stream or mutable cross-plugin relation; focused client tests cover registration, refresh, grouping, and disposal.

<a id="model-experience"></a>
## Model Experience

### Browser subagent grouping

#### What the model sees

Nothing. This package presents existing Session and Taskboard state to the user from `taskboard/changed` snapshots and does not alter prompts, messages, tools, or provider requests.

#### Token effect

Zero. Opening or refreshing the grouping tab adds no prompt or message content.

#### KV Cache effect

Independent. The package does not modify a model request or its reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Classification is read-only and snapshot-based** — the tab does not dispatch or mutate agents, and a refresh may briefly lag the host event that changed a ticket.

<a id="dev-note"></a>
### Dev Note

None.
