# @deepseek-ai/dsh-taskboard

English | [中文](README.zh.md)

Five-column kanban ticket board for DeepSeek Harness: a durable workflow domain (Backlog → Not started → In progress → In testing → Done), the agent-facing workflow tools, automatic reviewer spawning, and the browser Remote API the `dsh-client-ui-taskboard` tab renders.

## Assembly

The web profile mounts the service and the board tab:

```yaml
- id: taskboard
  name: '@deepseek-ai/dsh-taskboard'

- id: ui-taskboard
  name: '@deepseek-ai/dsh-client-ui-taskboard'
```

## Configuration

```yaml
taskboard:
  maxInProgress: 4    # parallel developer cap; claims beyond it are rejected
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
  reviewerStaleTimeoutMs: 900000  # In testing seat without a verdict this long is released (15 min)
```

Effort levels use the deepseek vocabulary (`off` | `high` | `max`); an unrecognized value falls back to unset (the child model's adapter default applies). Reviewer model/effort default along the worker knobs when omitted. Per-board overrides are set by the master through `taskboard_board_config` (board-level `modelConfig` on the board record); a spawn provider that does not advertise the `effort` subagent capability gets the model only — the effort is omitted and recorded as a `model-effort-downgrade` history row instead of failing the spawn. `masterModel`/`masterEffort` are informational only: the master session's own model and effort are authoritative, and the values are written into the master system-prompt section as a suggested preset for new sessions.

## Workflow

The master plans requirements with the user — every agreed requirement becomes a Backlog card — and dispatches the phase's cards with `taskboard_assign`, which accepts a Backlog or Not started card directly (no move is ever required before dispatch). Not started is the scheduling display for the next queue: the master can move a card there with `taskboard_move` to show what is next without starting it. When the user drags a card into Not started directly, the move wakes the board's master with a "user-scheduled" notice so it adjudicates whether to dispatch the card or explain the refusal. Claiming is the master's scheduling action (V3-7): only the board's current master may claim a Not started ticket with `taskboard_claim` (dependency- and capacity-gated); workers and reviewers never claim — they receive cards through `taskboard_assign` (dispatch) or `taskboard_reassign` (re-dispatch). The board then moves the card to In testing and spawns a fresh reviewer agent, whose only authority is `taskboard_approve` / `taskboard_reject`. A reject returns the card to In progress with concrete feedback; the developer reworks and resubmits. Tickets persist through the storage-domain seam and every mutation emits the forwarded `taskboard/changed` event.

## Master seat

A board's master (claim with `taskboard_claim_master`) dispatches Backlog or Not started cards to fresh worker subagents (`taskboard_assign`, restricted to the top-level session agent), re-dispatches blocked work (`taskboard_reassign`), and adjudicates report-mode reviews (`taskboard_resolve_review`). Workers finish with `taskboard_report` (done) or `taskboard_fail` (blocked); the master's live inbox receives a lightweight notice when the user schedules a card into Not started, when a worker reports, fails, or terminates, when a worker is lost and auto-redispatched, and when a reviewer verdict lands. `taskboard_handover` writes structured handover notes (every card's status, worker identities, review seats, backlog summary and master history) onto the board and releases the seat; the successor's `taskboard_claim_master` result carries those notes.

## Seat self-healing (V3-9)

The board heals stuck or lost seats automatically so cards never hang silently:

- **Worker liveness**: a startup scan plus a periodic scan (`reconcileIntervalMs`) judge every In progress/running card. A worker session absent from the live agent registry is lost immediately (restart / hard death); a registered worker that is idle with no session activity for `lostWorkerTimeoutMs` is judged stuck. A lost worker is auto-redispatched — a fresh worker continues from the preserved working tree (the card description carries a "续做勿回滚" annotation so the new worker does not roll back) — up to `workerAutoRetryLimit` times per card. Beyond the cap the card is marked blocked and the master is notified; recovery actions write card history.
- **Reviewer staleness**: an In testing card with a reviewer seat but no verdict is scanned too. A reviewer session absent from the registry is a ghost seat and is released immediately; a registered but idle reviewer with the review pending past `reviewerStaleTimeoutMs` is judged stuck and its seat is released. A fresh reviewer is auto-redispatched when a live master exists; otherwise the seat stays vacant for `taskboard_claim_review`.
- Recovery is reentry-safe (one recovery per card per loss), coexists with the worker run-settlement callback (exactly one of them wins), and a notification fault never blocks the recovery.

## Model experience

- `taskboard_list` — board rows, optionally filtered by column or own tickets.
- `taskboard_view` — one full ticket: description, review state, feedback.
- `taskboard_claim` — the master claims a Not started ticket (ordered, dependency-gated; master only).
- `taskboard_complete` — hand an owned ticket to In testing with dev notes.
- `taskboard_claim_review` — take the empty review seat (auto-spawn fallback).
- `taskboard_approve` / `taskboard_reject` — the reviewer's only decisions.
- `taskboard_update` — edit an owned ticket's content.
- `taskboard_claim_master` / `taskboard_release_master` — take or release the master seat; the claim result carries the previous master's handover notes.
- `taskboard_handover` — write structured handover notes and release the master seat.
- `taskboard_assign` / `taskboard_reassign` — dispatch a fresh worker (top-level session only) or re-dispatch blocked work.
- `taskboard_board_config` — read/set the board's worker/reviewer model+effort overrides (master only).
- `taskboard_report` / `taskboard_fail` — the worker's only finishing verbs.
- `taskboard_resolve_review` — apply the reviewer-reported verdict.

A `taskboard:workflow` system-prompt section teaches every session the master-only claim rule (workers/reviewers receive cards via `taskboard_assign` / `taskboard_reassign`), dispatch-based parallelization, and never-review-your-own-ticket rules. A `taskboard:master` section teaches the master seat: claim, dispatch, adjudicate, and hand over with structured notes.
