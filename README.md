# DSH Taskboard：多 Agent 协作看板插件

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）开发的看板插件：一个**主控 Agent** 和用户一起把需求拆成卡片，派给**执行 Agent** 开发，交付后自动派出一个**独立审核 Agent** 验收。整个过程在浏览器里的 Taskboard 页签上实时可见。

> 由 [OyangDer](https://github.com/OyangDer) 个人开发维护，不是 DeepSeek 官方项目。包名沿用 `@deepseek-ai/` 前缀，是因为插件在 DSH 的代码库里开发，按它的命名规则发布。

## 解决什么问题

- **任务分散、进度难追踪**：多个 Agent 并行开发时，谁在做什么、做到哪一步，只能翻对话记录。
- **主控 Agent 会忘记需求**：会话一换、上下文一压缩，用户早先提过的需求就可能丢掉。
- **交付没人把关**：Agent 说"做完了"，没有独立的一方去检查。

## 工作流

```
Backlog → Not started → In progress → In testing → Done
 需求池     下一步队列      开发中         审核中       完成
```

| 角色 | 能做什么 |
| --- | --- |
| 主控 Agent | 和用户一起规划需求、派单、重派被阻塞的工作、裁决审核结果、交接席位 |
| 执行 Agent | 只做派给自己的卡片，完成后上报，失败时说明原因；不能自己领卡 |
| 审核 Agent | 只能**通过**或**打回**；打回时附具体反馈，卡片回到执行者手里返修 |

## 主要设计

- **可视化卡片**：每条和用户确认过的需求都落成一张卡片，开发进度一目了然。用户也可以直接拖动卡片排期，主控 Agent 会收到通知。
- **需求不丢失**：卡片和看板持久保存，不依赖对话上下文。主控换人时写结构化交接笔记（各卡状态、谁在做、待办摘要），接手的会话认领席位时直接拿到。
- **席位自愈**：执行或审核 Agent 卡住、失联时，看板自动派新的接手，并从原来的工作区继续、不回滚。每张卡自动重派有上限，超过就标记为阻塞并通知主控，不会无限重试。
- **按角色分配模型**：主控用强模型，执行和审核用快模型，可以按看板单独配置。
- **控制 Token 成本**：用事件通知代替轮询；限制审核 Agent 的输出长度和步数；看板列表默认只返回精简信息。

## 开发记录

2026 年 8 月至 9 月，共 104 次提交，从 V1 迭代到 V6。

- 开发历史在 [`taskboard-plugin`](https://github.com/OyangDer/Automated-Agent-Workflow/commits/taskboard-plugin) 分支。这个分支包含整个 DSH 代码库的上游历史，插件代码在 `packages/taskboard/` 和 `packages/client/ui-taskboard/` 下。
- 本分支（main）只放打包好的发布版 `0.1.5-alpha.1`。V6 新增的固定编制、开发阶段等功能还在 `taskboard-plugin` 分支上，尚未发布。

下面是英文安装说明。

---

The Taskboard plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
packaged as a standalone release: install them into **any** released `dsh` with
one command each. No DSH source tree, no workspace checkout, no pnpm workspace protocol.

| Package | Role |
| --- | --- |
| `@deepseek-ai/dsh-taskboard` | The durable five-column board domain, the agent-facing workflow tools, reviewer automation, and the browser Remote API. |
| `@deepseek-ai/dsh-client-ui-taskboard` | The **Taskboard** browser tab that renders the board. |

Both are required: the tab reads the Remote surface the host package mounts.

## Install

Ask your DSH to install the plugin, or run the command directly. All three spec
forms below install the same two packages; the tarball form is the one that
needs no registry publication and no repository access, so it is the verified
path today.

**Local tarball** (from a clone of this repository):

```sh
dsh plugin --profile web add ./releases/dsh-taskboard-0.1.5-alpha.1.tgz
dsh plugin --profile web add ./releases/dsh-client-ui-taskboard-0.1.5-alpha.1.tgz
```

**Git** — this installs straight from a checkout. pnpm accepts a `#<committish>` or a
`#path:/<subdir>` fragment but never both, and it resolves the `path:` form against
the repository's **default branch**. So this form resolves only when the branch
carrying this tree is that repository's default branch — otherwise point the
spec at a local clone whose `HEAD` carries it:

```sh
dsh plugin --profile web add "git+https://github.com/OyangDer/Automated-Agent-Workflow.git#path:/packages/dsh-taskboard"
dsh plugin --profile web add "git+https://github.com/OyangDer/Automated-Agent-Workflow.git#path:/packages/dsh-client-ui-taskboard"
```

**npm name** (works once the packages are published to the registry; they are
not published at the time of this release):

```sh
dsh plugin --profile web add @deepseek-ai/dsh-taskboard
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-taskboard
```

Restart the profile afterwards (`dsh --profile web`). `dsh plugin` appends every
installed dependency whose manifest declares `dsh.bundle` to the profile's
`dsh.profile.bundles` layer list, so both packages join the stack; the
**Taskboard** tab then mounts next to the conversation view.

## Layout

```
packages/dsh-taskboard/                `@deepseek-ai/dsh-taskboard@0.1.5-alpha.1`
packages/dsh-client-ui-taskboard/   `@deepseek-ai/dsh-client-ui-taskboard@0.1.5-alpha.1`
releases/                         deterministic tarballs for GitHub Releases
SHA256SUMS                        integrity ledger for every file below
.gitattributes                    disables checkout text conversion, so a clone matches the tarball
```

Each `packages/` directory is a complete, installable package: the built
artifacts a registry would ship are committed here, so both `dsh plugin add`
specs work without a build step on the consumer's machine.

## Provenance

Every file here is generated from the DeepSeek Harness repository by
`scripts/emit-taskboard-standalone.ts`. Do not edit this tree by hand — regenerate
it from the monorepo commit you want to ship. The emitter builds both packages
with the repository's own tooling, rewrites each manifest to real semver, packs
the tarballs, and refuses to write a tree whose manifests still carry the pnpm
workspace protocol or that vendors `node_modules` or DSH sources.
