# @deepseek-ai/dsh-client-ui-taskboard

[English](README.md) | 中文

工单看板页签：五列会话视图（Backlog、Not started、In progress、In testing、
Done），支持列间 HTML5 拖拽、内嵌新建工单表单，以及展示领取人、审核状态、驳回
反馈、开发备注与历史的详情面板。实时状态来自转发的主机
`taskboard/changed` 事件；所有变更经由生成的 `taskboard` Remote API。

## 模型体验

该页签是用户界面——Agent 通过 `@deepseek-ai/dsh-taskboard` 提供的
`taskboard_*` 工具操作看板。页签展示的正是这些工具提交的状态：被开发领取的
卡片、In testing 的审核席位、打回卡片上的驳回反馈、以及 Done 列。把卡片拖到
Not started 是用户的"开始"信号；Agent 不得替用户移动卡片。
