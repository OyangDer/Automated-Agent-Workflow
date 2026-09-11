# DeepSeek Harness rc.2 Taskboard Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the running customized Harness from `dsh-v0.1.5-alpha.1` to official `dsh-v0.1.5-rc.2` while preserving Taskboard, legacy-session loading, and existing plugin behavior.

**Architecture:** Merge the official release tag into an isolated branch created from the known-working Taskboard commit. Keep upstream model and runtime changes, then reapply only the Taskboard-specific extension seams and the legacy source-classification allowance where conflicts require manual resolution. Validate the isolated build on a different port before changing the live checkout.

**Tech Stack:** TypeScript, pnpm 11, Vitest, Cordis plugin bundles, DeepSeek LLM adapter, Git worktrees.

**Spec:** User request in the current task: latest Harness, DeepSeek V4.1 Flash, preserved plugins, and repaired historical conversations.

## Global Constraints

- Target the official release tag `dsh-v0.1.5-rc.2`, not moving `master`.
- Preserve the live `taskboard-plugin` checkout and port 3080 until isolated verification passes.
- Preserve the Taskboard, UI Taskboard, and UI Subagent Board packages and their bundle registrations.
- Preserve the safe legacy Taskboard message-source migration without weakening admission for unrelated unknown sources.
- The V4.1 catalog must expose model id `deepseek-flash` with display name `DeepSeek-V41-Flash`.
- No API keys or user session logs may be printed or committed.

---

### Task 1: Establish the isolated baseline

**Files:**
- Modify: none
- Test: existing targeted Taskboard, DeepSeek adapter, session migration, and CLI tests

**Interfaces:**
- Consumes: branch `upgrade/rc2-taskboard` at `3a78161ab8`
- Produces: recorded baseline test results and installed dependencies in the isolated worktree

- [ ] **Step 1: Install the lockfile-pinned workspace dependencies**

Run: `pnpm install --frozen-lockfile`

- [ ] **Step 2: Run the current targeted compatibility suite**

Run: `pnpm exec vitest run packages/taskboard/taskboard/tests packages/client/ui-taskboard/tests packages/client/ui-subagent-board/tests packages/llm/llm-deepseek/tests/dynamic-config.spec.ts packages/llm/llm-deepseek/tests/serialize.spec.ts packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts apps/cli/tests/minimal-preset-win32.spec.ts`

- [ ] **Step 3: Record failures without modifying production code**

Expected: failures, if any, are classified as pre-existing baseline failures before the rc.2 merge.

### Task 2: Merge the official rc.2 release

**Files:**
- Modify: files reported by `git merge dsh-v0.1.5-rc.2`
- Test: Git conflict inventory and release ancestry

**Interfaces:**
- Consumes: clean isolated baseline
- Produces: a merge worktree containing rc.2 plus all Taskboard commits

- [ ] **Step 1: Merge without committing**

Run: `git merge --no-commit --no-ff dsh-v0.1.5-rc.2`

- [ ] **Step 2: Inventory every unresolved path**

Run: `git diff --name-only --diff-filter=U`

- [ ] **Step 3: Resolve generated documentation through repository generators**

Run: `pnpm run resolve-translation-pairing-conflicts`, followed by the relevant `gen-*` commands for generated catalogs.

- [ ] **Step 4: Resolve source conflicts by ownership**

Keep upstream rc.2 for the DeepSeek adapter and base runtime. Preserve Taskboard additions in bundle manifests, API remotes, Cordis tool registration, TypeScript project references, and workspace lockfile entries.

### Task 3: Prove V4.1 Flash and legacy-session compatibility

**Files:**
- Modify: `packages/llm/llm-deepseek/tests/dynamic-config.spec.ts` only if the merged upstream test does not already assert V4.1
- Modify: `packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts`
- Modify: `packages/session/session-format-v2-to-v3/src/payload.ts` only if required by the failing regression test
- Test: the two files above

**Interfaces:**
- Consumes: merged rc.2 DeepSeek catalog and Taskboard migration rule
- Produces: regression coverage for `deepseek-flash` and historical Taskboard records

- [ ] **Step 1: Run the upstream V4.1 catalog test and confirm it passes**

Run: `pnpm exec vitest run packages/llm/llm-deepseek/tests/dynamic-config.spec.ts`

Expected: the adapter defaults include `{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }`.

- [ ] **Step 2: Run the historical Taskboard source regression test**

Run: `pnpm exec vitest run packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts`

Expected: approved Taskboard message sources migrate while an unrelated unclassified source remains rejected.

- [ ] **Step 3: If the session test fails, first add or retain the minimal failing fixture**

The fixture must use the exact legacy Taskboard source shape already covered by commit `3a78161ab8`; verify RED before changing `payload.ts`.

- [ ] **Step 4: Apply the smallest source-classification fix and verify GREEN**

Run both tests from Steps 1 and 2 until they pass together.

### Task 4: Prove plugin namespace and Taskboard behavior

**Files:**
- Modify: conflict-resolved Taskboard/API/bundle files only when a targeted test demonstrates a regression
- Test: `packages/taskboard/taskboard/tests`, `packages/client/ui-taskboard/tests`, `packages/client/ui-subagent-board/tests`

**Interfaces:**
- Consumes: merged Cordis API namespaces and Taskboard services
- Produces: plugin loading without the former `taskboard/remove` namespace conflict

- [ ] **Step 1: Run the Taskboard host tests**

Run: `pnpm exec vitest run packages/taskboard/taskboard/tests`

- [ ] **Step 2: Run the two Taskboard client suites**

Run: `pnpm exec vitest run packages/client/ui-taskboard/tests packages/client/ui-subagent-board/tests`

- [ ] **Step 3: Build host and client packages**

Run: `pnpm run build:lib`

- [ ] **Step 4: Verify generated Cordis and tool catalogs**

Run: `pnpm run verify-cordis-catalog && pnpm run verify-cordis-api && pnpm run verify-tool-catalog && pnpm run verify-tsconfig-paths`

### Task 5: Isolated runtime smoke test and handover

**Files:**
- Modify: none unless the smoke test exposes a reproducible regression covered by a new failing test
- Test: isolated web server on port 3081

**Interfaces:**
- Consumes: built rc.2 compatibility branch
- Produces: evidence that V4.1 and all plugins load before live cutover

- [ ] **Step 1: Start the isolated web server without stopping port 3080**

Run: `node apps/cli/lib/bin.js web --no-open --host 127.0.0.1 --port 3081`

- [ ] **Step 2: Inspect startup output for plugin loader errors**

Expected: no `taskboard/remove` namespace conflict and no failed plugin loader entries.

- [ ] **Step 3: Verify the effective model catalog**

Expected: the Models settings page includes `DeepSeek-V41-Flash` (`deepseek-flash`) alongside retained V4 entries.

- [ ] **Step 4: Commit the rc.2 compatibility merge only after all gates pass**

Run: `git add -A && git commit`

- [ ] **Step 5: Replace the live branch/process only after reporting the verification evidence**

The existing port 3080 process remains the rollback point until the user-facing cutover is complete.
