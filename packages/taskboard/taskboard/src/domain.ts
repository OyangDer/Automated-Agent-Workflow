/**
 * Host-side helpers of the taskboard domain: the typed error, bounded
 * history rows, agent display labels, and the reviewer/worker prompts. Kept
 * separate from ./types.ts (the pure client-safe outlet) because these
 * declarations pull dsh-agent and dsh-subagent types into the program.
 * @module @deepseek-ai/dsh-taskboard
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TicketHistoryEntry, TicketView } from './types.ts'

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

/** Append one bounded history row to a record under construction. */
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

/** Display label for one agent: the session id is the durable handle, shortened for display. */
export function agentLabel(agent: Agent): string {
  return ['agent', agent.id.slice(0, 8)].join(' ')
}

/** Display label for a spawned reviewer child. */
export function reviewerLabel(childAgentId: string): string {
  return ['reviewer', childAgentId.slice(0, 8)].join(' ')
}

/** Display label for a spawned worker child. */
export function workerLabel(childAgentId: string): string {
  return ['worker', childAgentId.slice(0, 8)].join(' ')
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
    '',
    'Review the implementation against the description and acceptance criteria:',
    '1. Inspect the workspace changes (git status / diff / log) and read the relevant files.',
    '2. Run the relevant tests and builds where the ticket concerns code.',
    '3. Check edge cases and error paths named in the description, not just the happy path.',
    '',
    'Finish with EXACTLY ONE tool call, nothing else:',
    '- taskboard_approve with ticketId "' + ticket.id + '" and a short summary of what you verified, or',
    '- taskboard_reject with ticketId "' + ticket.id + '" and concrete, actionable feedback listing what must change.',
    '',
    'Do not fix the code yourself and do not move the card; your only authority is the approve/reject decision.',
  ].join('\n')
}

/**
 * The prompt a freshly spawned worker runs with. Self-contained: the spawned
 * child has no shared conversation with the master, so the ticket content,
 * the working directory, and the exact finishing contract are all inlined.
 * @param ticket - the ticket to implement.
 * @param cwd - the master session's working directory, when known.
 * @returns the child's user prompt text.
 */
export function buildWorkerPrompt(ticket: TicketView, cwd?: string): string {
  const description = ticket.description.trim() === '' ? '(none)' : ticket.description
  const dependsOn = ticket.dependsOn.length === 0
    ? '(none)'
    : ticket.dependsOn.map(dependencyId => '  - ' + dependencyId).join('\n')
  const workspace = cwd === undefined ? '(inherited from the spawning session)' : cwd
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
  "- Never move cards on the user's behalf: dragging cards between columns — in particular Backlog to Not started — is the user's \"start this\" signal in the web UI.",
].join('\n')
