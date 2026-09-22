---
description: "Web 工单看板页签、实时五列投影、master 席位横幅与面向用户的工单控件。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-taskboard

[English](README.md) | 中文

## 概述

工单看板页签：五列会话视图（Backlog、Not started、In progress、In testing、Done），支持列间 HTML5 拖拽、内嵌新建工单表单，以及展示领取人、审核状态、驳回反馈、开发备注与历史的详情面板。实时状态来自转发的主机 `taskboard/changed` 事件；所有变更经由生成的 `taskboard` Remote API。

## 目录

- [席位横幅](#master-seat-banner)
- [自动压缩阈值行](#auto-compaction-ceiling-row)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [模型与思考强度选择器](#model-and-effort-selectors)
- [开发备注](#dev-note)

<a id="master-seat-banner"></a>

## 席位横幅

板头展示 master 席位状态：持有者（短 id，租期将尽时给出警告）、租约已过期的席位（显示为「已过期，可抢占」，并恢复接管入口）或空缺状态加一键「复制接管脚本」按钮。把该脚本粘到新会话，即可让新 Agent 用 `taskboard_claim_master` 认领席位，并按认领结果携带的交接笔记继续工作。

<a id="auto-compaction-ceiling-row"></a>

## 自动压缩阈值行

板头带有自动压缩阈值控件（V6-2）：四个预设、一个百分比输入、当前生效值与「恢复默认」。它通过 `ctx.settingsScope` 读写 `compaction-basic` 的设置命名空间，因此存下的值就是每个已挂载压缩引擎实际采用的阈值，并随设置文档一起在宿主重启后保留。已服务但还没有用户选择的段落显示为**跟随会话预设**：组成值是各预设自己的事实（Web 预设各自设置 `thresholdRatio`），文档无法代它命名。

Web profile 按 agent 预设挂载 `compaction-basic`，而 `dsh-web-app` bundle 关闭了基础 bundle 的宿主面挂载；浏览器读取设置文档时（每个连接只读一次）因此还没有任何预设引擎。本包的 node 半侧在启动时注册该段落（`src/index.ts`），这才让全新启动的宿主上控件可用，且不需要改动 profile。比该注册更旧的制品会让控件停留在可操作的「不可用」提示行，此时需要刷新本包制品并重启宿主（`scripts/refresh-taskboard-plugin.md`）。

<a id="model-experience"></a>
## 模型体验

### 浏览器 Taskboard 界面

#### 模型看到的内容

该页签是用户界面——Agent 通过 `@deepseek-ai/dsh-taskboard` 提供的 `taskboard_*` 工具操作看板。页签展示的正是这些工具提交的状态：被开发领取的卡片、In testing 的审核席位、打回卡片上的驳回反馈、以及 Done 列。master 在与用户确认阶段范围后负责把卡片排入 Not started；页签仍提供拖拽作为用户界面能力，但除 master 外的 Agent 不得移动卡片。本包不拥有持久事件流或可变的跨插件状态，因此不发布运行时不变量伴生入口。

#### Token 影响

零。查看、刷新和拖动卡片不会增加模型输入；只有独立的主机侧 Taskboard 工具会产生模型可见的调用与结果。

#### KV Cache 影响

相互独立。本浏览器包不会修改请求前缀或追加模型消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **模型选择器仅在主机／工具侧可用**：浏览器目前尚未提供看板级 worker 与 reviewer 模型或思考强度覆盖选项。
- **宿主面阈值段落只校验取值范围，不校验组成** —— 段落由启动时注册，写入只按 schema 的 0.01–1 范围校验；组成相关的校验（阈值低于某预设的保留比例）在各引擎内部完成：该预设会拒绝这个值、保留上一个可用阈值并记录拒绝原因，而控件仍显示已存下的值。

<a id="model-and-effort-selectors"></a>
### 模型与思考强度选择器（V3-5，TODO）

看板主机侧（V3-5）已支持按看板覆盖 worker/reviewer 的模型与思考强度（看板记录上的 `modelConfig`，由 master 工具 `taskboard_board_config` 写入）。浏览器界面尚未开放这些选项：新建板表单与板设置路径应提供模型/思考强度下拉（每项含「默认」选项，留空即沿用主机配置）。本卡刻意推迟 UI 改动以控制范围；主机契约是纯增量（可选字段），后续接入表单无需改动主机。在此之前，master 通过 `taskboard_board_config`（或主机配置键 `workerModel`/`workerEffort`/`reviewerModel`/`reviewerEffort`）控制派发的 worker/reviewer 模型与思考强度。

<a id="dev-note"></a>
### 开发备注

无。
