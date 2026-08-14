# @deepseek-ai/dsh-taskboard

English | [中文](README.zh.md)

Five-column kanban ticket board for DeepSeek Harness: a durable workflow domain
(Backlog → Not started → In progress → In testing → Done), the agent-facing
workflow tools, automatic reviewer spawning, and the browser Remote API the
`dsh-client-ui-taskboard` tab renders.

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
```

## Workflow

The user creates tickets in Backlog and drags them to Not started to signal
"start this". Agents claim tickets with `taskboard_claim` (dependency- and
capacity-gated), implement them, and finish with `taskboard_complete`. The
board then moves the card to In testing and spawns a fresh reviewer agent,
whose only authority is `taskboard_approve` / `taskboard_reject`. A reject
returns the card to In progress with concrete feedback; the developer reworks
and resubmits. Tickets persist through the storage-domain seam and every
mutation emits the forwarded `taskboard/changed` event.

## Model experience

- `taskboard_list` — board rows, optionally filtered by column or own tickets.
- `taskboard_view` — one full ticket: description, review state, feedback.
- `taskboard_claim` — take a Not started ticket (ordered, dependency-gated).
- `taskboard_complete` — hand an owned ticket to In testing with dev notes.
- `taskboard_claim_review` — take the empty review seat (auto-spawn fallback).
- `taskboard_approve` / `taskboard_reject` — the reviewer's only decisions.
- `taskboard_update` — edit an owned ticket's content.

A `taskboard:workflow` system-prompt section teaches every session the
claim-in-order, parallelize-via-subagents, never-review-your-own-ticket rules.
