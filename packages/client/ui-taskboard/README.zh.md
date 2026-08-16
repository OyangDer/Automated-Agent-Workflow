# @deepseek-ai/dsh-client-ui-taskboard

[English](README.md) | 中文

工单看板页签：五列会话视图（Backlog、Not started、In progress、In testing、Done），支持列间 HTML5 拖拽、内嵌新建工单表单，以及展示领取人、审核状态、驳回反馈、开发备注与历史的详情面板。实时状态来自转发的主机 `taskboard/changed` 事件；所有变更经由生成的 `taskboard` Remote API。

## 席位横幅

板头展示 master 席位状态：持有者（短 id，租期将尽时给出警告）、租约已过期的席位（显示为「已过期，可抢占」，并恢复接管入口）或空缺状态加一键「复制接管脚本」按钮。把该脚本粘到新会话，即可让新 Agent 用 `taskboard_claim_master` 认领席位，并按认领结果携带的交接笔记继续工作。

## 模型体验

该页签是用户界面——Agent 通过 `@deepseek-ai/dsh-taskboard` 提供的 `taskboard_*` 工具操作看板。页签展示的正是这些工具提交的状态：被开发领取的卡片、In testing 的审核席位、打回卡片上的驳回反馈、以及 Done 列。master 在与用户确认阶段范围后负责把卡片排入 Not started（见 master 提示词中的工作流纪律）；页签仍提供拖拽作为用户界面能力，但除 master 外的 Agent 不得移动卡片。
## 模型与思考强度选择器（V3-5，TODO）

看板主机侧（V3-5）已支持按看板覆盖 worker/reviewer 的模型与思考强度（看板记录上的 `modelConfig`，由 master 工具 `taskboard_board_config` 写入）。浏览器界面尚未开放这些选项：新建板表单与板设置路径应提供模型/思考强度下拉（每项含「默认」选项，留空即沿用主机配置）。本卡刻意推迟 UI 改动以控制范围；主机契约是纯增量（可选字段），后续接入表单无需改动主机。在此之前，master 通过 `taskboard_board_config`（或主机配置键 `workerModel`/`workerEffort`/`reviewerModel`/`reviewerEffort`）控制派发的 worker/reviewer 模型与思考强度。
