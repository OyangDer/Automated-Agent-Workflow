# V3-3 spike：全自动继任主 Agent 孵化器调研报告

> 工单：ticket-7c3f3e4d-e7ec-45e1-bc69-d5dde250bab3（V3-3 [spike] 全自动继任主Agent孵化器调研）
> 日期：2026-08-15 ｜ 性质：技术结论报告 + 实现清单（不写产品代码）
> 代码基线：C:\Users\O'yan'd'D'er\deepseek-harness（分支 taskboard-plugin，含 V3-1/V3-2）

## 结论

**可行（feasible），工作量中等，无架构性障碍。**

调研确认：把「会话创建 → agent preset 组合 → Inbox 注入 → agent loop」抽成一个可复用的
host 服务（根会话孵化器）没有理论或机制障碍——仓库里已存在四个"程序化创建根会话并驱动"
的先例（headless、SDK server、ACP、以及 apiproxy fork 路径），子代理机制本身就是
"在运行中的 agent 内创建新会话 + 注入 prompt + 驱动到 quiescence"的成熟实现。
缺口只在三点：(1) 这些逻辑散落在各自入口，没有打包成插件可调的 host 服务；
(2) taskboard 服务当前只以 cast 方式触碰 agents 注册表（notifyMaster），没有创建会话所需的
注入面；(3) handover 只写笔记、释放席位，不负责唤起继任者。

关键设计红线（详见"安全边界"）：继任会话的生命周期必须挂在 **host 自持上下文**（selfCtx 模式）
上，不能挂在调用方（master）的 fiber 上——否则 master 会话一结束继任者就被回收，
"自动继任"就失去了意义。子代理机制刻意让子会话随父会话回收，不能直接复用其调用方式。

## 一、现状调研：会话创建全链路（createSession → preset 组合 → Inbox 注入 → agent loop）

### 1.1 用户路径（唯一面向用户的根会话创建入口）

Web UI → `session.create` RPC → apiproxy：

1. **RPC 契约**：`packages/host/apiproxy/src/api/sessions.ts:261`
   `create({ workspaceId?, cwd?, sessionId?, agentPreset? })`。
2. **handler**：`packages/host/apiproxy/src/api-proxy.ts:2168` —— 解析 workspace/cwd，
   调 `ensureSession(sessionId, cwd, checkPersistedIdentity, requestedPreset)`，
   成功后 `workspace.attachSession(sessionId)`，回显会话实际运行的 preset。
3. **ensureSession**（`api-proxy.ts:1619`）：
   - 已有 live agent → 直接复用（同 id 去重：`sessionCreations` Map，`api-proxy.ts:1128`）；
   - 持久化命中 → `ctx.agents.resume({ resumeSessionId, agentOptions, setup } )`
     （`api-proxy.ts:1658`），preset 从**日志**解析（不是 header），保证切换过 preset 的
     blank 会话按实际运行组合恢复；
   - 全新 → `mkdir(cwd)` → `composeAgent(presetId)` → `ctx.agents.create({ sessionId,
     agentOptions, meta: { cwd, agentPreset }, setup })`（`api-proxy.ts:1670-1679`）。
4. **composeAgent**（`api-proxy.ts:1228`）：`ctx.get('agentPresets')`
   - 无 roster → setup 只装 model selection；
   - 有 roster → `presets.resolve(presetId ?? default)`，setup 里
     `installSelection(agentCtx)` + `presets.mount(agentCtx, resolvedId)`；
     解析出的 id 写入会话 header（`agentPreset`），持久化后 resume 用同一组合重建 agent。
   - 错误映射：未知 preset → `agent-preset-not-found`，组合不可挂载 → `agent-preset-invalid`
     （`presetFailure`，`api-proxy.ts:396`）。
5. **agents.create**（`packages/core/agent/src/index.ts:405`）→ AgentRegistry 委托给
   agent-loop 工厂（`setFactory`，`index.ts:372`）→
   `createAgent`（`packages/core/agent-loop/src/index.ts:606`）→
   `SessionPreparation.create(sessions.prepare(id, { meta }))`（`index.ts:607`）→
   `setupAndPublish`（`index.ts:625`）：构造 `ReactLoopAgent`、跑 setup（挂 preset）、
   publish（`enter` + `announce` + `agent/session-start`，`index.ts:553-570`）。
6. **Session 铸造**：`packages/core/session/src/index.ts:863` `sessions.prepare`，
   header 字段（`index.ts:877-887`）：`cwd / parentSession / seedLength / origin /
   delegationDepth / agentPreset`。**根会话** = 三者皆无（`parentSession`、`origin:`
   'subagent'`、`delegationDepth`）——taskboard 的 `assertRootSession`
   （`service.ts:1383`）正是按此判定。

### 1.2 preset 组合 seam（可复用，已在 host 层）

`packages/preset/agent-presets/src/index.ts`：
- `resolve(id?)`（:213）—— 按 id 或默认（`defaultId`，:191，读 settings 热重载）解析；
- `mount(agentCtx, id?)`（:275）—— 在 agent 创建窗口内挂载（失败回滚整个创建）；
- `composedPreset(agentCtx)`（:336）—— 读 agent 实际所在组合；
- `serviceFor(agent, name)`（:433）—— 按 agent 解析其 preset 内的服务；
- **selfCtx 模式**（:128-132）：服务自持未追踪的原始 ctx，避免被调用方 shadow 重绑——这是
  孵化器必须复用的关键模式。

### 1.3 Inbox 注入与 agent loop

`packages/core/agent-loop/src/agent.ts`：
- `send(message, target, wakeup)`（:113）→ `inbox.splice` + `wakeDriver`；
- `followup`（:122）= next-turn + wake（开新回合）；`steer`（:126）= next-step + wake；
  `inject`（:130）= next-step 不 wake；
- `kick → turn → preStep → step`（:210-401）：**注入后 loop 自动跑**，无需外部驱动；
  turn/step 事件全部落盘（`turn/start`、`step/start`、`user/message`、`assistant/chunk`…）。
- prompt 路径：`session.prompt` handler（`api-proxy.ts:2462`）→ `agent.steer/followup`
  （`api-proxy.ts:2499-2500`）。

### 1.4 程序化创建根会话的既有先例（可行性证据）

| 先例 | 位置 | 模式 |
|---|---|---|
| headless 一键驱动 | `packages/bundle/headless/src/index.ts:111-126` | `agents.create({ sessionId, meta:{cwd}, agentOptions })` + `agent.followup` + `whenIdle` |
| SDK server | `packages/sdk/server/src/server.ts:218-235`（驱动 :141） | 同上（无 preset，刻意） |
| ACP bridge | `packages/acp/acp/src/index.ts:251-275`（驱动 :307） | `newSession` 同上 |
| apiproxy fork | `api-proxy.ts:2416-2437` | create + `seed` + `parentSession` 谱系（fork 是有谱系的根会话） |
| 子代理（in-process） | `packages/subagent/subagent-in-process-driver/src/index.ts:132-178` | `parent.ctx.agents.create({ sessionId, meta: childSessionMeta(...), setup, signal })` + `child.followup` + `whenIdle` |
| goal 轮驱动 | `packages/goal/goal-round-driver/src/index.ts:192`（:215 `withoutInitiator`） | 宿主侧 `agent.followup` 注入轮次 prompt |
| 定时任务 | `packages/schedule/schedule/src/runtime.ts:110,275` | `withoutInitiator` + `followup` |
| taskboard 已有注入 | `packages/taskboard/taskboard/src/service.ts:1442-1462` | `notifyMaster`：`master.followup(createUserMessage({ source: { kind: 'taskboard', boardId } }))`（消息源 augmentation 在 `domain.ts:106-112`） |

结论：**「创建根会话 + 注入首条 prompt + 自动驱动」的每一步都有生产代码先例**，
且 taskboard 自己已经在做 Inbox 注入（notifyMaster）。

## 二、缺口分析（为什么现在还做不了）

1. **没有打包的 host 服务**：preset 组合（composeAgent）在 apiproxy 内部；SDK/ACP/headless
   各自手写"创建+驱动"。插件（taskboard）没有统一的
   `incubateRootSession(...)` 入口。
2. **taskboard 未注入创建依赖**：`TaskboardService` 的
   `static inject = ['storageDomain', 'systemPrompt', 'tools']`（`service.ts:315`），
   只在 `notifyMaster` 里以 cast 方式摸 `ctx.agents`（`service.ts:1449`）；
   没有 `agents / agentPresets / agentDefaultModel / workspaceRegistry` 的正式依赖。
3. **handover 不唤起继任者**：`handover(boardId, agent)`（`service.ts:1404-1430`）
   只生成笔记（`buildHandoverNotes`，`domain.ts:298-339`）→ 写 `handoverNotes` →
   释放席位。继任者今天靠 V3-2 的"复制接管指令，用户粘到新会话"半自动完成。
4. **生命周期归属未定义**：从 agent 工具调用内创建会话时，`AgentRegistry.create`
   的 `ownerCtx = this.ctx`（`core/agent/src/index.ts:406`）会被 Cordis 追踪代理重绑为
   调用方上下文；agent-loop 在 `prepare` 里 `unfollowOwner = ownerCtx.effect(() => () =>
   dispose(true))`（`core/agent-loop/src/index.ts:524-530`）——**继任者若挂在 master
   fiber 上，master 会话一结束就被回收**。子代理刻意利用这一点（子随父亡），
   但继任者必须相反（父亡子存）。

## 三、方案设计：根会话孵化器（root session incubator）

### 3.1 新 seam 服务（建议包名 `@deepseek-ai/dsh-session-incubator`，宿主侧单包）

`ctx.sessionIncubator.incubateRootSession(request)`：

```ts
interface IncubateRootSessionRequest {
  /** 目标工作目录；缺省取 host cwd（apiproxy defaults.cwd 等价物）。 */
  cwd?: string
  /** 组合的 preset id；缺省取调用方记录的 preset 或 roster 默认。 */
  presetId?: string
  /** 继任者模型选择；缺省取 ctx.agentDefaultModel.currentSelection()。 */
  agentOptions?: AgentOptions
  /** 首条注入消息（如交接话术）。 */
  firstPrompt: ContentBlock[]
  /** 消息源（如 { kind: 'taskboard', boardId }）。 */
  source: MessageSource
  /** 可选：创建后要附加的 workspaceId（板所属项目）。 */
  workspaceId?: WorkspaceId
  /** 可选：外部取消信号。 */
  signal?: AbortSignal
}
```

实现要点（照抄仓库既有模式的组合）：
1. **selfCtx**：构造时 `const selfCtx = ctx`（agentPresets :132、jobs-local :127 先例），
   创建动作全部走 `selfCtx.agents.create(...)`，保证继任者生命周期挂 host 根 fiber；
2. **withoutInitiator**：`selfCtx.agents.withoutInitiator(() => create(...))`
   （goal-round-driver :215、schedule :110 先例），避免进程内因果归因错误；
3. **preset 组合**：`selfCtx.get('agentPresets')`（可选依赖）→ `resolve(presetId)` →
   setup 里 `presets.mount(agentCtx, resolvedId)` + `installModelSelection`；
   无 roster 时退化为纯 host 组合（headless/SDK 先例）；未知/不可挂载 → 明确拒绝
   （复用 `resolveMountable` 语义）；
4. **模型分层**：`agentOptions` 由调用方固定（taskboard config 注入），
   **绝不从 prompt 文本推导**；缺省 `selfCtx.agentDefaultModel.currentSelection()`
   （`core/agent-default-model/src/index.ts:88`）；
5. **workspace 附加**：`workspaceRegistry.get(workspaceId)` →
   `workspace.attachSession(sessionId)`（失败不回收已发布的会话，照 apiproxy
   `workspace-attach-failed` 语义返回错误）；
6. **Inbox 注入**：`agent.followup(createUserMessage({ content: firstPrompt, source }))`；
7. **返回**：`{ sessionId, agentPreset? }` + 失败原因枚举（unavailable/failed/refused），
   调用方决定是否回滚/降级。

### 3.2 taskboard 接入点

1. **Config 增**（`service.ts:153-179` 现有 Config 扩展）：
```ts
successor?: {
  enabled: boolean            // 默认 false（显式开启才自动继任）
  provider?: string           // 缺省 ctx.agentDefaultModel.currentSelection().provider
  model?: string              // 缺省同上 model（或 masterModel 配置）
  presetId?: string           // 缺省 = master 实际组合（composedPreset）或 roster 默认
  maxSuccessions?: number     // 默认 1；0 = 关闭
}
```
2. **`handover()` 扩展**（`service.ts:1404`）：释放席位后，若
   `successor.enabled && board.scope !== 'session' && board.successorCount < maxSuccessions`
   → 调 `ctx.sessionIncubator.incubateRootSession(...)`，prompt = 接管话术
   （`buildSuccessorPrompt(notes)`：先 `taskboard_claim_master` 拿笔记 → 读板续派），
   workspace = `board.workspaceId`，source = `{ kind: 'taskboard', boardId }`；
   成功则 `successorCount++`（同一次存储域变更链内原子提交）。
3. **boards 表增字段**：`successorCount: number default 0`（`boardSchema`，`service.ts:97-114`）。
4. **失败降级**：孵化失败（无 agents/无 presets/模型不可路由/workspace attach 失败）时
   handover **仍然成功**（笔记已写、席位已释放），结果里带
   `successor: { spawned: false, reason }`——降级路径 = V3-2 半自动接管，零回退成本。
5. **权限门禁不变**：`handover` 仍要求当前 master + 根会话（`assertRootSession`）；
   继任者没有任何父对话上下文，唯一权威来自板（claim 席位），与 V3-2 手动接管等价。

### 3.3 安全边界（深度 / 权限 / 模型分层）

| 维度 | 边界 | 依据/实现 |
|---|---|---|
| 深度 | 继任链**有界**：板级 `successorCount` 单调递增、受 `maxSuccessions` 封顶；越界拒绝孵化（返回 refused）。继任者是根会话（header 无 delegationDepth），深度防护在板字段而非 header——与子代理的 header 深度（`child-agent.ts:48-57`）互补，互不混淆 | `boardSchema.successorCount` + handover 原子变更 |
| 权限 | (1) **session 私有板禁止自动继任**：新会话看不到 ownerSessionId 不同的私有板（`isBoardVisible` `service.ts:585-597`），自动继任只对 project 共享板（或无主 legacy 板）生效；(2) 继任者继承**板的 workspace**（attachSession），不继承 master 的任何工具/技能/权限覆盖；(3) 不复制 delegation 策略（`captureDelegatedPolicyOverrides` 只用于子代理）——继任者是全新根会话，走用户自己的 sandbox/approval 策略；(4) 工具侧门禁原样：master 动词仍要求根会话 + 持有席位 | `service.ts:585,609`、`child-agent.ts:199-225` |
| 模型分层 | 继任者模型**由配置钉死**（taskboard `successor.provider/model` → 缺省 deployment 默认），交接文本无权改模型；preset 在创建时固定（会话 preset 创建后不可变，`assertPresetUnchanged` `api-proxy.ts:1203`），继任者组合 = master 实际组合或 roster 默认 | Config 注入 + `agentDefaultModel`；`api-proxy.ts:994-1043` |
| 生命周期 | 继任者挂 **host 根 fiber**（selfCtx），master 会话关闭/清理不影响继任者；孵化失败不产生半成品（agents.create setup 失败整体回滚，`core/agent-loop/src/index.ts:638-644`） | selfCtx + withoutInitiator |
| 用户可见性 | 继任者是 session.list 里的新根会话（空白→运行），需在首条消息/标题里自明身份（"继任主 Agent，板 xxx"），避免用户困惑 | `session.list` 语义（`api-proxy.ts:1726`） |

## 四、实现清单（V3-4 落地用，按依赖排序）

1. **新 seam 包** `packages/session-incubator/`（宿主侧，照 tool-todo/goal 的服务模式）：
   - `src/index.ts`：`SessionIncubator extends Service`，
     `static inject = ['agentDefaultModel', 'agents', 'agentPresets', 'sessions', 'workspaceRegistry']`
     （presets/workspace 用 ctx.get 可选，保持 rosterless 部署可用）；
     实现 `incubateRootSession`（selfCtx + withoutInitiator + preset mount + attach + followup）；
   - 单测：创建根会话（header 无 parentSession/origin/delegationDepth）、preset 记录到
     header、followup 自动跑完一回合、未知 preset 拒绝、无 roster 退化、
     **生命周期不随调用方 fiber 回收**（dispose 调用方 agent 后继任者仍 live）；
   - 接线：`packages/bundle/*` 或 host 组合 patch 挂载（照 dsh-taskboard 的接入方式）。
2. **taskboard 接入**（只改 `packages/taskboard/taskboard/src/*` + tests）：
   - Config + boardSchema 扩展（successor 配置 + successorCount）；
   - `handover()` 尾部孵化分支 + `buildSuccessorPrompt`（domain.ts）；
   - `taskboard_handover` 工具结果加 `successor` 字段（`service.ts:2633-2661`）；
   - 工具描述文案更新（`tool-catalog` 生成器相关文档在 V3-6 统一重生成）。
3. **测试**：
   - host 单测：session 私有板拒绝自动继任；successorCount 封顶；模型/预设钉死不随
     prompt 变；孵化失败 → handover 成功但 successor.spawned=false；
   - 端到端：handover → 继任会话创建 → claimMaster 读到笔记 → 继续 assign 派单；
   - 回归：子代理调 handover 被拒（TASKBOARD_NOT_ROOT）；旧 handover（未开 successor）
     行为不变。
4. **文档**：`docs/subsystems/taskboard.md`（+ i18n 配对）补"自动继任"小节；
   包 README；契约变化（tool 结果形状）在 V3-6 跑 `gen-tool-catalog / gen-cordis-catalog`。

## 五、备选方案

- **A. 不抽包，taskboard 内部直接 `selfCtx.agents.create`**：改动最小，但把"创建根会话+
  preset 组合"固化进 taskboard，SDK/ACP/headless 仍然各自手写，重蹈 apiproxy 覆辙；
  且 taskboard 依赖面变大。→ 否：抽独立 seam 包，一次解决所有入口。
- **B. 用子代理机制（subagent spawn）唤起继任者**：子代理天然"父亡子亡"、继承父 preset、
  深度受限、approval 钉死 never——继任者要独立存活、要当根会话 master，语义完全相反。
  → 否。
- **C. fork 现有 master 会话**：fork 继承 cwd/谱系/种子历史，但继任者要**全新**上下文
  （无父对话污染、无历史工具调用），fork 会带来旧会话的全部 baggage；且 fork 的
  parentSession 谱系会让 session.list 把它当"分支"而非新根。→ 否。
- **D. 保持半自动（V3-2），不做自动继任**：可行但不符合本 spike 目标；作为默认关闭的
  配置项保留 V3-2 行为作为降级路径。

## 六、风险

1. **无限继任循环**：若继任 master 又触发 handover+自动继任，会不断开新会话。
   防护：`maxSuccessions` 默认 1 + `successorCount` 单调封顶 + 默认关闭（enabled=false）。
2. **生命周期误绑**（本方案最大技术风险）：任何路径绕过 selfCtx 都会把继任者绑到
   master fiber。防护：incubator 单测必须断言"dispose 调用方后继任者存活"。
3. **资源占用**：继任会话是常驻进程内 agent（live），与手工新会话等价；数量受
   maxSuccessions 封顶，不失控。
4. **用户可见性困惑**：自动冒出的新会话需要明确标题/首条消息自述身份；标题生成依赖
   session-title 服务（V3-1 已具备），孵化 prompt 里直接给一句自述即可。
5. **并发 handover**：两个 master 并发调 handover（租期内只有一个 master，但租期过期后
   可被抢占）→ 孵化分支在 `mutateBoard` 原子链内做 `masterAgentId` 校验 + count 递增，
   与现有 `TASKBOARD_NOT_MASTER` 语义一致。

## 七、验证方式（本 spike 已完成）

- 全链路代码走读并记录行号引用（见上文各节）；
- 关键断言逐条 grep 确认（agents.create/followup/withoutInitiator/selfCtx/
  composedPreset/unfollowOwner/assertRootSession/isBoardVisible 等）；
- 未修改任何产品代码（spike 红线）；本报告落在 taskboard-plugin 工作区 design/ 目录。