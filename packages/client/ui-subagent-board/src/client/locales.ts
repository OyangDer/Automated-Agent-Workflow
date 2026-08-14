/**
 * `taskboardBoard` namespace dictionaries: the subagent classification tab.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.subagents': '子代理归类',
  'board.note': '归属徽标取自默认看板（boardId=default）',
  'group.inProgress': '进行中',
  'group.inTesting': '测试中',
  'group.other': '其他',
  'badge.inProgress': 'In progress',
  'badge.inTesting': 'In testing',
  'badge.blocked': '阻塞',
  'row.noTicket': '（无工单归属）',
  'state.loading': '加载中…',
  'empty': '本会话暂无子代理任务',
} satisfies Record<string, string>

/** The taskboardBoard namespace key union. */
export type TaskboardBoardKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'view.subagents': 'Subagents',
  'board.note': 'Badges read the default board (boardId=default)',
  'group.inProgress': 'In progress',
  'group.inTesting': 'In testing',
  'group.other': 'Other',
  'badge.inProgress': 'In progress',
  'badge.inTesting': 'In testing',
  'badge.blocked': 'Blocked',
  'row.noTicket': '(no ticket)',
  'state.loading': 'Loading…',
  'empty': 'No subagent tasks in this session.',
} satisfies Record<TaskboardBoardKey, string>
