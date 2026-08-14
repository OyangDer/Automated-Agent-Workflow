# @deepseek-ai/dsh-client-ui-taskboard

English | [中文](README.zh.md)

The Taskboard kanban tab: a five-column conversation view (Backlog, Not
started, In progress, In testing, Done) with HTML5 drag-and-drop between
columns, an inline new-ticket form, and a detail panel showing assignee,
review state, rejection feedback, developer notes, and history. Live state
arrives through the forwarded `taskboard/changed` host event; every
mutation goes through the generated `taskboard` Remote API.

## Model experience

The tab is a user surface — agents interact with the board through the
`taskboard_*` tools provided by `@deepseek-ai/dsh-taskboard`. The tab
shows exactly the state those tools commit: cards claimed by developers, the
In testing review seat, reject feedback on cards returned for rework, and the
Done column. Dragging a card to Not started is the user's "start this"
signal; agents never move cards on the user's behalf.
