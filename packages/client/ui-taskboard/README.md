---
description: "The Web Taskboard tab, live five-column projection, master-seat banner, and user-facing ticket controls."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-taskboard

English | [中文](README.zh.md)

## Summary

The Taskboard kanban tab: a five-column conversation view (Backlog, Not started, In progress, In testing, Done) with HTML5 drag-and-drop between columns, an inline new-ticket form, and a detail panel showing assignee, review state, rejection feedback, developer notes, and history. Live state arrives through the forwarded `taskboard/changed` host event; every mutation goes through the generated `taskboard` Remote API.

## Table of Contents

- [Master seat banner](#master-seat-banner)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model and effort selectors](#model-and-effort-selectors)
- [Dev Note](#dev-note)

<a id="master-seat-banner"></a>

## Master seat banner

The board header shows the master-seat status: the holder (short id, with a warning when the lease is about to expire), a lapsed lease (shown as expired and preemptable, with the takeover affordance restored), or the vacant state with a one-click "copy takeover script" button. Pasting that script into a fresh session tells the new agent to claim the seat with `taskboard_claim_master` and continue from the handover notes the claim result carries.

<a id="model-experience"></a>
## Model Experience

### Browser Taskboard surface

#### What the model sees

The tab is a user surface — agents interact with the board through the `taskboard_*` tools provided by `@deepseek-ai/dsh-taskboard`. The tab shows exactly the state those tools commit: cards claimed by developers, the In testing review seat, reject feedback on cards returned for rework, and the Done column. The master schedules cards into Not started after agreeing the phase scope with the user; the tab still offers drag-and-drop as a user surface, but agents other than the master never move cards. No runtime invariant companion is published because this package owns no durable event stream or mutable cross-plugin state.

#### Token effect

Zero. Viewing, refreshing, and dragging cards add no model input; only the separate host-side Taskboard tools create model-visible calls and results.

#### KV Cache effect

Independent. This browser package does not modify request prefixes or append model messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Model selectors are host/tool-only** — the browser does not yet expose the board-level worker and reviewer model or effort overrides.

<a id="model-and-effort-selectors"></a>
### Model and effort selectors (V3-5, TODO)

The board host side (V3-5) supports per-board worker/reviewer model and reasoning-effort overrides (`modelConfig` on the board record, written by the master tool `taskboard_board_config`). The browser surface does NOT expose them yet: the new-board form and a board settings path should offer model/effort dropdowns (each with a "default" option that leaves the host config in charge). This is deliberately deferred to keep the UI change small; the host contract is additive (optional fields), so wiring the form later does not require a host change. Until then the master uses `taskboard_board_config` (or the host config knobs `workerModel`/`workerEffort`/`reviewerModel`/`reviewerEffort`) to control spawned worker/reviewer models and efforts.

<a id="dev-note"></a>
### Dev Note

None.
