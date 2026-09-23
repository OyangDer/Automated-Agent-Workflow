# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with a real
Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and
the deliberate composition divergences from `dsh web` — are documented in
[`scaffold.ts`](scaffold.ts) and the
[browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. See the [CI fixture synchronization decision](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.md).

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate,
because they read Host services directly: `ctx.connection`, the Host
`SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does
not make a file part of the Client program — the two faces merge cordis
`Context` under the same keys with different services, so one program cannot see
both. Moving these files into the Client aggregate makes every Host-service
access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript
project, and every project it references, into the **Host build graph**. That has
bitten this lane once already: four Client consumer packages reference
`api/remotes`' Client face, which cannot compile until Host tsdown has generated
`@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an
artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here
instead, next to the commented-out import that names the source module. A drift
then surfaces as a missed selector or a stale mirrored value — a loud failure,
never a silent pass. `scaffold.ts` follows this rule for the welcome-notice
namespace, acknowledgement field, version, and asserted Chinese copy.

One kind of Client import stands. `assembled-boot.ts` drives the shell itself, so
it imports `AppWebEntry` from `@deepseek-ai/dsh-client-web` and the boot-manifest
type from `@deepseek-ai/dsh-client-modules/client`: booting the real shell is what
that harness is for, and both packages are already in the Host graph. The chat
scenarios mirror `conversationContextKey` in `support.ts` instead of importing
its Client owner.

## Taskboard UI acceptance

A card whose deliverable is a clickable Taskboard surface must attach the real run of

```sh
pnpm exec tsx scripts/taskboard-ui-acceptance.ts
```

to its report. That command never builds: run `pnpm run build` first (`pnpm run test:web`
builds and then runs the whole lane). It boots the assembled composition over the two
shipped Taskboard plugin layers and drives [`taskboard-roster.e2e.ts`](taskboard-roster.e2e.ts)
in a real Chromium, printing the evidence the report quotes: the on-screen headcount and
the Host-side capacity/roster around one click.

It checks two prerequisites before spending a browser boot, because both fail late and
confusingly:

- the root `pnpm exec playwright install chromium` resolves Playwright **1.58** and
  installs chromium **1208**, while `apps/web` resolves **1.61.1** and launches chromium
  **1228** — install the lane's browser with
  `cd apps/web && node node_modules/playwright/cli.js install chromium`;
- `apps/web/dist` is the built shell the scaffold serves, and `support.ts` refuses
  without it.

Reuse it for another Taskboard UI card in three steps:

1. copy `taskboard-roster.e2e.ts` and `taskboard-roster.overlay.yml` beside it, and keep
   the layer-equivalence test so the smoke cannot drift from the shipped plugin layers;
2. keep the dual-evidence shape — click one control, await the visible change, then
   assert the same change on the Host service (`scaffold.ctx.taskboard`) — and keep
   `watchConsole`'s page-error assertion, which is what catches a stale assembled client
   bundle;
3. run `pnpm exec tsx scripts/taskboard-ui-acceptance.ts --file <your file>` and quote its
   evidence line in the card report.


Nothing mechanically enforces this rule; keep it in review.
