/**
 * Host-side helpers of the taskboard domain: the typed error, bounded
 * history rows, agent display labels, and the reviewer/worker prompts. Kept
 * separate from ./types.ts (the pure client-safe outlet) because these
 * declarations pull dsh-agent and dsh-subagent types into the program.
 * @module @deepseek-ai/dsh-taskboard
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BoardNotice, BoardView, ColumnId, PreflightReport, TicketHistoryEntry, TicketView, TicketWorkerStatus } from './types.ts'
import {
  compileReviewerCapsule, compileWorkerCapsule, renderReviewerCapsule, renderWorkerCapsule,
} from './capsule.ts'
import type { ReviewerGitFacts } from './capsule.ts'

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

/** How many recent history rows a wake-up prompt replays as the recorded progress. */
const CONTINUATION_PROGRESS_ROWS = 6

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
  readonly form?: never
  readonly senderSessionId?: never
}

/** Durable attribution for a master-to-worker rework relay. */
export interface TaskboardRelaySource {
  readonly kind: 'taskboard'
  readonly boardId: string
  readonly form: 'relay'
  readonly senderSessionId: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    taskboard: TaskboardNoticeSource | TaskboardRelaySource
  }
}

/**
 * The prompt a freshly spawned reviewer runs with. Self-contained: the child
 * has no shared conversation with the developer, so everything it needs —
 * the reviewer capsule (acceptance verbatim, base/candidate commits, declared
 * scope, touched files, the worker's compact claims) and the exact finishing
 * contract — is inlined here. The capsule is compiled fresh per review from
 * the current board state; the worker's long exploration process is never
 * part of it.
 * @param ticket - the ticket under review.
 * @param facts - the review-time git facts (base/candidate commits and
 * touched files), when computed; otherwise the reviewer determines them
 * itself during verification.
 * @returns the child's user prompt text.
 */
export function buildReviewPrompt(ticket: TicketView, facts?: ReviewerGitFacts | null): string {
  const capsule = compileReviewerCapsule(ticket, facts)
  return [
    ['You are the reviewer for taskboard ticket', ticket.id, '("' + ticket.title + '"), currently In testing.'].join(' '),
    '',
    renderReviewerCapsule(capsule),
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
 * @param facts - the review-time git facts, when computed (see
 * {@link buildReviewPrompt}).
 * @param verdictViaTool - V3-28: when the reviewer runs as a durable
 *   continuable child it cannot carry an outputSchema (structured output is a
 *   one-shot-only subagent capability), so it returns the same
 *   { verdict, summary, problems } report through taskboard_review_verdict
 *   instead of the structured-output tool.
 * @returns the child's user prompt text.
 */
export function buildReviewReportPrompt(
  ticket: TicketView, facts?: ReviewerGitFacts | null, verdictViaTool = false,
): string {
  const capsule = compileReviewerCapsule(ticket, facts)
  return [
    ['You are the reviewer for taskboard ticket', ticket.id, '("' + ticket.title + '"), currently In testing.'].join(' '),
    '',
    renderReviewerCapsule(capsule),
    ...(ticket.type === 'merge' ? [
      '',
      'Merge ticket specifics — also verify:',
      '- The branch merges cleanly: check for merge conflicts and unresolved conflict markers in the working tree.',
      '- CI results for the change (build and test runs) are green.',
      '- The diff size is proportionate to the description: no unrelated, oversized, or missing changes.',
      "- The target branch was confirmed by the master (the confirmed branch is recorded in the ticket's targetBranch field or devNotes); flag any mismatch.",
    ] : []),
    '',
    ...(verdictViaTool ? [
      'You are a reporting reviewer: you do NOT move cards; the master resolves the card from your verdict.',
      'Finish with EXACTLY ONE call to taskboard_review_verdict, nothing else:',
      '  - ticketId: "' + ticket.id + '",',
      '  - verdict: "approve" when the work passes, "reject" when it must be reworked,',
      '  - summary: what you inspected and why it passes or fails,',
      '  - problems: concrete, actionable rework items (empty when approving).',
    ] : [
      'You are a reporting reviewer: you do NOT move cards and you do NOT call any taskboard tool; the master resolves the card from your verdict.',
      'Finish by calling the structured_output tool exactly once with:',
      '  - verdict: "approve" when the work passes, "reject" when it must be reworked,',
      '  - summary: what you inspected and why it passes or fails,',
      '  - problems: concrete, actionable rework items (empty when approving).',
    ]),
  ].join('\n')
}

/**
 * The prompt a freshly spawned worker runs with. Self-contained: the spawned
 * child has no shared conversation with the master, so the worker capsule
 * (goal, acceptance verbatim, dispatch-time git facts, declared scope,
 * constraints), the shared-workspace branch convention, and the exact
 * finishing contract are all inlined. The capsule is compiled fresh on every
 * dispatch — retry/recovery recompiles from the current board state and git
 * facts instead of appending supplementary notes to a previous prompt. Tool
 * permissions are runtime rules (the spawn tool filter plus the workflow
 * section), never repeated here per card.
 * @param ticket - the ticket to implement.
 * @param cwd - the master session's working directory, when known.
 * @param sessionId - the master session id; its short form names the worker branch.
 * @param preflight - the dispatch-time preflight report ([B] V3-20), when
 * computed; its raw git facts fill the capsule's repository-facts field.
 * @returns the child's user prompt text.
 */
export function buildWorkerPrompt(
  ticket: TicketView, cwd?: string, sessionId?: string, preflight?: PreflightReport | null,
): string {
  const capsule = compileWorkerCapsule(ticket, preflight)
  const branch = sessionId === undefined ? undefined : branchNameFor(sessionId, ticket.id)
  return [
    ['You are the worker assigned to taskboard ticket', ticket.id, '("' + ticket.title + '").'].join(' '),
    '',
    renderWorkerCapsule(capsule, cwd),
    ...(branch === undefined ? [] : [
      '',
      'Shared-workspace branch convention (parallel sessions must not clash):',
      '  - Before starting, check the git status and the current branch in the working directory.',
      '  - Work on the session branch "' + branch + '": create it if missing (git switch -c ' + branch + ' from the current base) and keep every change of this ticket on it.',
      '  - Do not merge, push, or rebase: the master aggregates the branches when the work is done.',
      '  - If the working tree is not clean or another branch is checked out, switch to the session branch without touching the other session\'s changes.',
    ]),
    '',
    'Implement the ticket end to end against the goal, acceptance criteria and constraints in the capsule above:',
    '1. Inspect the workspace (git status / diff / log) and read the relevant files.',
    '2. Make the changes and run the relevant tests and builds where the ticket concerns code.',
    '3. Verify edge cases and error paths named in the card, not just the happy path.',
    '',
    'When the work is done and verified, finish with EXACTLY ONE call to taskboard_report with ticketId "' + ticket.id + '" and devNotes summarizing what changed, which files were touched, and how it was verified.',
    '',
    'If you cannot complete the work (blocked, missing access, irrecoverable error), finish with EXACTLY ONE call to taskboard_fail with ticketId "' + ticket.id + '" and a concrete reason.',
  ].join('\n')
}

/**
 * The wake-up prompt for a worker session that is already dispatched to a
 * ticket (V3-28). Unlike {@link buildWorkerPrompt} this message is delivered
 * into the existing child session, so it never re-briefs the ticket from
 * scratch: it restates the identity, the acceptance criteria (compiled fresh
 * from the current card), the recorded progress, why the session was woken and
 * the standing instruction not to roll back the preserved working tree — then
 * points back at the unchanged finishing contract.
 * @param ticket - the card the woken session already owns.
 * @param reason - why the board judged the session lost and woke it.
 * @returns the continuation message text.
 */
export function buildContinuationPrompt(ticket: TicketView, reason: string): string {
  const capsule = compileWorkerCapsule(ticket)
  const recent = ticket.history.slice(-(CONTINUATION_PROGRESS_ROWS))
  return [
    ['Wake-up: you are ALREADY the worker for taskboard ticket', ticket.id, '("' + ticket.title + '"), and this message continues YOUR existing session.'].join(' '),
    'You keep the full context of your earlier exploration; the shared working tree is preserved — 续做勿回滚：勿回滚工作树，不要丢弃未提交的改动，从你停下的地方继续。',
    'Do NOT roll back the working tree, do NOT discard uncommitted changes, and do NOT restart the work from scratch — resume from where you stopped.',
    '',
    renderWorkerCapsule(capsule),
    '',
    'Why you were woken: ' + reason,
    ...(recent.length === 0 ? [] : [
      '',
      'Your recorded progress on this card (most recent last):',
      ...recent.map(row => '  - [' + row.kind + '] ' + row.detail),
    ]),
    '',
    'Continue the pending work against the goal, acceptance criteria and constraints above, then finish with EXACTLY ONE call to taskboard_report with ticketId "' + ticket.id + '" and devNotes summarizing what changed, which files were touched, and how it was verified.',
    'If you are genuinely blocked, finish with EXACTLY ONE call to taskboard_fail with ticketId "' + ticket.id + '" and a concrete reason.',
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
      const target = entry.toAgentId === '' ? '(seat released)' : entry.toAgentId
      lines.push('- ' + new Date(entry.at).toISOString() + ' ' + String(entry.fromAgentId) + ' -> ' + target
        + (entry.notes === '' ? '' : ' — ' + entry.notes))
    }
  }
  return lines.join('\n')
}

/**
 * One compact card row of the claim-time handover snapshot: the concrete
 * facts a successor master needs to continue without guessing — ticket id,
 * title, column, worker lifecycle, in-flight worker/reviewer identities,
 * dependencies, the latest review decision, and the pending review report.
 * A read-only view of the board's current state; never a second source of truth.
 */
export interface HandoverCardRow {
  ticketId: string
  title: string
  column: ColumnId
  status: TicketWorkerStatus
  type: string
  priority: string
  workerAgentId: string | null
  reviewer: { agentId: string; label: string } | null
  dependsOn: string[]
  lastReviewOutcome: 'approved' | 'rejected' | null
  reviewOutcome: { verdict: string; summary: string; problems: string[] } | null
  failure: { reason: string; at: number } | null
}

/**
 * The structured handover snapshot returned by taskboard_claim_master: every
 * non-Done card with its concrete state, the per-column counts, the pending
 * adjudications (In testing cards whose review verdict landed), the stored
 * handover notes, and the board's durable notices. Computed fresh at claim
 * time from the live board state — a crash succession (no prior
 * taskboard_handover call) still yields a complete snapshot.
 */
export interface HandoverSnapshot {
  boardId: string
  name: string
  masterAgentId: string | null
  handoverNotes: string
  cards: HandoverCardRow[]
  backlogSummary: string
  pendingAdjudications: string[]
}

/**
 * Build the claim-time handover snapshot from the board row and its tickets.
 * @param board - the board being claimed.
 * @param tickets - every ticket of this board (any order).
 * @returns the structured snapshot (read-only view of the current state).
 */
export function buildHandoverSnapshot(board: BoardView, tickets: TicketView[]): HandoverSnapshot {
  const order: ColumnId[] = ['backlog', 'not_started', 'in_progress', 'in_testing', 'done']
  const active = tickets
    .filter(ticket => ticket.column !== 'done')
    .sort((a, b) => {
      const col = order.indexOf(a.column) - order.indexOf(b.column)
      return col !== 0 ? col : a.position - b.position
    })
  const cards: HandoverCardRow[] = active.map(ticket => ({
    ticketId: ticket.id,
    title: ticket.title,
    column: ticket.column,
    status: ticket.status,
    type: ticket.type,
    priority: ticket.priority,
    workerAgentId: ticket.workerAgentId ?? null,
    reviewer: ticket.reviewer,
    dependsOn: ticket.dependsOn,
    lastReviewOutcome: ticket.lastReview?.outcome ?? null,
    reviewOutcome: ticket.reviewOutcome === null || ticket.reviewOutcome === undefined
      ? null
      : { verdict: ticket.reviewOutcome.verdict, summary: ticket.reviewOutcome.summary, problems: ticket.reviewOutcome.problems },
    failure: ticket.failure,
  }))
  const counts: Record<ColumnId, number> = {
    backlog: 0, not_started: 0, in_progress: 0, in_testing: 0, done: 0,
  }
  for (const ticket of tickets) counts[ticket.column] += 1
  const pendingAdjudications = tickets
    .filter(ticket => ticket.column === 'in_testing' && ticket.reviewOutcome !== null && ticket.reviewOutcome !== undefined)
    .map(ticket => ticket.id)
  return {
    boardId: board.boardId,
    name: board.name,
    masterAgentId: board.masterAgentId,
    handoverNotes: board.handoverNotes,
    cards,
    backlogSummary: 'Backlog ' + counts.backlog + ' · Not started ' + counts.not_started
      + ' · In progress ' + counts.in_progress + ' · In testing ' + counts.in_testing + ' · Done ' + counts.done,
    pendingAdjudications,
  }
}

/**
 * One-line model-visible rendering of a ticket row: the concrete facts
 * (ticketId, title, column, status, worker/reviewer identity, dependencies,
 * review state, failure) a successor master needs to act without guessing.
 * The tool layer renders this text into the model-visible result.
 * @param ticket - the row (TicketRow or HandoverCardRow) to render.
 * @returns the compact line.
 */
export function formatTicketRowLine(ticket: {
  id: string
  title: string
  column: string
  status: string
  type?: string | undefined
  priority?: string | undefined
  workerAgentId?: string | null | undefined
  reviewer?: { agentId: string } | null | undefined
  dependsOn?: string[] | undefined
  lastReviewOutcome?: 'approved' | 'rejected' | null | undefined
  failure?: { reason: string } | null | undefined
}): string {
  const bits = [
    ticket.id,
    JSON.stringify(ticket.title),
    'column=' + ticket.column,
    'status=' + ticket.status,
  ]
  if (ticket.type !== undefined) bits.push('type=' + ticket.type)
  if (ticket.priority !== undefined) bits.push('priority=' + ticket.priority)
  if (ticket.workerAgentId) bits.push('worker=' + ticket.workerAgentId)
  if (ticket.reviewer) bits.push('reviewer=' + ticket.reviewer.agentId)
  if (ticket.dependsOn !== undefined && ticket.dependsOn.length > 0) bits.push('dependsOn=' + ticket.dependsOn.join(','))
  if (ticket.lastReviewOutcome) bits.push('lastReview=' + ticket.lastReviewOutcome)
  if (ticket.failure) bits.push('failure=' + ticket.failure.reason)
  return '- ' + bits.join(' ')
}

/**
 * Render the claim-time handover snapshot as the model-visible text: the
 * per-column summary, every active card's concrete line, the pending
 * adjudications, the stored handover notes body, and every durable notice.
 * This is the successor's single entry point — it must carry the facts, not
 * just counts.
 * @param snapshot - the structured snapshot from buildHandoverSnapshot.
 * @param notices - the board's durable notices (newest last).
 * @returns the full model-visible snapshot text.
 */
export function formatHandoverSnapshotText(
  snapshot: HandoverSnapshot,
  notices: { kind: string; text: string; at: number; ticketId: string }[],
): string {
  const lines: string[] = [
    'Handover snapshot for board ' + JSON.stringify(snapshot.boardId) + ' ("' + snapshot.name + '")',
    snapshot.backlogSummary,
  ]
  if (snapshot.cards.length === 0) {
    lines.push('Active cards: (none)')
  } else {
    lines.push('Active cards:')
    for (const card of snapshot.cards) lines.push(formatTicketRowLine({ ...card, id: card.ticketId }))
  }
  lines.push('Pending adjudications: ' + (snapshot.pendingAdjudications.length === 0
    ? '(none)'
    : snapshot.pendingAdjudications.join(', ')))
  if (snapshot.handoverNotes !== '') {
    lines.push('Handover notes:')
    lines.push(snapshot.handoverNotes)
  }
  if (notices.length === 0) {
    lines.push('Notices: (none)')
  } else {
    lines.push('Notices:')
    for (const notice of notices) {
      lines.push('- [' + notice.kind + '] ' + notice.ticketId + ': ' + notice.text)
    }
  }
  return lines.join('\n')
}

/**
 * The compact master-event line: one key=value line carrying every fact the
 * master needs to adjudicate a notice without opening the card. Fields are
 * the V3-21 compact vocabulary — ticket / title / state / scope / commit /
 * verdict / blocker / anomaly — rendered as `KIND ticket=... title=...
 * state=... scope=... [commit=...] [verdict=...] [blocker=...] [anomaly=...]`.
 * Never reduced to a bare PASS/FAIL: the scope, commit and anomaly survive so
 * the master can rule on the card itself.
 * @param kind - the uppercase event kind, e.g. "WORKER_DONE", "REVIEW_VERDICT".
 * @param fields - the compact fields; optional ones render only when non-empty.
 * @returns the compact event line.
 */
export interface CompactEventFields {
  ticket: string
  title: string
  /** The card state: column[/status], e.g. "in_testing" or "in_progress/blocked". */
  state: string
  /** The declared file scope (filesScope); '' renders as "(none)". */
  scope: string
  /** The git commit the event refers to, when known ('' omitted). */
  commit?: string
  /** The review verdict (approve/reject), for review events. */
  verdict?: string
  /** The concrete blocking detail, for fail/lost/blocked events. */
  blocker?: string
  /** Anything unexpected the master must weigh (lost reason, violations, problems). */
  anomaly?: string
}

/**
 * Render one compact master-event line from its fields.
 * @param kind - stable event-kind prefix shown to the master.
 * @param fields - compact ticket facts appended to the prefix.
 * @returns one single-line event summary.
 */
export function formatCompactEvent(kind: string, fields: CompactEventFields): string {
  const bits = [
    kind + ' ticket=' + fields.ticket,
    'title=' + JSON.stringify(fields.title),
    'state=' + fields.state,
    'scope=' + (fields.scope === '' ? '(none)' : fields.scope),
  ]
  if (fields.commit !== undefined && fields.commit !== '') bits.push('commit=' + fields.commit)
  if (fields.verdict !== undefined && fields.verdict !== '') bits.push('verdict=' + fields.verdict)
  if (fields.blocker !== undefined && fields.blocker !== '') bits.push('blocker=' + JSON.stringify(fields.blocker))
  if (fields.anomaly !== undefined && fields.anomaly !== '') bits.push('anomaly=' + JSON.stringify(fields.anomaly))
  return bits.join(' ')
}

/** The compact card state of one ticket: column, plus status when it refines it.
 * @param ticket - the ticket (column + status).
 * @returns e.g. "in_testing" for a claimed In testing card, "in_progress/blocked" for a blocked one. */
export function compactCardState(ticket: { column: ColumnId; status: TicketWorkerStatus }): string {
  return ticket.status === 'claimed' || ticket.status === 'ready'
    ? ticket.column
    : ticket.column + '/' + ticket.status
}

/**
 * The V3-29 dispatch closing contract, appended to the model-facing return
 * text of taskboard_assign and taskboard_reassign. The anti-polling rule lives
 * exactly once, at the moment the master actually decides whether to wait —
 * instead of being repeated as two long paragraphs in WORKFLOW_SECTION and
 * MASTER_SECTION.
 */
export const DISPATCH_TURN_END = 'This turn ends here; worker/reviewer events (WORKER_DONE / WORKER_FAILED / REVIEW_VERDICT) will wake you — do not sleep or re-read the board to wait.'

/** The model-facing workflow section injected into every session's system prompt. */
export const WORKFLOW_SECTION = [
  '# Taskboard workflow',
  '',
  'A kanban ticket board (the "Taskboard" tab in the web UI) tracks tickets across five columns: Backlog, Not started, In progress, In testing, Done. The USER manages the board from the web UI; you drive the agent side with the taskboard_* tools.',
  '',
  '- When asked to work on the board — or when you are otherwise free and tickets are waiting — call taskboard_list with column "not_started". Tickets are ordered by implementation order; dependsOn lists hard ordering constraints.',
  '- Claiming a ticket is the master\'s scheduling action: only the board\'s current master may call taskboard_claim, and only for Not started tickets whose dependsOn are all in Done. One ticket at a time per caller, and the board caps how many tickets may be In progress at once (claims beyond the cap are rejected — retry later). Workers and reviewers never claim — they receive cards through taskboard_assign (dispatch) or taskboard_reassign (re-dispatch).',
  '- Parallelize: when several ready Not started tickets exist, dispatch each to a fresh worker with taskboard_assign — the assign spawns the worker subagent with the ticket content, the worker implements it, and finishes with taskboard_report (done) or taskboard_fail (blocked).',
  '- When the implementation is done and verified, the owning agent calls taskboard_complete with devNotes summarizing what changed and how it was verified. The board moves the ticket to In testing and automatically spawns a fresh reviewer agent. Never review your own ticket.',
  '- If you are spawned as a reviewer: inspect the workspace changes and run the relevant tests, then finish with exactly one call — taskboard_approve(ticketId, summary) or taskboard_reject(ticketId, feedback). Rejections must list concrete, actionable problems. If no reviewer is assigned to an In testing ticket, taskboard_claim_review takes the seat.',
  '- If a ticket you own returns to In progress with a rejected review, rework it per the feedback (delegate to a fresh subagent with the feedback in its prompt) and call taskboard_complete again.',
  "- v2 master dispatch: before assigning work, claim the board's master seat with taskboard_claim_master (boardId defaults to \"default\"). Only the current master may call taskboard_assign and taskboard_reassign.",
  '- Dispatch a Backlog or Not started ticket with taskboard_assign: the card moves to In progress and a fresh worker subagent (the configured worker model and reasoning effort; see taskboard_board_config for per-board overrides) is spawned with the ticket content; the card records the worker identity. Not started is the scheduling display for the next queue — a card needs no move before dispatch. Workers finish with taskboard_report (done) or taskboard_fail (blocked).',
  '- Pause a running card with taskboard_pause (master only): the in-flight worker run is aborted, the card is marked paused (column unchanged) with one history row naming the pauser and the reason, and the master is notified. A paused card is never auto-blocked by the settlement callback or the liveness reconciliation. Resume with taskboard_reassign action "retry", which clears the paused status and spawns a fresh worker.',
  '- When a worker fails or its session terminates without reporting, the card stays In progress with status "blocked" and a failure record. Use taskboard_reassign with action "retry" to spawn a new worker, or action "backlog" to return the card to Not started.',
  '- Seat self-healing is automatic: a lost worker session is auto-redispatched (up to the configured per-card cap) with the working tree preserved — the card description carries a "续做勿回滚" annotation and the master receives a "worker-redispatched" notice. A reviewer seat without a verdict past the staleness timeout (or whose session is gone) is released and re-review is attempted; the master receives a "reviewer-released" notice. The master seat is released by the same liveness judgment (a holder session absent from the registry is released at once, plus an optional idle arm; no wall-clock lease) and records a "master-released" notice. Only when the automatic budget is exhausted is the card blocked for manual taskboard_reassign.',
  '- v2 report-mode review (config.reviewMode "report"): the spawned reviewer returns a structured verdict only and never touches the card. Read the ticket\'s reviewOutcome, then resolve the review with taskboard_resolve_review: approve lands the card in Done (and archives the worker session); reject returns the card for rework. When the result says the original worker could not be followed up, re-dispatch with taskboard_reassign action "retry". After the third consecutive reject the card is marked blocked, awaiting the user\'s decision.',
  '- Master notifications are durable: worker done/failed/lost events and review verdicts land a notice on the board (readable via taskboard_notices, and carried by the taskboard_claim_master result) and are injected into the master\'s inbox live, or queued into the master\'s persisted inbox when the master session is not live so the next run receives them.',
  "- Moving cards between columns is the board's master's job, executed only after the master and the user agree on the phase scope; non-master agents never move cards. Not started is the scheduling display for the next queue: the master may dispatch directly from Backlog or Not started with taskboard_assign — no move is needed before dispatch. The user's drag-and-drop keeps its visual feedback, but intent is expressed in the conversation. See the master section's workflow discipline for the plan → phase → schedule → execute order.",
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
 * branch convention plus each card's declared file scope. Also teaches the
 * phased workflow discipline: plan requirements into Backlog, agree the
 * phase scope and its stopping point with the user, dispatch the phase's
 * cards straight from Backlog or Not started (assign accepts both; a move
 * is never required before dispatch), stop when the phase is done, and
 * number every card at creation time.
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
  '- Read cards in layers (V3-21): default compact — taskboard_list returns one line per card (ticket/title/state/scope/worker/reviewer/dependsOn), enough to dispatch and adjudicate; taskboard_view is the on-demand full read (description, devNotes, history); use the full read only when a compact line leaves an anomaly unresolved.',
  '- Seat self-healing keeps cards moving without you: a lost worker is auto-redispatched (working tree preserved, card description annotated "续做勿回滚") up to the per-card cap, and a stale or ghost reviewer seat is released and re-reviewed. A "worker-redispatched" or "reviewer-released" notice tells you it happened; only when the automatic budget is exhausted does the card land blocked for manual taskboard_reassign.',
  '- The master seat is held by liveness, not by a clock (V3-25): a seat whose holder session left the agent registry (restart / hard death), or stayed silent past the configured idle arm, is released with a "master-released" notice and one master-history row — re-claim it with taskboard_claim_master (the result carries the structured snapshot). A release changes ownership only: in-flight cards keep their workers and reviewers.',
  '- Pause a running card with taskboard_pause (master only): the worker run is aborted, the card is marked paused (column unchanged; history records the pauser and reason) and the master is notified. Paused cards are exempt from settlement reclamation and the liveness reconciliation; resume with taskboard_reassign action "retry" (spawns a fresh worker) or return them to Not started with action "backlog".',
  '- Record the plan you agree with the user on the board: taskboard_create adds a card to a board\'s Backlog, taskboard_move schedules a card between columns, and taskboard_plan adjusts dependencies, priority, and ordering. These are master-only tools.',
  '- Claiming a Not started ticket (taskboard_claim) is your scheduling action, not the worker\'s: only the current master may claim.',
  '- Merge tickets (type "merge") are only approved after the master confirms the target branch; record it in the ticket\'s targetBranch field (or devNotes) before resolving the review.',
  '- User-scheduled Not started cards wake you: when the user moves a card into Not started, a "user-scheduled" notice (card id, title, priority, type, dependsOn with all-Done status, filesScope) lands in your inbox and on the board. Adjudicate whether to start it: when every dependency is Done and the In-progress cap allows, dispatch with taskboard_assign — the card moves to In progress and the workflow starts. When the card cannot start, tell the user the refusal reason in the conversation (name the unfinished dependency cards, or the capacity reason) and record the reason in the card\'s history or devNotes so the decision leaves a durable trace.',
  '',
  '# Workflow discipline (plan → phase → schedule → execute)',
  '',
  'Run the board in phases; the user decides the scope, the master executes the schedule:',
  '- Requirement planning: discuss with the user which requirements to take on, and write every agreed requirement to the board\'s Backlog as a card (taskboard_create).',
  '- Phase scope: agree with the user which cards this phase covers and where it stops — record the phase\'s explicit stopping point before scheduling.',
  '- Phase scheduling: once the phase scope is confirmed, the phase\'s cards can be dispatched straight from Backlog — taskboard_assign accepts Backlog and Not started, so no move is ever required before dispatch (the old rule that the master must move cards from Backlog to Not started first is gone). Not started is kept as the scheduling display for the "next queue": move a card there (taskboard_move) when you want to show the user what is next without starting it, and the user\'s own drag into Not started still wakes you with a "user-scheduled" notice. The user\'s drag-and-drop keeps its visual feedback, but intent is expressed in the conversation.',
  '- Execution discipline: dispatch from Backlog or Not started — never touch In progress / In testing / Done cards (those already have a worker or a review in flight). When the phase\'s cards are all Done the phase is over: stop and wait for the user to confirm the next phase\'s scope.',
  '- Card numbering: every card carries a number (e.g. V3-1, V3-7) agreed at creation/discussion time, so the plan and the board stay easy to manage.',
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
  '',
  '# Handover data contract (fail closed)',
  '',
  'The claim-time handover snapshot is the successor\'s single entry point into the board state:',
  '- taskboard_claim_master returns the fresh structured snapshot (every active card\'s ticketId, title, column, status, worker/reviewer identity, dependencies, latest review, plus the per-column summary and the pending adjudications). Read it before anything else.',
  '- If the claim result\'s cards snapshot is missing or unreadable, or taskboard_list returns no rows while the snapshot promises active cards: fail closed — stop dispatching, report "handover data unavailable" to the user, and wait for instructions.',
  '- Never guess ticket ids, never create probe cards, and never use write operations (move/pause/reassign) to reverse-engineer board state. Read only via the claim snapshot, taskboard_list, and taskboard_view.',
].join('\n')

/**
 * The informational model-suggestion note appended to the master section
 * (V3-5): the session's own model and effort are authoritative, so this is a
 * recommended preset for NEW sessions only, plus a pointer to the board-level
 * modelConfig override path.
 * @param model - the configured masterModel suggestion.
 * @param effort - the configured masterEffort suggestion, if any.
 * @returns the markdown note block, ready to append after MASTER_SECTION.
 */
export function masterModelNote(model: string, effort: string | undefined): string {
  return [
    '',
    '# Model preset suggestion (new sessions)',
    '',
    'This deployment suggests running a new master session with model "' + model + '"'
      + (effort === undefined ? '' : ' and reasoning effort "' + effort + '"')
      + '. The current session\'s own model and effort are authoritative — treat this only as the recommended preset for a fresh session.',
    'Per-board worker/reviewer model+effort overrides live in the board\'s modelConfig; read or change them with taskboard_board_config (master only).',
  ].join('\n')
}
