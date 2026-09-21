/**
 * Host-side helpers of the taskboard domain: the typed error, bounded
 * history rows, agent display labels, and the reviewer/worker prompts. Kept
 * separate from ./types.ts (the pure client-safe outlet) because these
 * declarations pull dsh-agent and dsh-subagent types into the program.
 * @module @deepseek-ai/dsh-taskboard
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BoardNotice, BoardView, ColumnId, PreflightReport, TicketView, TicketWorkerStatus } from './types.ts';
import type { ReviewerGitFacts } from './capsule.ts';
/** Stable error codes for rejected taskboard reads and mutations. */
export type TaskboardErrorCode = 'TASKBOARD_TICKET_NOT_FOUND' | 'TASKBOARD_BOARD_NOT_FOUND' | 'TASKBOARD_INVALID_COLUMN' | 'TASKBOARD_INVALID_TRANSITION' | 'TASKBOARD_INVALID_INPUT' | 'TASKBOARD_DEPENDENCY_BLOCKED' | 'TASKBOARD_DEPENDENCY_UNKNOWN' | 'TASKBOARD_DEPENDENCY_CYCLE' | 'TASKBOARD_ALREADY_CLAIMED' | 'TASKBOARD_NOT_OWNER' | 'TASKBOARD_NOT_REVIEWER' | 'TASKBOARD_NOT_MASTER' | 'TASKBOARD_NOT_WORKER' | 'TASKBOARD_NOT_ROOT' | 'TASKBOARD_MASTER_HELD' | 'TASKBOARD_REVIEWER_PRESENT' | 'TASKBOARD_AGENT_REQUIRED';
/** Rejected domain mutation with a stable machine-readable code. */
export declare class TaskboardError extends Error {
    readonly code: TaskboardErrorCode;
    constructor(message: string, code: TaskboardErrorCode);
}
/** How many history rows one ticket retains (oldest dropped first). */
export declare const HISTORY_LIMIT = 50;
/** How many master notices one board retains (oldest dropped first). */
export declare const NOTICE_LIMIT = 100;
/** Append one bounded master notice to a board record under construction.
 * @param board - the board record to extend.
 * @param notice - the durable notice row to append.
 * @returns the board with the bounded notices extended. */
export declare function appendNotice(board: BoardView, notice: BoardNotice): BoardView;
/** Append one bounded history row to a record under construction.
 * @param record - the record to append the row to.
 * @param kind - the stable event kind (e.g. "create", "claim", "approve").
 * @param detail - human-readable detail in the board language.
 * @param at - Unix epoch milliseconds of the row; defaults to now.
 * @returns the record with the bounded history extended. */
export declare function appendHistory(record: TicketView, kind: string, detail: string, at?: number): TicketView;
/** Display label for one agent: the session id is the durable handle, shortened for display.
 * @param agent - the agent to label.
 * @returns the short display label. */
export declare function agentLabel(agent: Agent): string;
/** Display label for a spawned reviewer child.
 * @param childAgentId - the reviewer child's agent id.
 * @returns the short display label. */
export declare function reviewerLabel(childAgentId: string): string;
/** Display label for a spawned worker child.
 * @param childAgentId - the worker child's agent id.
 * @returns the short display label. */
export declare function workerLabel(childAgentId: string): string;
/**
 * The independent git branch one session's worker works on for one ticket,
 * following the shared-workspace conflict convention: every session stays on
 * its own branch (taskboard/<session-short-id>/<ticket-id>) so parallel
 * workers in the same working directory never stage/commit over each other;
 * the master aggregates the branches when the work lands.
 * @param sessionId - the master session id (its uuid part names the branch).
 * @param ticketId - the ticket the worker implements.
 * @returns the branch name, e.g. "taskboard/abc12345/ticket-xyz".
 */
export declare function branchNameFor(sessionId: string, ticketId: string): string;
/** Message attribution for master-seat notifications injected into the seat
 * holder's live inbox (worker report/fail, review verdict landed). Mirrors the
 * goal-round driver's inbox-injection precedent: the master's agent loop
 * claims the message as ordinary input and acts without polling the board. */
export interface TaskboardNoticeSource {
    readonly kind: 'taskboard';
    /** The board whose seat holder receives the notice. */
    readonly boardId: string;
    readonly form?: never;
    readonly senderSessionId?: never;
}
/** Durable attribution for a master-to-worker rework relay. */
export interface TaskboardRelaySource {
    readonly kind: 'taskboard';
    readonly boardId: string;
    readonly form: 'relay';
    readonly senderSessionId: string;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        taskboard: TaskboardNoticeSource | TaskboardRelaySource;
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
export declare function buildReviewPrompt(ticket: TicketView, facts?: ReviewerGitFacts | null): string;
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
export declare function buildReviewReportPrompt(ticket: TicketView, facts?: ReviewerGitFacts | null, verdictViaTool?: boolean): string;
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
export declare function buildWorkerPrompt(ticket: TicketView, cwd?: string, sessionId?: string, preflight?: PreflightReport | null): string;
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
export declare function buildContinuationPrompt(ticket: TicketView, reason: string): string;
/**
 * The structured handover notes taskboard_handover writes onto the board for
 * the next master: one section per column with each card's status, the
 * in-flight worker identities, the In testing review seats, the backlog
 * summary, and the durable master-seat history.
 * @param board - the board being handed over.
 * @param tickets - every ticket on the board (any order; grouped by column here).
 * @returns the notes text, formatted for the next master to read.
 */
export declare function buildHandoverNotes(board: BoardView, tickets: TicketView[]): string;
/**
 * One compact card row of the claim-time handover snapshot: the concrete
 * facts a successor master needs to continue without guessing — ticket id,
 * title, column, worker lifecycle, in-flight worker/reviewer identities,
 * dependencies, the latest review decision, and the pending review report.
 * A read-only view of the board's current state; never a second source of truth.
 */
export interface HandoverCardRow {
    ticketId: string;
    title: string;
    column: ColumnId;
    status: TicketWorkerStatus;
    type: string;
    priority: string;
    workerAgentId: string | null;
    reviewer: {
        agentId: string;
        label: string;
    } | null;
    dependsOn: string[];
    lastReviewOutcome: 'approved' | 'rejected' | null;
    reviewOutcome: {
        verdict: string;
        summary: string;
        problems: string[];
    } | null;
    failure: {
        reason: string;
        at: number;
    } | null;
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
    boardId: string;
    name: string;
    masterAgentId: string | null;
    handoverNotes: string;
    cards: HandoverCardRow[];
    backlogSummary: string;
    pendingAdjudications: string[];
}
/**
 * Build the claim-time handover snapshot from the board row and its tickets.
 * @param board - the board being claimed.
 * @param tickets - every ticket of this board (any order).
 * @returns the structured snapshot (read-only view of the current state).
 */
export declare function buildHandoverSnapshot(board: BoardView, tickets: TicketView[]): HandoverSnapshot;
/**
 * One-line model-visible rendering of a ticket row: the concrete facts
 * (ticketId, title, column, status, worker/reviewer identity, dependencies,
 * review state, failure) a successor master needs to act without guessing.
 * The tool layer renders this text into the model-visible result.
 * @param ticket - the row (TicketRow or HandoverCardRow) to render.
 * @returns the compact line.
 */
export declare function formatTicketRowLine(ticket: {
    id: string;
    title: string;
    column: string;
    status: string;
    type?: string | undefined;
    priority?: string | undefined;
    workerAgentId?: string | null | undefined;
    reviewer?: {
        agentId: string;
    } | null | undefined;
    dependsOn?: string[] | undefined;
    lastReviewOutcome?: 'approved' | 'rejected' | null | undefined;
    failure?: {
        reason: string;
    } | null | undefined;
}): string;
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
export declare function formatHandoverSnapshotText(snapshot: HandoverSnapshot, notices: {
    kind: string;
    text: string;
    at: number;
    ticketId: string;
}[]): string;
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
    ticket: string;
    title: string;
    /** The card state: column[/status], e.g. "in_testing" or "in_progress/blocked". */
    state: string;
    /** The declared file scope (filesScope); '' renders as "(none)". */
    scope: string;
    /** The git commit the event refers to, when known ('' omitted). */
    commit?: string;
    /** The review verdict (approve/reject), for review events. */
    verdict?: string;
    /** The concrete blocking detail, for fail/lost/blocked events. */
    blocker?: string;
    /** Anything unexpected the master must weigh (lost reason, violations, problems). */
    anomaly?: string;
}
/**
 * Render one compact master-event line from its fields.
 * @param kind - stable event-kind prefix shown to the master.
 * @param fields - compact ticket facts appended to the prefix.
 * @returns one single-line event summary.
 */
export declare function formatCompactEvent(kind: string, fields: CompactEventFields): string;
/** The compact card state of one ticket: column, plus status when it refines it.
 * @param ticket - the ticket (column + status).
 * @returns e.g. "in_testing" for a claimed In testing card, "in_progress/blocked" for a blocked one. */
export declare function compactCardState(ticket: {
    column: ColumnId;
    status: TicketWorkerStatus;
}): string;
/**
 * The V3-29 dispatch closing contract, appended to the model-facing return
 * text of taskboard_assign and taskboard_reassign. The anti-polling rule lives
 * exactly once, at the moment the master actually decides whether to wait —
 * instead of being repeated as two long paragraphs in WORKFLOW_SECTION and
 * MASTER_SECTION.
 */
export declare const DISPATCH_TURN_END = "This turn ends here; worker/reviewer events (WORKER_DONE / WORKER_FAILED / REVIEW_VERDICT) will wake you \u2014 do not sleep or re-read the board to wait.";
/** The model-facing workflow section injected into every session's system prompt. */
export declare const WORKFLOW_SECTION: string;
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
export declare const MASTER_SECTION: string;
/**
 * The informational model-suggestion note appended to the master section
 * (V3-5): the session's own model and effort are authoritative, so this is a
 * recommended preset for NEW sessions only, plus a pointer to the board-level
 * modelConfig override path.
 * @param model - the configured masterModel suggestion.
 * @param effort - the configured masterEffort suggestion, if any.
 * @returns the markdown note block, ready to append after MASTER_SECTION.
 */
export declare function masterModelNote(model: string, effort: string | undefined): string;
//# sourceMappingURL=domain.d.ts.map