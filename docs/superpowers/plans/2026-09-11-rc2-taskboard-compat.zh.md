# DeepSeek Harness rc.2 Taskboard 兼容性实施计划

[English](2026-09-11-rc2-taskboard-compat.md) | 中文

> **致 agent 工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把正在运行的自定义 Harness 从 `dsh-v0.1.5-alpha.1` 升级到官方 `dsh-v0.1.5-rc.2`，同时保留 Taskboard、历史会话加载与既有插件行为。

**架构：** 把官方发布标签合并进一条从已知可用 Taskboard 提交创建的隔离分支。保留上游的模型与运行时改动，然后只在冲突需要人工解决处重新应用 Taskboard 专属扩展 seam 与历史来源分类放行规则。在改动线上检出之前，先在另一个端口验证隔离构建。

**技术栈：** TypeScript、pnpm 11、Vitest、Cordis 插件包、DeepSeek LLM 适配器、Git worktree。

**规格来源：** 当前任务中的用户请求：最新 Harness、DeepSeek V4.1 Flash、保留插件，以及修复历史会话。

## 全局约束

- 目标为官方发布标签 `dsh-v0.1.5-rc.2`，不移动 `master`。
- 在隔离验证通过之前，保留线上 `taskboard-plugin` 检出与 3080 端口。
- 保留 Taskboard、UI Taskboard 与 UI Subagent Board 三个包及其 bundle 注册。
- 保留安全的历史 Taskboard 消息来源迁移，且不放松对无关未知来源的准入。
- V4.1 目录必须暴露模型 id `deepseek-flash`，展示名为 `DeepSeek-V41-Flash`。
- 不得打印或提交 API key 与用户会话日志。

---

### 任务 1：建立隔离基线

**文件：**
- 修改：无
- 测试：既有的 Taskboard、DeepSeek 适配器、会话迁移与 CLI 定向测试

**接口：**
- 消费：`upgrade/rc2-taskboard` 分支上的 `3a78161ab8`
- 产出：在隔离 worktree 中记录的基线测试结果与已安装依赖

- [ ] **步骤 1：安装 lockfile 锁定的工作区依赖**

运行：`pnpm install --frozen-lockfile`

- [ ] **步骤 2：运行当前定向兼容性测试集**

运行：`pnpm exec vitest run packages/taskboard/taskboard/tests packages/client/ui-taskboard/tests packages/client/ui-subagent-board/tests packages/llm/llm-deepseek/tests/dynamic-config.spec.ts packages/llm/llm-deepseek/tests/serialize.spec.ts packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts apps/cli/tests/minimal-preset-win32.spec.ts`

- [ ] **步骤 3：在不修改生产代码的前提下记录失败**

预期：如出现失败，在 rc.2 合并前将其归类为既有基线失败。

### 任务 2：合并官方 rc.2 发布

**文件：**
- 修改：`git merge dsh-v0.1.5-rc.2` 报告的冲突文件
- 测试：Git 冲突清单与发布祖先关系

**接口：**
- 消费：干净的隔离基线
- 产出：包含 rc.2 与全部 Taskboard 提交的合并 worktree

- [ ] **步骤 1：合并但不提交**

运行：`git merge --no-commit --no-ff dsh-v0.1.5-rc.2`

- [ ] **步骤 2：清点每一个未解决的路径**

运行：`git diff --name-only --diff-filter=U`

- [ ] **步骤 3：通过仓库生成器解决生成文档的冲突**

运行：`pnpm run resolve-translation-pairing-conflicts`，随后对相应生成目录运行相关的 `gen-*` 命令。

- [ ] **步骤 4：按归属解决源码冲突**

DeepSeek 适配器与基础运行时保留上游 rc.2。在 bundle manifest、API remote、Cordis 工具注册、TypeScript 项目引用与工作区 lockfile 条目中保留 Taskboard 的新增内容。

### 任务 3：证明 V4.1 Flash 与历史会话兼容性

**文件：**
- 仅在合并后的上游测试尚未断言 V4.1 时，修改 `packages/llm/llm-deepseek/tests/dynamic-config.spec.ts`
- 修改：`packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts`
- 仅在失败的回归测试要求时，修改 `packages/session/session-format-v2-to-v3/src/payload.ts`
- 测试：上述两个文件

**接口：**
- 消费：合并后的 rc.2 DeepSeek 目录与 Taskboard 迁移规则
- 产出：`deepseek-flash` 与历史 Taskboard 记录的回归覆盖

- [ ] **步骤 1：运行上游 V4.1 目录测试并确认其通过**

运行：`pnpm exec vitest run packages/llm/llm-deepseek/tests/dynamic-config.spec.ts`

预期：适配器的默认项包含 `{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }`。

- [ ] **步骤 2：运行历史 Taskboard 来源回归测试**

运行：`pnpm exec vitest run packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts`

预期：已批准的 Taskboard 消息来源完成迁移，而无关的未分类来源仍被拒绝。

- [ ] **步骤 3：若会话测试失败，先新增或保留最小失败 fixture**

该 fixture 必须使用提交 `3a78161ab8` 已覆盖的那一种历史 Taskboard 来源形状；在修改 `payload.ts` 之前先验证 RED。

- [ ] **步骤 4：应用最小的来源分类修复并验证 GREEN**

反复运行步骤 1 与步骤 2 中的两个测试，直到二者同时通过。

### 任务 4：证明插件命名空间与 Taskboard 行为

**文件：**
- 仅在定向测试证明存在回归时，修改已完成冲突解决的 Taskboard/API/bundle 文件
- 测试：`packages/taskboard/taskboard/tests`、`packages/client/ui-taskboard/tests`、`packages/client/ui-subagent-board/tests`

**接口：**
- 消费：合并后的 Cordis API 命名空间与 Taskboard 服务
- 产出：插件加载时不再出现原先的 `taskboard/remove` 命名空间冲突

- [ ] **步骤 1：运行 Taskboard 宿主测试**

运行：`pnpm exec vitest run packages/taskboard/taskboard/tests`

- [ ] **步骤 2：运行两个 Taskboard 客户端测试集**

运行：`pnpm exec vitest run packages/client/ui-taskboard/tests packages/client/ui-subagent-board/tests`

- [ ] **步骤 3：构建宿主与客户端包**

运行：`pnpm run build:lib`

- [ ] **步骤 4：校验生成的 Cordis 与工具目录**

运行：`pnpm run verify-cordis-catalog && pnpm run verify-cordis-api && pnpm run verify-tool-catalog && pnpm run verify-tsconfig-paths`

### 任务 5：隔离运行时冒烟测试与交接

**文件：**
- 修改：无，除非冒烟测试暴露出可由新增失败测试覆盖的可复现回归
- 测试：3081 端口上的隔离 web 服务器

**接口：**
- 消费：已构建的 rc.2 兼容分支
- 产出：在线上切换之前 V4.1 与全部插件均可加载的证据

- [ ] **步骤 1：在不停止 3080 端口的情况下启动隔离 web 服务器**

运行：`node apps/cli/lib/bin.js web --no-open --host 127.0.0.1 --port 3081`

- [ ] **步骤 2：检查启动输出中的插件 loader 错误**

预期：没有 `taskboard/remove` 命名空间冲突，也没有失败的插件 loader 条目。

- [ ] **步骤 3：校验生效的模型目录**

预期：模型设置页面在保留的 V4 条目之外包含 `DeepSeek-V41-Flash`（`deepseek-flash`）。

- [ ] **步骤 4：仅在全部门禁通过后提交 rc.2 兼容合并**

运行：`git add -A && git commit`

- [ ] **步骤 5：仅在报告验证证据之后替换线上分支／进程**

面向用户的切换完成之前，现有的 3080 端口进程仍是回滚点。
