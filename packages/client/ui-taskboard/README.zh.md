# @deepseek-ai/dsh-client-ui-taskboard

[English](README.md) | 中文

工单看板页签：五列会话视图（Backlog、Not started、In progress、In testing、Done），支持列间 HTML5 拖拽、内嵌新建工单表单，以及展示领取人、审核状态、驳回反馈、开发备注与历史的详情面板。实时状态来自转发的主机 `taskboard/changed` 事件；所有变更经由生成的 `taskboard` Remote API。

## 席位横幅

板头展示 master 席位状态：持有者（短 id，租期将尽时给出警告）或空缺状态加一键「复制接管脚本」按钮。把该脚本粘到新会话，即可让新 Agent 用 `taskboard_claim_master` 认领席位，并按认领结果携带的交接笔记继续工作。

## 模型体验

该页签是用户界面——Agent 通过 `@deepseek-ai/dsh-taskboard` 提供的 `taskboard_*` 工具操作看板。页签展示的正是这些工具提交的状态：被开发领取的卡片、In testing 的审核席位、打回卡片上的驳回反馈、以及 Done 列。把卡片拖到 Not started 是用户的"开始"信号；Agent 不得替用户移动卡片。
