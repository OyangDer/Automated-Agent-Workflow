---
description: "The taskboard package group: durable ticket workflow, agent tools, Remote projection, and browser presentation."
kind: "package-group"
---

# taskboard/ — Durable agent work board

English | [中文](README.zh.md)

## Summary

The taskboard group owns the five-column ticket workflow used to plan, dispatch, review, and recover agent work. Its host package persists board state and exposes model-facing tools plus the browser Remote surface; the two client packages render the board and classify child agents by ticket lifecycle.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`taskboard/`](taskboard/README.md) | Durable board state, workflow tools, worker/reviewer dispatch, and Remote projection | `ctx.taskboard` |

<a id="related-documentation"></a>
## Related documentation

- [Taskboard subsystem](../../docs/subsystems/taskboard.md) — persistence, workflow, service, event, and Remote contracts.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-taskboard) — schemas exposed to agents.
- [Taskboard client](../client/ui-taskboard/README.md) — the five-column browser tab.
- [Subagent board client](../client/ui-subagent-board/README.md) — the child-agent lifecycle grouping tab.

<a id="dev-note"></a>
## Dev Note

None.
