---
description: "The durable five-column Taskboard domain, model-facing workflow tools, worker dispatch, and reviewer lifecycle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-taskboard

English | [中文](README.zh.md)

## Summary

Five-column kanban ticket board for DeepSeek Harness: a durable workflow domain (Backlog → Not started → In progress → In testing → Done), the agent-facing workflow tools, automatic reviewer spawning, and the browser Remote API the `dsh-client-ui-taskboard` tab renders.

## Table of Contents

- [Assembly](#assembly)
- [Configuration](#configuration)
- [Workflow](#workflow)
- [Master seat](#master-seat)
- [Development stages](#development-stages)
- [Seat self-healing](#seat-self-healing)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="assembly"></a>
## Assembly

The package mounts itself: the manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` and that patch inserts the `taskboard` row. Install it, plus the browser tab's package, into a profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-taskboard
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-taskboard
```

`dsh plugin` appends every installed dependency whose manifest declares `dsh.bundle` to the profile's `dsh.profile.bundles`, so the patch applies as one more layer; the `@deepseek-ai/dsh-web-app` bundle no longer mounts either row.

<a id="configuration"></a>
## Configuration

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

Effort levels use the deepseek vocabulary (`off` | `high` | `max`); an unrecognized value falls back to unset (the child model's adapter default applies). Reviewer model/effort default along the worker knobs when omitted. Per-board overrides are set by the master through `taskboard_board_config` (board-level `modelConfig` on the board record); a spawn provider that does not advertise the `effort` subagent capability gets the model only — the effort is omitted and recorded as a `model-effort-downgrade` history row instead of failing the spawn. `masterModel`/`masterEffort` are informational only: the master session's own model and effort are authoritative, and the values are written into the master system-prompt section as a suggested preset for new sessions.

<a id="workflow"></a>
## Workflow

The master plans requirements with the user — every agreed requirement becomes a Backlog card — and dispatches the phase's cards with `taskboard_assign`, which accepts a Backlog or Not started card directly (no move is ever required before dispatch). Not started is the scheduling display for the next queue: the master can move a card there with `taskboard_move` to show what is next without starting it. When the user drags a card into Not started directly, the move wakes the board's master with a "user-scheduled" notice so it adjudicates whether to dispatch the card or explain the refusal. Claiming is the master's scheduling action (V3-7): only the board's current master may claim a Not started ticket with `taskboard_claim` (dependency-gated); workers and reviewers never claim — they receive cards through `taskboard_assign` (dispatch) or `taskboard_reassign` (re-dispatch). The board then moves the card to In testing and spawns a fresh reviewer agent, whose only authority is `taskboard_approve` / `taskboard_reject`. A reject returns the card to In progress with concrete feedback; the developer reworks and resubmits. Tickets persist through the storage-domain seam and every mutation emits the forwarded `taskboard/changed` event.

<a id="master-seat"></a>
## Master seat

A board's master (claim with `taskboard_claim_master`) dispatches Backlog or Not started cards to fresh worker subagents (`taskboard_assign`, restricted to the top-level session agent), re-dispatches blocked work (`taskboard_reassign`), and adjudicates report-mode reviews (`taskboard_resolve_review`). Workers finish with `taskboard_report` (done) or `taskboard_fail` (blocked); the master's live inbox receives a lightweight notice when the user schedules a card into Not started, when a worker reports, fails, or terminates, when a worker is lost and auto-redispatched, and when a reviewer verdict lands. `taskboard_handover` writes structured handover notes (every card's status, worker identities, review seats, backlog summary and master history) onto the board and releases the seat; the successor's `taskboard_claim_master` result carries those notes.

<a id="development-stages"></a>
## Development stages (V6-4)

A development stage is one board: the cards, the Done column and every card's history belong to the stage, while the roster members (with their member history), the headcount, the master seat and the model configuration are carried forward into the new stage, so starting a stage never means rebuilding the team. `taskboard_stage_list` shows every stage with its 1-based index, its card census and whether it is the current one; `taskboard_stage_new` starts the next, EMPTY stage and archives the stage it succeeds; `taskboard_stage_switch` makes another stage current, and switching back to an ended stage re-activates it — that explicit switch back is what re-opens a stage for edits again. The legacy `default` board is recorded as stage 1 rather than renamed, so its history stays where it was.

Reads are stage-scoped: `taskboard_list` lists the current stage unless it is given an explicit `boardId`, and `taskboard_claim_master`, `taskboard_notices`, `taskboard_roster`, `taskboard_board_config` and `taskboard_create` default to the current stage the same way. A command against an ended stage is refused with `TASKBOARD_STAGE_ARCHIVED` ("switch back to that stage explicitly, or start a new stage"): dispatch, re-dispatch, pause, move, plan, create, claim, roster and model-config writes are master commands and are all refused, while a worker's own settlement (`taskboard_report`, `taskboard_fail`, `taskboard_complete`, review verdicts) stays available so a card that was in flight when its stage ended can still land. `dependsOn` must stay inside one stage: a cross-stage edge is refused unless the caller declares it explicitly with a reason (`crossStageReason`), which is recorded on the card. `taskboard_migrate` (V6-4 G/H) moves an explicit batch of cards to another stage in one operation — column (Done included), description, devNotes, review outcome, history, dependencies and worker/reviewer identity all travel with them — and refuses to leave a dependency behind or to land cards on an archived stage; its receipt names every migrated card and the target stage.

<a id="seat-self-healing"></a>
## Seat self-healing (V3-9)

The board heals stuck or lost seats automatically so cards never hang silently:

- **Worker liveness**: a startup scan plus a periodic scan (`reconcileIntervalMs`) judge every In progress/running card. A worker session absent from the live agent registry is lost immediately (restart / hard death); a registered worker that is idle with no session activity for `lostWorkerTimeoutMs` is judged stuck. A lost worker is auto-redispatched — a fresh worker continues from the preserved working tree (the card description carries a "续做勿回滚" annotation so the new worker does not roll back) — up to `workerAutoRetryLimit` times per card. Beyond the cap the card is marked blocked and the master is notified; recovery actions write card history.
- **Reviewer liveness and staleness**: an In testing card with a reviewer seat but no verdict is scanned too, judged by the *same* session-liveness rule as the master seat (V3-43). The seat is released only when the holder session is gone for good — absent from the live registry *and* holding no stored session record — because a report-mode reviewer normally lives in the session store (ready, not live) and registry absence alone is not death. A *registered* but idle reviewer with the review pending past `reviewerStaleTimeoutMs` is judged stuck and its seat is released. A fresh reviewer is auto-redispatched when a live master exists, up to `reviewerAutoRetryLimit` times per card; once that cap is spent the card is marked blocked with the concrete reason and the master is notified instead of retrying forever. Without a live master the seat stays vacant for `taskboard_claim_review`.
- Recovery is reentry-safe (one recovery per card per loss), coexists with the worker run-settlement callback (exactly one of them wins), and a notification fault never blocks the recovery.

<a id="model-experience"></a>
## Model Experience

### Taskboard prompt, tools, and results

#### What the model sees

The model receives the generated [`taskboard_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-taskboard), compact call/results, and the `taskboard:workflow` policy; a board master additionally receives `taskboard:master` guidance for claim, dispatch, adjudication, and structured handover. Workers and reviewers receive only their role-appropriate workflow instructions and never acquire authority by browser state alone.

#### Token effect

The workflow and master sections add a bounded fixed prompt cost while in scope. Each tool call appends its compact call and result; `taskboard_list` defaults to compact rows, while full ticket detail is opt-in.

#### KV Cache effect

Prompt sections and tool schemas are prefix-stable while plugin configuration and visibility remain unchanged. Ticket mutations and tool results append after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Automatic dispatch requires an available subagent provider** — when no provider can spawn the configured worker or reviewer, the durable card remains recoverable for master re-dispatch or manual review-seat claim.

<a id="dev-note"></a>
### Dev Note

The Remote wire method for deletion is `taskboard/delete`; the implementation may remain named `removeRemote`, but it must not expose `taskboard/remove` because the namespace service inherits a lifecycle method named `remove`.
