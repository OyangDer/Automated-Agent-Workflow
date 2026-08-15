/**
 * Host-side helpers of the taskboard domain: the typed error, bounded
 * history rows, agent display labels, and the reviewer/worker prompts. Kept
 * separate from ./types.ts (the pure client-safe outlet) because these
 * declarations pull dsh-agent and dsh-subagent types into the program.
 * @module @deepseek-ai/dsh-taskboard
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BoardNotice, BoardView, ColumnId, TicketHistoryEntry, TicketView } from './types.ts'

/** Stable error codes for rejected taskboard reads and mutations. */
export type TaskboardErrorCode =
  | 'TASKBOARD_TICKET_NOT_FOUND'
  | 'TASKBOARD_BOARD_NOT_FOUND'
  | 'TASKBOARD_INVALID_COLUMN'
  | 'TASKBOARD_INVALID_TRANSITION'
  | 'TASKBOARD_INVALID_INPUT'
  | 'TASKBOARD_CAPACITY_EXCEEDED'
  | 'TASKBOARD_DEPENDENCY_BLOCKED'
  | 'TASKBOARD_DEPENDENCY_UNKNOWN'
  | 'TASKBOARD_DEPENDENCY_CYCLE'
  | 'TASKBOARD_ALREADY_CLAIMED'
  | 'TASKBOARD_NOT_OWNER'
  | 'TASKBOARD_NOT_REVIEWER'
  | 'TASKBOARD_NOT_MASTER'
  | 'TASKBOARD_NOT_WORKER'
  | 'TASKBOARD_NOT_ROOT'
  | 'TASKBOARD_MASTER_HELD'
  | 'TASKBOARD_REVIEWER_PRESENT'
  | 'TASKBOARD_AGENT_REQUIRED'

/** Rejected domain mutation with a stable machine-readable code. */
export class TaskboardError extends Error {
  constructor(
    message: string,
    readonly code: TaskboardErrorCode,
  ) {
    super(message)
    this.name = 'TaskboardError'
  }
}

/** How many history rows one ticket retains (oldest dropped first). */
export const HISTORY_LIMIT = 50

/** How many master notices one board retains (oldest dropped first). */
export const NOTICE_LIMIT = 100

/** Append one bounded master notice to a board record under construction.
 * @param board - the board record to extend.
 * @param notice - the durable notice row to append.
 * @returns the board with the bounded notices extended. */
export function appendNotice(
  board: BoardView,
  notice: BoardNotice,
): BoardView {
  const notices = (board.notices ?? []).length >= NOTICE_LIMIT
    ? [...(board.notices ?? []).slice(-(NOTICE_LIMIT - 1)), notice]
    : [...(board.notices ?? []), notice]
  return { ...board, notices }
}

/** Append one bounded history row to a record under construction.
 * @param record - the record to append the row to.
 * @param kind - the stable event kind (e.g. "create", "claim", "approve").
 * @param detail - human-readable detail in the board language.
 * @param at - Unix epoch milliseconds of the row; defaults to now.
 * @returns the record with the bounded history extended. */
export function appendHistory(
  record: TicketView,
  kind: string,
  detail: string,
  at = Date.now(),
): TicketView {
  const row: TicketHistoryEntry = { at, kind, detail }
  const history = record.history.length >= HISTORY_LIMIT
    ? [...record.history.slice(-(HISTORY_LIMIT - 1)), row]
    : [...record.history, row]
  return { ...record, history }
}

/** Display label for one agent: the session id is the durable handle, shortened for display.
 * @param agent - the agent to label.
 * @returns the short display label. */
export function agentLabel(agent: Agent): string {
  return ['agent', agent.id.slice(0, 8)].join(' ')
}

/** Display label for a spawned reviewer child.
 * @param childAgentId - the reviewer child's agent id.
 * @returns the short display label. */
export function reviewerLabel(childAgentId: string): string {
  return ['reviewer', childAgentId.slice(0, 8)].join(' ')
}

/** Display label for a spawned worker child.
 * @param childAgentId - the worker child's agent id.
 * @returns the short display label. */
export function workerLabel(childAgentId: string): string {
  return ['worker', childAgentId.slice(0, 8)].join(' ')
}

/**
 * The independent git branch one session's worker works on for one ticket,
 * following the shared-workspace conflict convention: every session stays on
 * its own branch (taskboard/<session-short-id>/<ticket-id>) so parallel
 * workers in the same working directory never stage/commit over each other;
 * the master aggregates the branches when the work lands.
 * @param sessionId - the master session id (its short form names the branch).
 * @param ticketId - the ticket the worker implements.
 * @returns the branch name, e.g. "taskboard/abc12345/ticket-xyz".
 */
export function branchNameFor(sessionId: string, ticketId: string): string {
  return 'taskboard/' + sessionId.slice(0, 8) + '/' + ticketId
}

/** Message attribution for master-seat notifications injected into the seat
 * holder's live inbox (worker report/fail, review verdict landed). Mirrors the
 * goal-round driver's inbox-injection precedent: the master's agent loop
 * claims the message as ordinary input and acts without polling the board. */
export interface TaskboardNoticeSource {
  readonly kind: 'taskboard'
  /** The board whose seat holder receives the notice. */
  readonly boardId: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    taskboard: TaskboardNoticeSource
  }
}

/**
 * The prompt a freshly spawned reviewer runs with. Self-contained: the child
 * has no shared conversation with the developer, so everything it needs —
 * ticket content, the developer's notes, and the exact finishing contract —
 * is inlined here.
 * @param ticket - the ticket under review.
 * @returns the child's user prompt text.
 */
export function buildReviewPrompt(ticket: TicketView): string {
  const assignee = ticket.assignee === null ? '(unassigned)' : ticket.assignee.label
  const description = ticket.description.trim() === '' ? '(none)' : ticket.description
  const devNotes = ticket.devNotes.trim() === '' ? '(none)' : ticket.devNotes
  return [
    ['You are the reviewer for taskboard ticket', ticket.id, '("' + ticket.title + '"), currently In testing.'].join(' '),
    '',
    'Ticket content:',
    '  Title: ' + ticket.title,
    '  Priority: ' + ticket.priority,
    '  Description: ' + description,
    '  Developer: ' + assignee,
    '  Review attempt: ' + String(ticket.reviewAttempts + 1),
    '  Developer notes: ' + devNotes,
    '  Declared file scope: ' + (ticket.filesScope.trim() === '' ? '(not declared)' : ticket.filesScope),
    '',
    'Review the implementation against the description and acceptance criteria:',
    '1. Inspect the workspace changes (git status / diff / log) and read the relevant files.',
    '2. Run the relevant tests and builds where the ticket concerns code.',
    '3. Check edge cases and error paths named in the description, not just the happy path.',
    ...(ticket.filesScope.trim() === '' ? [] : [
      '4. Check the change stays inside the declared file scope: flag any edit outside "' + ticket.filesScope + '".',
    ]),
    ...(ticket.type === 'merge' ? [
      '',
      'Merge ticket specifics — also verify:',
      '- The branch merges cleanly: check for merge conflicts and unresolved conflict markers in the working tree.',
      '- CI results for the change (build and test runs) are green.',
      '- The diff size is proportionate to the description: no unrelated, oversized, or missing changes.',
      "- The target branch was confirmed by the master (the confirmed branch is recorded in the ticket's targetBranch field or devNotes); flag any mismatch.",
    ] : []),
    '',
    'Finish with EXACTLY ONE tool call, nothing else:',
    '- taskboard_approve with ticketId "' + ticket.id + '" and a short summary of what you verified, or',
    '- taskboard_reject with ticketId "' + ticket.id + '" and concrete, actionable feedback listing what must change.',
    '',
    'Do not fix the code yourself and do not move the card; your only authority is the approve/reject decision.',
  ].join('\n')
}

/**
 * The prompt a report-mode reviewer runs with. Self-contained like
 * {@link buildReviewPrompt}, but the child never touches the card: it
 * inspects the workspace and the tests, then returns its conclusion through
 * the structured-output tool (the driver's structured_output capture) as
 * { verdict, summary, problems }. The master reads that conclusion and acts
 * on it with taskboard_resolve_review.
 * @param ticket - the ticket under review.
 * @returns the child's user prompt text.
 */
export function buildReviewReportPrompt(ticket: TicketView): string {
  const assignee = ticket.assignee === null ? '(unassigned)' : ticket.assignee.label
  const description = ticket.description.trim() === '' ? '(none)' : ticket.description
  const devNotes = ticket.devNotes.trim() === '' ? '(none)' : ticket.devNotes
  return [
    ['You are the reviewer for taskboard ticket', ticket.id, '("' + ticket.title + '"), currently In testing.'].join(' '),
    '',
    'Ticket content:',
    '  Title: ' + ticket.title,
    '  Priority: ' + ticket.priority,
    '  Description: ' + description,
    '  Developer: ' + assignee,
    '  Review attempt: ' + String(ticket.reviewAttempts + 1),
    '  Developer notes: ' + devNotes,
    '  Declared file scope: ' + (ticket.filesScope.trim() === '' ? '(not declared)' : ticket.filesScope),
    '',
    'Review the implementation against the description and acceptance criteria:',
    '1. Inspect the workspace changes (git status / diff / log) and read the relevant files.',
    '2. Run the relevant tests and builds where the ticket concerns code.',
    '3. Check edge cases and error paths named in the description, not just the happy path.',
    ...(ticket.filesScope.trim() === '' ? [] : [
      '4. Check the change stays inside the declared file scope: flag any edit outside "' + ticket.filesScope + '".',
    ]),
    ...(ticket.type === 'merge' ? [
      '',
      'Merge ticket specifics — also verify:',
      '- The branch merges cleanly: check for merge conflicts and unresolved conflict markers in the working tree.',
      '- CI results for the change (build and test runs) are green.',
      '- The diff size is proportionate to the description: no unrelated, oversized, or missing changes.',
      "- The target branch was confirmed by the master (the confirmed branch is recorded in the ticket's targetBranch field or devNotes); flag any mismatch.",
    ] : []),
    '',
    'You are a reporting reviewer: you do NOT move cards and you do NOT call any taskboard tool.',
    'Finish by calling the structured_output tool exactly once with:',
    '  - verdict: "approve" when the work passes, "reject" when it must be reworked,',
    '  - summary: what you inspected and why it passes or fails,',
    '  - problems: concrete, actionable rework items (empty when approving).',
  ].join('\n')
}

/**
 * The prompt a freshly spawned worker runs with. Self-contained: the spawned
 * child has no shared conversation with the master, so the ticket content,
 * the working directory, the shared-workspace branch convention, and the
 * exact finishing contract are all inlined.
 * @param ticket - the ticket to implement.
 * @param cwd - the master session's working directory, when known.
 * @param sessionId - the master session id; its short form names the worker branch.
 * @returns the child's user prompt text.
 */
export function buildWorkerPrompt(ticket: TicketView, cwd?: string, sessionId?: string): string {
  const description = ticket.description.trim() === '' ? '(none)' : ticket.description
  const dependsOn = ticket.dependsOn.length === 0
    ? '(none)'
    : ticket.dependsOn.map(dependencyId => '  - ' + dependencyId).join('\n')
  const workspace = cwd === undefined ? '(inherited from the spawning session)' : cwd
  const branch = sessionId === undefined ? undefined : branchNameFor(sessionId, ticket.id)
  const filesScope = ticket.filesScope.trim() === '' ? '(not declared)' : ticket.filesScope
  return [
    ['You are the worker assigned to taskboard ticket', ticket.id, '("' + ticket.title + '").'].join(' '),
    '',
    'Ticket content:',
    '  Title: ' + ticket.title,
    '  Type: ' + ticket.type,
    '  Priority: ' + ticket.priority,
    '  Board: ' + ticket.boardId,
    '  Description: ' + description,
    '  Depends on: ' + dependsOn,
    '',
    'Working directory: ' + workspace,
    '',
    ...(branch === undefined ? [] : [
      'Shared-workspace branch convention (parallel sessions must not clash):',
      '  - Before starting, check the git status and the current branch in the working directory.',
      '  - Work on the session branch "' + branch + '": create it if missing (git switch -c ' + branch + ' from the current base) and keep every change of this ticket on it.',
      '  - Do not merge, push, or rebase: the master aggregates the branches when the work is done.',
      '  - If the working tree is not clean or another branch is checked out, switch to the session branch without touching the other session\'s changes.',
      '',
    ]),
    'Declared file scope: ' + filesScope,
    '  The card declares which files/directories it affects; stay inside that scope and do not edit files outside it (other parallel workers may own them). An undeclared scope means you are responsible for reporting exactly which paths you touched in devNotes.',
    '',
    'Implement the ticket end to end against its description and acceptance criteria:',
    '1. Inspect the workspace (git status / diff / log) and read the relevant files.',
    '2. Make the changes and run the relevant tests and builds where the ticket concerns code.',
    '3. Verify edge cases and error paths named in the description, not just the happy path.',
    '',
    'When the work is done and verified, finish with EXACTLY ONE call to taskboard_report with ticketId "' + ticket.id + '" and devNotes summarizing what changed, which files were touched, and how it was verified.',
    '',
    'If you cannot complete the work (blocked, missing access, irrecoverable error), finish with EXACTLY ONE call to taskboard_fail with ticketId "' + ticket.id + '" and a concrete reason.',
    '',
    'You may not claim, list, view, move, complete, or review cards; the master drives the board. Do not call any other taskboard tool.',
  ].join('\n')
}

/** One card's handover line detail, scoped to its column. */
function handoverCardDetail(ticket: TicketView): string {
  const bits: string[] = []
  if (ticket.column === 'in_progress') {
    bits.push('status ' + ticket.status)
    if (ticket.workerAgentId !== undefined) {
      bits.push('worker ' + ticket.workerAgentId + ' (session ' + String(ticket.workerSessionId ?? '') + ')')
    }
    if (ticket.failure !== null) bits.push('failure: ' + ticket.failure.reason)
  } else if (ticket.column === 'in_testing') {
    bits.push('review attempt ' + String(ticket.reviewAttempts + 1))
    bits.push(ticket.reviewer === null ? 'review seat vacant' : 'reviewer ' + ticket.reviewer.agentId)
    if (ticket.reviewOutcome !== null) bits.push('verdict ' + ticket.reviewOutcome.verdict + ' awaiting resolve')
  } else if (ticket.column === 'not_started' || ticket.column === 'backlog') {
    if (ticket.dependsOn.length > 0) bits.push('depends on ' + ticket.dependsOn.join(', '))
  }
  return bits.length === 0 ? '' : ' — ' + bits.join('; ')
}

/**
 * The structured handover notes taskboard_handover writes onto the board for
 * the next master: one section per column with each card's status, the
 * in-flight worker identities, the In testing review seats, the backlog
 * summary, and the durable master-seat history.
 * @param board - the board being handed over.
 * @param tickets - every ticket on the board (any order; grouped by column here).
 * @returns the notes text, formatted for the next master to read.
 */
export function buildHandoverNotes(board: BoardView, tickets: TicketView[]): string {
  const sections: [ColumnId, string][] = [
    ['backlog', 'Backlog'],
    ['not_started', 'Not started'],
    ['in_progress', 'In progress'],
    ['in_testing', 'In testing'],
    ['done', 'Done'],
  ]
  const lines: string[] = [
    '# Taskboard handover — board ' + JSON.stringify(board.boardId) + ' ("' + board.name + '")',
    '',
    'Generated ' + new Date(Date.now()).toISOString() + '; the seat has been released.',
    'Claim the seat with taskboard_claim_master (boardId "' + board.boardId + '") — the claim',
    'result carries these notes — then continue dispatching (taskboard_assign) and',
    'adjudicating reviews (taskboard_resolve_review) from the state below.',
    '',
  ]
  for (const [column, name] of sections) {
    const rows = tickets.filter(ticket => ticket.column === column)
    lines.push('## ' + name + ' (' + String(rows.length) + ')')
    if (rows.length === 0) {
      lines.push('- (none)')
    } else {
      for (const ticket of rows) {
        lines.push('- ' + ticket.id + ' "' + ticket.title + '" [' + ticket.type + ', ' + ticket.priority + ']'
          + handoverCardDetail(ticket))
      }
    }
    lines.push('')
  }
  lines.push('## Master history')
  const history = board.masterHistory ?? []
  if (history.length === 0) {
    lines.push('- (no seat transitions yet)')
  } else {
    for (const entry of history) {
      lines.push('- ' + new Date(entry.at).toISOString() + ' ' + String(entry.fromAgentId) + ' -> ' + entry.toAgentId
        + (entry.notes === '' ? '' : ' — ' + entry.notes))
    }
  }
  return lines.join('\n')
}

/** The model-facing workflow section injected into every session's system prompt. */
export const WORKFLOW_SECTION = [
  '# Taskboard workflow',
  '',
  'A kanban ticket board (the "Taskboard" tab in the web UI) tracks tickets across five columns: Backlog, Not started, In progress, In testing, Done. The USER manages the board from the web UI; you drive the agent side with the taskboard_* tools.',
  '',
  '- When asked to work on the board — or when you are otherwise free and tickets are waiting — call taskboard_list with column "not_started". Tickets are ordered by implementation order; dependsOn lists hard ordering constraints.',
  '- Claim a ticket with taskboard_claim. Claim only tickets whose dependsOn are all in Done. One agent owns one ticket at a time, and the board caps how many tickets may be In progress at once (claims beyond the cap are rejected — retry later).',
  "- Parallelize: when several ready Not started tickets exist, delegate each to a fresh subagent (spawn) whose prompt includes the ticket's title, description, and the instruction to claim it, implement it, and finish with taskboard_complete.",
  '- When the implementation is done and verified, the owning agent calls taskboard_complete with devNotes summarizing what changed and how it was verified. The board moves the ticket to In testing and automatically spawns a fresh reviewer agent. Never review your own ticket.',
  '- If you are spawned as a reviewer: inspect the workspace changes and run the relevant tests, then finish with exactly one call — taskboard_approve(ticketId, summary) or taskboard_reject(ticketId, feedback). Rejections must list concrete, actionable problems. If no reviewer is assigned to an In testing ticket, taskboard_claim_review takes the seat.',
  '- If a ticket you own returns to In progress with a rejected review, rework it per the feedback (delegate to a fresh subagent with the feedback in its prompt) and call taskboard_complete again.',
  "- v2 master dispatch: before assigning work, claim the board's master seat with taskboard_claim_master (boardId defaults to \"default\"). Only the current master may call taskboard_assign and taskboard_reassign.",
  '- Dispatch a Not started ticket with taskboard_assign: the card moves to In progress and a fresh worker subagent (DeepSeek v4 flash) is spawned with the ticket content; the card records the worker identity. Workers finish with taskboard_report (done) or taskboard_fail (blocked).',
  '- When a worker fails or its session terminates without reporting, the card stays In progress with status "blocked" and a failure record. Use taskboard_reassign with action "retry" to spawn a new worker, or action "backlog" to return the card to Not started.',
  '- v2 report-mode review (config.reviewMode "report"): the spawned reviewer returns a structured verdict only and never touches the card. Read the ticket\'s reviewOutcome, then resolve the review with taskboard_resolve_review: approve lands the card in Done (and archives the worker session); reject returns the card for rework. When the result says the original worker could not be followed up, re-dispatch with taskboard_reassign action "retry". After the third consecutive reject the card is marked blocked, awaiting the user\'s decision.',
  '- Master notifications are durable: worker done/failed/lost events and review verdicts land a notice on the board (readable via taskboard_notices, and carried by the taskboard_claim_master result) and are injected into the master\'s inbox live, or queued into the master\'s persisted inbox when the master session is not live so the next run receives them.',
  "- Never move cards on the user's behalf: dragging cards between columns — in particular Backlog to Not started — is the user's \"start this\" signal in the web UI.",
].join('\n')

/**
 * The master-role section injected into every session's system prompt ahead
 * of the workflow section (order 149). Teaches the master seat: dispatch and
 * review adjudication belong to the master, context pressure is solved by
 * compaction rather than handoff, a real handover first records handover
 * notes (board state and per-card worker identities) on the board so the
 * successor can continue after taskboard_claim_master, and dispatched
 * workers finish their current card without cross-session followup, and
 * parallel sessions in a shared workspace keep apart through the per-session
 * branch convention plus each card's declared file scope.
 */
export const MASTER_SECTION = [
  '# Taskboard master',
  '',
  'You are the board\'s master: you dispatch tickets to workers, adjudicate review results, and discuss the plan with the user. The master seat is per board — claim it with taskboard_claim_master (boardId defaults to "default") before assigning or resolving work.',
  '',
  '- Solve context pressure with compaction first: when the conversation is long or context is running low, compact instead of handing off.',
  '- When a handover is genuinely needed, run taskboard_handover (boardId): it writes structured notes onto the board — every card\'s status, each in-flight worker\'s identity (workerAgentId/workerSessionId), the In testing review seats, the backlog summary, and the master history — then releases the seat. The successor claims the seat with taskboard_claim_master; the claim result carries those notes, and the successor continues dispatching from them.',
  '- Already-dispatched workers finish their current card on their own; do not follow them up across sessions.',
  '- Master notices are durable: every worker done/failed/lost event and review verdict lands a {kind, text, at, ticketId} row on the board synchronously, and is injected into your inbox when your session is live (or queued into your persisted inbox when it is not, so the next run replays it). Read them with taskboard_notices, or with taskboard_claim_master whose result carries them — do not rely on polling the board in a loop.',
  '- Record the plan you agree with the user on the board: taskboard_create adds a card to a board\'s Backlog, taskboard_move schedules a card between columns, and taskboard_plan adjusts dependencies, priority, and ordering. These are master-only tools.',
  '- Merge tickets (type "merge") are only approved after the master confirms the target branch; record it in the ticket\'s targetBranch field (or devNotes) before resolving the review.',
  '',
  '# Shared-workspace branch convention (parallel sessions)',
  '',
  'Parallel sessions may share one working directory; to keep them from stepping on each other\'s files and git state:',
  '- Before starting work on the repo — and again before dispatching — check the git status and the current branch (git status / git branch --show-current). A dirty tree or an unexpected branch changes what workers may touch safely.',
  '- Each session works on its own independent branch: taskboard/<session-short-id>/<ticket-id> (e.g. taskboard/abc12345/ticket-xyz). When you dispatch a card, the worker prompt carries that branch; spawned workers create/switch to it and keep their changes there.',
  '- Workers do not merge or push: when the work is done the master aggregates the session branches (review the diff, merge into the shared base), then reports completion. Never let two sessions commit to the same branch.',
  '',
  '# File-scope declarations (filesScope)',
  '',
  '- Every card carries a filesScope field (\'\' by default): the paths (files or directories) the card affects. Declare it when creating or editing a card — during planning you and the user agree on which files the work touches.',
  '- When dispatching with taskboard_assign, read the filesScope of every In-flight and Not started card before starting new workers: two workers whose scopes overlap must not run in parallel (serialize them or tighten the scopes), and a card whose scope depends on another card\'s output is a soft dependency — order it after that card even without a dependsOn edge.',
  '- When a card has no filesScope declared, ask the user or record one before dispatching so parallel safety is judged on facts, not guesses.',
].join('\n')
