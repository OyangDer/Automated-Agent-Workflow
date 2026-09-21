/**
 * The taskboard domain service: durable five-column ticket storage across
 * multiple boards, the master seat, the agent-facing workflow tools
 * (list/claim/assign/report/fail/reassign/complete/approve/reject), the
 * browser Remote API, automatic worker/reviewer spawning with a fixed worker
 * model, and failure reclamation when a worker session ends without
 * reporting. Tickets persist through the storage-domain seam; every
 * committed mutation emits the forwarded taskboard/changed event.
 * @module @deepseek-ai/dsh-taskboard
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { ArchiveBoardRequest, BoardNotice, BoardSnapshot, BoardView, ColumnId, CreateBoardRequest, CreateTicketRequest, EditTicketRequest, MoveTicketRequest, Priority, RemoveTicketRequest, RemoveTicketResult, RequestReviewRequest, TicketAssignee, TicketFailure, TicketType, TicketView, TicketWorkerStatus } from './types.ts';
import { type RepoPreflightConfig } from './preflight.ts';
/** Deployment knobs for the taskboard workflow. */
export interface Config {
    /** Subagent provider name used to spawn reviewer agents. */
    reviewProvider?: string;
    /** Model id for the master session (informational knob; the session's own model is authoritative). */
    masterModel?: string;
    /**
     * Reasoning effort suggested for a NEW master session (informational knob;
     * the session's own model and effort are authoritative). Omitted effort
     * leaves the session's adapter default. Written into the master prompt as
     * a suggestion; a value outside the deepseek vocabulary (off/high/max)
     * falls back to unset.
     */
    masterEffort?: string;
    /** Model id used for every spawned worker child (default deepseek-v4-flash). */
    workerModel?: string;
    /**
     * Reasoning effort for every spawned worker child (default unset: the
     * child model's adapter default applies, e.g. deepseek "high"). A value
     * outside the deepseek vocabulary (off/high/max) falls back to unset.
     */
    workerEffort?: string;
    /** Model id used for every spawned reviewer child; defaults to the workerModel. */
    reviewerModel?: string;
    /** Reasoning effort for every spawned reviewer child; defaults to the workerEffort. */
    reviewerEffort?: string;
    /** Subagent provider name used to spawn worker agents. */
    workerProvider?: string;
    /** Review protocol: "report" has the reviewer return a structured verdict (master resolves); "direct" keeps the v1 reviewer tools. */
    reviewMode?: 'report' | 'direct';
    /**
     * Worker-liveness reconciliation interval in milliseconds: the periodic
     * scanner marks In progress/running cards whose worker session left the
     * live agent registry blocked (0 disables the periodic scan; the startup
     * scan still runs once). Defaults to 60000.
     */
    reconcileIntervalMs?: number;
    /**
     * Master-notice dedupe window in milliseconds: a second notice for the
     * same board + ticket + event kind within the window records nothing and
     * delivers nothing (0 disables dedupe). Defaults to 10000.
     */
    noticeDedupeWindowMs?: number;
    /**
     * How long a worker session that is still registered may sit idle (no
     * running tool, no session activity) before the liveness reconciliation
     * judges it lost and auto-redispatches a replacement (0 disables the
     * idle-staleness arm; a session absent from the registry is always lost
     * immediately). Defaults to 600000 (10 minutes).
     */
    lostWorkerTimeoutMs?: number;
    /**
     * Per-card automatic worker redispatch cap: how many times the liveness
     * reconciliation may auto-redispatch one card's lost worker before giving
     * up and marking the card blocked with a master notice (0 disables
     * auto-redispatch entirely — the card is blocked on the first loss, the
     * V3-13 behavior). Defaults to 2.
     */
    workerAutoRetryLimit?: number;
    /**
     * How long an In testing card may sit with a reviewer seat and no
     * reviewOutcome before the reviewer-staleness reconciliation releases the
     * seat and auto-redispatches a fresh reviewer (0 disables reviewer
     * staleness). Staleness is narrower than liveness (V3-43): it only judges
     * the idle-staleness arm — a *registered* reviewer that is not running and
     * has no verdict past this timeout. Registry absence alone never releases
     * the seat: the reviewer seat follows its holder session exactly like the
     * master seat, so a report-mode reviewer that lives in the session store
     * (ready, not live) keeps it. Defaults to 900000 (15 minutes).
     */
    reviewerStaleTimeoutMs?: number;
    /**
     * Per-card automatic reviewer redispatch cap (V3-43): how many times the
     * reviewer-staleness reconciliation may release one card's seat and
     * auto-redispatch a fresh reviewer before giving up and blocking the card
     * with a master notice naming the reason (0 disables reviewer
     * auto-redispatch: the first judged seat loss blocks the card). Mirrors
     * workerAutoRetryLimit and is the loop brake that keeps any future
     * seat-liveness fault from becoming an unbounded release/redispatch loop.
     * Defaults to 2.
     */
    reviewerAutoRetryLimit?: number;
    /**
     * V3-20/V3-26: per-repo deterministic preflight contracts, keyed by
     * absolute repo root path. When non-empty, every assign/retry dispatch
     * resolves the card's repo from its declared filesScope first and falls
     * back to the master session cwd (the shared workspace) only when no
     * declared scope entry lands inside a configured root, then refuses to
     * spawn a worker unless the live git facts satisfy the invariants — the
     * canonical base (branch + commit) is checked out, the working tree is
     * clean, no reserved worktree (e.g. the integration worktree) is occupied,
     * and no in-flight card of the same board has an overlapping file scope.
     * A failing dispatch lands the card blocked with the concrete violations
     * and never spawns a worker (fail closed). An empty/absent map keeps the
     * legacy dispatch path (no preflight).
     */
    preflightRepos?: Record<string, RepoPreflightConfig>;
}
/** Schemastery configuration for the taskboard consumer. */
export declare const Config: z<Config>;
/** One worker-spawn outcome. The controller owns the request signal; the
 * caller keeps it so a later taskboard_pause can abort the in-flight run.
 * V3-28: a continuable child has no run handle — `run` is undefined and
 * `continuable` records that the session can be woken instead of respawned. */
export type WorkerSpawnResult = {
    ok: true;
    sessionId: string;
    run: SubagentRun | undefined;
    controller: AbortController;
    continuable: boolean;
} | {
    ok: false;
    reason: 'unavailable';
} | {
    ok: false;
    reason: 'failed';
    errorMessage: string;
};
/** One reviewer-spawn outcome. The controller owns the request signal. */
export type ReviewSpawnResult = {
    spawned: true;
    reviewer: TicketAssignee;
    run: SubagentRun | undefined;
    controller: AbortController;
    continuable: boolean;
} | {
    spawned: false;
    reason: 'unavailable';
} | {
    spawned: false;
    reason: 'failed';
    errorMessage: string;
};
/** Tool payload: the card plus what happened to the review seat. */
export interface CompleteTicketResult {
    ticket: TicketView;
    review: 'spawned' | 'unavailable' | 'failed';
    reviewerAgentId: string | null;
}
/** Tool payload: the card plus what happened to the worker spawn. */
export interface AssignTicketResult {
    ticket: TicketView;
    worker: 'spawned' | 'unavailable' | 'failed';
    workerAgentId: string | null;
}
/**
 * Tool payload: the card plus what happened to the re-dispatch. `continued`
 * means the existing worker session was woken instead of re-spawned (V3-28).
 */
export interface ReassignTicketResult {
    ticket: TicketView;
    worker: 'spawned' | 'continued' | 'unavailable' | 'failed' | null;
    workerAgentId: string | null;
}
/** Tool payload: the card plus the followup/archive outcomes of a resolved review. */
export interface ResolveReviewResult {
    ticket: TicketView;
    action: 'approved' | 'rejected';
    /** reject: whether the original worker session received the rework feedback. */
    followup: 'sent' | 'unavailable' | 'none';
    /** approve: whether the worker session was archived by the host. */
    archived: boolean;
    /** reject: true when the third consecutive reject marked the card blocked. */
    blockedAfterReject: boolean;
}
/** Tool payload: the released board plus the generated handover notes. */
export interface HandoverResult {
    board: BoardView;
    /** The structured handover notes written onto the board's handoverNotes. */
    notes: string;
}
/** The compact row taskboard_list returns per ticket. */
export interface TicketRow {
    id: string;
    title: string;
    column: ColumnId;
    priority: Priority;
    boardId: string;
    type: TicketType;
    status: TicketWorkerStatus;
    workerAgentId: string | null;
    failure: TicketFailure | null;
    position: number;
    assignee: TicketAssignee | null;
    reviewer: TicketAssignee | null;
    reviewAttempts: number;
    lastReviewOutcome: 'approved' | 'rejected' | null;
    /** Declared file scope, for the master's parallel-safety judgment at dispatch. */
    filesScope: string;
    dependsOn: string[];
    /** Full-mode only (taskboard_list detail "full"): the card description. */
    description?: string;
    /** Full-mode only (taskboard_list detail "full"): the developer's completion notes. */
    devNotes?: string;
    /** Full-mode only (taskboard_list detail "full"): the pending review report. */
    reviewOutcome?: {
        verdict: string;
        summary: string;
        problems: string[];
    } | null;
}
/**
 * The taskboard service (ctx.taskboard): storage-backed tickets and boards,
 * the master seat, workflow transitions, the browser Remote surface, and the
 * model-facing tools.
 */
export declare class TaskboardService extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly resolved;
    private readonly domain;
    /**
     * One in-flight spawned run plus the abort controller owning its request
     * signal, keyed by ticket id (V3-16): the board-level pause verb aborts the
     * current worker's run through this handle, and every settle/close path
     * clears the entry so a settled or removed card never leaks a handle.
     */
    private readonly runHandles;
    constructor(ctx: Context, config?: Config);
    /** Resolve the opened tickets table. */
    private tickets;
    /**
     * Drop one card's run handle when its recorded run settles or the card
     * leaves the in-flight state. Identity-checked: a handle replaced by a
     * newer run for the same card (e.g. an auto-redispatched worker) survives
     * the older run's settlement.
     */
    private clearRunHandle;
    /** Resolve the opened boards table. */
    private boards;
    /**
     * The effective worker/reviewer model+effort for one board: the board's
     * modelConfig overrides the host config field by field, and a stored
     * effort outside the deepseek vocabulary falls back to the host config
     * (then to the adapter default). Board-level effort values are validated
     * here so a corrupted/out-of-band record degrades instead of failing.
     * @param boardId - the board whose spawns are being resolved.
     */
    private effectiveModelConfig;
    /**
     * Build the agentOptions for one spawned child: the model plus the
     * reasoning effort when one is configured. Callers only include this value
     * when the provider advertises the unified agentOptions capability (V3-5).
     * @param model - the effective model id.
     * @param effort - the effective effort level, or undefined for adapter default.
     */
    private static agentOptionsFor;
    /**
     * Record one effort capability downgrade on the card's history: a
     * configured reasoning effort was omitted because the spawn provider does
     * not advertise the effort capability, so the child keeps its adapter
     * default (the V3-12 "downgrade, never fail" pattern).
     * @param ticketId - the card whose spawn downgraded.
     * @param role - "worker" or "reviewer".
     * @param effort - the configured effort that was dropped.
     * @param providerName - the provider that cannot honor it.
     */
    private recordEffortDowngrade;
    /** Translate storage-layer failures into domain errors. */
    private static translate;
    /**
     * Run one validated record transform on the domain write chain, then emit
     * the forwarded change event with the committed post-state.
     */
    private mutate;
    /** Atomically transform one board record; a missing board fails loudly. */
    private mutateBoard;
    /**
     * Read one board record, lazily materializing the implicit record when the
     * board is absent (the "default" board always exists implicitly). An
     * unseeded materialization lands as a project-shaped unowned board: shared
     * among unowned sessions until the legacy default board is adopted by a
     * real workspace.
     */
    private ensureBoard;
    /**
     * Ensure the caller's session-private default board exists, materializing
     * it idempotently under the deterministic id "session-<sessionId>" on the
     * session's first board-surface access. The board is visible only to its
     * owner session; its name is the workspace directory basename when the
     * session resolves one, "session board" otherwise.
     * @param agent - the calling session agent.
     * @param workspace - the caller's resolved workspace, or undefined when unowned.
     * @returns the session's private default board.
     */
    private ensureSessionDefaultBoard;
    /**
     * Resolve the calling session's workspace from its header cwd through the
     * host workspace registry (resolveByPath). A missing registry, a missing
     * cwd, an unresolvable path, or any registry failure falls back to unowned
     * (undefined).
     * @param agent - the calling session agent.
     * @returns the resolved workspace id and canonical path, or undefined when unowned.
     */
    private workspaceOf;
    /**
     * Ensure the caller's default board exists, materializing it per workspace:
     * the first real-workspace access lazily adopts the legacy unowned "default"
     * board (renamed to the workspace directory basename); every later workspace
     * gets a deterministic "default-<workspaceId>" board with the same naming.
     * An unowned caller keeps the legacy implicit "default" board while it stays
     * unowned, and has no default board of its own once a real workspace adopted
     * it (undefined).
     * @param workspaceId - the caller's workspace id, or '' when unowned.
     * @param name - the directory basename to use for a materialized default board.
     * @returns the caller's default board, or undefined when the caller has none.
     */
    private ensureDefaultBoard;
    /**
     * Materialize one board for a master verb, seeding the implicit "default"
     * board with the caller's workspace when the record is absent. An unseeded
     * materialization would land as a project-shaped ''-workspace board that a
     * workspace session cannot see (TASKBOARD_BOARD_NOT_FOUND), breaking the
     * very next master verb after a fresh-store claim. An existing record is
     * returned untouched, so an adopted or v1 legacy default is never
     * re-stamped.
     * @param boardId - the board to ensure.
     * @param agent - the calling session agent; its workspace seeds a materialized 'default'.
     * @returns the ensured board record.
     */
    private ensureMasterBoard;
    /**
     * True when one board row is visible to a caller. Session-scoped boards are
     * private to their owner session; a session-scoped row WITHOUT an owner is
     * a v1-shaped legacy record and follows the v1 workspace rule (the unowned
     * legacy default is shared everywhere, workspace-tagged rows share within
     * that workspace). A stray ''-workspace legacy row that is NOT the default
     * board is visible to unowned callers only, so it never leaks into any real
     * workspace. Project-scoped boards are shared within their owning workspace
     * ('' matches unowned callers only, so a new unowned project board never
     * leaks into every workspace).
     * @param board - the board row to check.
     * @param sessionId - the caller's session id.
     * @param workspaceId - the caller's workspace id, or '' when unowned.
     */
    private isBoardVisible;
    /**
     * Require one board to be visible to a caller: a record-less board (the
     * implicit default or a legacy implicit board) is unowned and shared, and a
     * recorded board must be visible under the dual-scope rule (session boards
     * only to their owner, project boards only within their workspace). A board
     * outside the caller's scope is denied as not found so its existence is not
     * leaked.
     * @param boardId - the board to check.
     * @param agent - the calling session agent.
     */
    private assertBoardAccessible;
    /**
     * Validate the board context of one ticket operation: the requested board
     * must be the ticket's own board. An omitted request falls back to the
     * ticket's own board (v1 callers omit boardId and mean "the ticket's
     * board"), so a client that forgets the field never trips on a ticket
     * living on a non-default board; an explicit wrong board is still rejected.
     */
    private static boardContextOf;
    /** Whether the caller currently holds the master seat of the ticket's board. */
    private isMasterOfTicket;
    /** Require the caller to be the current master of the ticket's board. */
    private assertMasterOfTicket;
    /** Require the caller to be the current master of one board (by id). */
    private assertMasterOfBoard;
    /**
     * Compute the position of an index inside a column following the same
     * halving semantics as {@link positionBetween}: the target slot sits
     * between the (index-1)-th and the index-th neighbors of the column.
     */
    private positionAtIndex;
    /** Compute the position between two anchors inside a column. */
    private positionBetween;
    /** Validate the dependency edge set of one request against the live board. */
    private validateDependencies;
    /**
     * Whether the seam and the configured provider can establish a durable
     * continuable child (V3-28). The seam method is the service capability and
     * the provider's `prepareContinuable` (method presence) is the provider
     * capability — the same signal the service itself uses to admit a
     * continuable start. An unadvertised provider keeps the historic permissive
     * stance: an unregistered provider fails either start path.
     */
    private static supportsContinuable;
    /**
     * Start one child through the subagent seam, preferring the continuable path
     * (V3-28): startContinuable establishes a durable child session that can be
     * woken after a disconnect or restart instead of being re-spawned with an
     * empty context. Providers that cannot establish continuable children keep
     * the historic one-shot start().
     *
     * The continuable spec deliberately omits label/signal/outputSchema: the
     * manager persists the label from the spec, owns the child's own signal, and
     * structured output is a one-shot-only capability (subagent descriptor.ts),
     * so a single request object can never carry both contracts.
     * @param subagents - the resolved subagent seam.
     * @param providerName - the provider for this child.
     * @param request - the one-shot-shaped delegation request.
     * @returns the child session id, the one-shot run handle when there is one,
     *   and whether the child is continuable.
     */
    private startChild;
    /**
     * Spawn the reviewer child for one ticket through the subagent seam. In
     * "report" mode the child only inspects and returns a structured verdict
     * ({ verdict, summary, problems }) — it is denied the card-mutating review
     * tools and the master resolves the review with taskboard_resolve_review.
     * In "direct" mode the v1 contract holds: the reviewer itself calls
     * taskboard_approve / taskboard_reject.
     */
    private spawnReviewer;
    /**
     * Attach the reviewer-run settlement listener: when the report-mode child
     * settles with a structured verdict, write it back onto the card. Only the
     * reviewer the card currently names may write; the run never rejects (a
     * model error resolves with stopReason "error"), so the rejection arm is a
     * defensive no-op.
     */
    private trackReviewerRun;
    /** Persist the structured reviewer report when the settled run produced one. */
    private recordReviewOutcome;
    /**
     * Land one reviewer-reported verdict on the card and notify the master. The
     * two report channels converge here: the one-shot structured-output capture
     * (the settled run's `structured` value) and, for a continuable reviewer
     * (V3-28), the taskboard_review_verdict tool the reviewer itself calls.
     * Identity checked either way: only the reviewer the card currently names,
     * while the card is still In testing, can land a verdict.
     */
    private landReviewOutcome;
    /**
     * Report one reviewer verdict from a continuable reviewer session (V3-28).
     * A durable reviewer child cannot carry an outputSchema — structured output
     * is a one-shot-only subagent capability — so instead of the
     * structured-output capture it calls the taskboard_review_verdict tool,
     * which lands the same { verdict, summary, problems } report through the one
     * landing path. The reviewer still never decides the card: the master
     * resolves it with taskboard_resolve_review.
     * @param agent - the reviewer session agent.
     * @param ticketId - the In testing ticket under review.
     * @param verdict - 'approve' or 'reject'.
     * @param summary - what the reviewer inspected and concluded.
     * @param problems - concrete rework items (empty when approving).
     * @returns the card with reviewOutcome recorded.
     */
    submitReviewVerdict(agent: Agent, ticketId: string, verdict: 'approve' | 'reject', summary: string, problems: readonly string[]): Promise<TicketView>;
    /**
     * Follow up the original worker after a rejection (打回原窗口). The worker
     * is addressed through the live Agent registry. This is best-effort: when
     * the session is no longer live the master re-dispatches with
     * taskboard_reassign.
     */
    private followupWorker;
    /**
     * Best-effort worker-session archive when a card lands in Done: the host's
     * workspace registry hides archived sessions from the grouping surfaces. A
     * missing registry, an unknown session, or a storage fault is not an error
     * — the resolution still succeeds and the result reports archived=false.
     */
    private archiveWorkerSession;
    /**
     * Spawn the worker child for one ticket and attach termination
     * reclamation to its run result.
     * @param parent - the master session agent the child spawns under.
     * @param ticket - the card being dispatched.
     * @param workerLabel - optional display label for the worker child.
     * @param preflight - the V3-20 dispatch-time preflight report; when present
     * its raw facts (canonical base, assigned worktree, actual branch, HEAD,
     * dirty list, base/candidate relationship) are inlined into the worker
     * prompt so the worker starts from deterministic facts. Auto-redispatch
     * (liveness recovery) passes none — its working tree is dirty by design.
     */
    private spawnWorker;
    /**
     * Reclaim a card whose worker session settled without reporting: the card
     * is still In progress and still owned by that session, so the worker was
     * terminated mid-flight.
     */
    private trackWorkerRun;
    /** Mark a card blocked when its worker session ended without reporting. */
    private reclaimTerminatedWorker;
    /**
     * The durable failure reason the worker-liveness reconciliation records
     * when a lost worker cannot be auto-redispatched, distinct from the
     * settlement-callback reason ('worker terminated (<stopReason>)') so the
     * two reclaim paths never double-report one termination with two different
     * reasons.
     */
    private static readonly RECONCILE_REASON;
    /**
     * The last observed activity of one live agent: the timestamp of its last
     * session event, falling back to the session creation time when the log is
     * empty. The session event log is the durable activity authority — a worker
     * appends a row on every turn/tool activity, so a session whose tail is
     * older than the idle threshold has genuinely been silent, not merely idle
     * between turns.
     */
    private static lastActivityOf;
    /**
     * Judge one running card's worker liveness: 'lost' when the session is
     * absent from the registry (restart / hard death) or when it is still
     * registered but idle — no running tool — and has had no session activity
     * for longer than lostWorkerTimeoutMs (stuck). 'alive' otherwise. The
     * idle-staleness arm is disabled when the timeout is 0; the
     * registry-absence arm is not configurable (a missing session is always
     * lost, per the restart rule).
     */
    private workerLost;
    /**
     * The live agent registry, or undefined when the host exposes none. The
     * registry is the liveness authority for every seat: presence means alive
     * (an idle agent is still alive; only an unregistered session is gone).
     */
    private agentRegistry;
    /**
     * Judge whether one session still holds its seat — the single liveness
     * judgment shared by the master seat and the reviewer seat (V3-43): a seat
     * is held while its holder session exists anywhere. (1) A session present in
     * the live agent registry is alive, whatever the store says. (2) Otherwise
     * the host's own session persistence is the authority — the canonical "does
     * this session exist" query (stat/session-reference shape), never a clock, a
     * poll, or a cache of our own — and only a definite `undefined` answer
     * proves the record is gone, i.e. the session was deleted or cleaned up.
     *
     * Registry absence is therefore never a release on its own: a session the
     * host merely unloaded from its live registry (a host restart, idle
     * eviction) still has its stored session log, so it keeps the seat and
     * resumes its work on its next turn. That includes a report-mode reviewer,
     * which is a durable continuable child normally sitting in the session store
     * rather than the live registry — judging that normal state as death was the
     * V3-42 release/redispatch loop. Seat ownership follows the *session*, not
     * the process and not a clock (V3-32 keeps the wall-clock arm deleted): an
     * idle registered holder still keeps the seat however silent it is.
     *
     * The judgment fails closed (the seat counts as held) without a registry,
     * without a persistence seam able to answer the existence question, or when
     * the probe itself faults — none of those can prove the record is gone.
     * @param sessionId - the seat holder's session id.
     * @returns whether the holder session still exists (true keeps the seat).
     */
    private sessionHoldsSeat;
    /**
     * Wake one lost worker's durable session instead of re-spawning it (V3-28).
     * The continuation message carries the ticket identity, the acceptance
     * criteria, the recorded progress and the standing "do not roll back"
     * instruction, and sendMessage delivers it to the exact child session the
     * card records: a running child admits it at the nearest step boundary, an
     * idle child starts a turn, and an absent child cold-resumes from
     * persistence.
     *
     * The sender is the live master Agent (`board.masterAgentId` from the
     * registry) — sendMessage requires an exact live direct parent, but not a
     * master *turn*, so the automatic recovery path can wake without one.
     * Fail-closed: every refusal (no seam method, no live master, a worker
     * dispatched before V3-28 whose session carries no continuation state, or a
     * provider that cannot resume) is returned as a detail so the caller falls
     * back to the historic re-spawn.
     * @returns woken once the message was accepted by the child's inbox.
     */
    private wakeWorker;
    /**
     * One lost-worker recovery: auto-redispatch a fresh worker while the
     * per-card budget lasts and a live master session exists to spawn from,
     * otherwise mark the card blocked. Shared by the settlement callback
     * (mid-flight death) and the liveness reconciliation (registry-absent or
     * idle-stale) so both paths converge on one deduped recovery.
     *
     * Auto-redispatch keeps the card running with a new worker session, clears
     * the failure record, appends the "续做勿回滚" annotation to the card
     * description (the next worker's prompt inlines it, so it continues the
     * existing working tree instead of rolling back), writes one 'reassign'
     * history row and notifies the master. Blocking writes one 'fail' row and
     * notifies the master that manual taskboard_reassign is needed.
     *
     * Reentry-safe: the guarded mutate re-checks column/status/worker identity
     * atomically, so a card another path already recovered is returned
     * untouched and exactly one recovery ever lands per loss.
     * V3-28: before spending a fresh spawn the recovery tries to WAKE the
     * durable worker session (see {@link wakeWorker}). A successful wake keeps
     * the card running with the same worker session — its context and working
     * tree survive — and only a refusal falls through to the re-spawn below.
     * @returns 'continued' | 'redispatched' | 'blocked' | 'skipped'
     */
    private recoverLostWorker;
    /**
     * Terminal lost-worker recovery: mark the card blocked with one durable
     * failure row and a master notice (the V3-13 fallback when auto-redispatch
     * is impossible or the per-card budget is exhausted). Reentry-safe like
     * {@link recoverLostWorker}: the guarded mutate only applies to a card that
     * still names the same worker session and is still running.
     */
    private blockLostWorker;
    /**
     * One worker-liveness reconciliation pass: every In progress/running card
     * whose worker is lost — absent from the live agent registry (restart /
     * hard death) or registered but idle with no activity past the configured
     * timeout — is recovered through {@link recoverLostWorker}: auto-redispatch
     * while the per-card budget lasts, block with a master notice once
     * exhausted. Shared by the startup scan and the periodic scanner.
     *
     * Liveness authority research (service dependency surface): the agent
     * registry is the exact "is this session's agent alive right now" authority
     * — agents.get(id) returns the live Agent or undefined; presence means
     * live (an idle agent is still alive, only an unregistered session is
     * lost), which is precisely the restart scenario where the in-memory run
     * settlement callbacks are gone. The session event log supplies the
     * activity tail for the idle-staleness arm. The subagent seam's
     * listChildren / listDescendants are parent-rooted tree listings that
     * throw without a mounted projection registry + session store, and the
     * session store tracks persisted sessions rather than live agent loops —
     * neither is a general flat liveness probe, so the registry is used
     * directly, and a missing registry (never in the host, where 'agents' is
     * an injected dependency) degrades to a silent skip without blocking
     * anything.
     *
     * Idempotent by construction and coexistent with the settlement callback:
     * only running cards are considered, and the guarded recovery re-checks
     * column/status/worker identity atomically on the committed record, so a
     * card the settlement callback already recovered (or whose worker came
     * back) is returned untouched — exactly one recovery ever lands per card.
     * @returns how many cards this pass recovered (redispatched or blocked).
     */
    reconcileLostWorkers(): Promise<number>;
    /**
     * One reviewer-staleness reconciliation pass: every In testing card that
     * still has a review seat but no reviewOutcome is judged by the *shared*
     * session-liveness rule (V3-43, {@link sessionHoldsSeat} — the same judgment
     * the master seat uses) plus the review-start clock:
     * - the seat is lost only when the holder session is gone for good — absent
     *   from the live agent registry *and* holding no stored session record.
     *   Registry absence alone releases nothing: a report-mode reviewer is a
     *   durable continuable child that normally lives in the session store
     *   (ready) rather than the live registry, and the old registry-only reading
     *   of that normal state as death was the V3-42 release/redispatch loop;
     * - a reviewer that is *registered* but idle — no running tool — with the
     *   review pending longer than reviewerStaleTimeoutMs is judged stuck and
     *   the seat is released. Staleness never applies to a holder that is only
     *   stored (there is no live session to judge idle).
     * On release the card history gets one 'review-release' row, the master is
     * notified, and a fresh reviewer is auto-redispatched when a live master
     * session exists to spawn from; otherwise the seat is left vacant so
     * taskboard_claim_review can take it.
     *
     * Loop brake (V3-43): the release/redispatch cycle is capped per card at
     * reviewerAutoRetryLimit, mirroring the worker's workerAutoRetryLimit. Once
     * the budget is spent the seat is still released, but instead of spawning
     * yet another reviewer the card is blocked with the concrete reason and a
     * master notice — so no future liveness fault can turn into an unbounded
     * release/redispatch loop.
     *
     * Reentry-safe: the guarded mutate only releases a seat that still names
     * the same reviewer and is still In testing without an outcome, so a card
     * another path already released (or resolved) is returned untouched.
     * @returns how many seats this pass released.
     */
    reconcileStaleReviewers(): Promise<number>;
    /**
     * One master-seat liveness pass (V3-25, revised by V3-32 and V3-34): every
     * board whose seat names a session that is gone for good is released. Seat
     * ownership follows the session, not the process: a holder merely absent
     * from the live agent registry (host restart, idle eviction) but still
     * carrying a stored session record keeps the seat and is never released —
     * the reported "master keeps dropping" fault. Only a holder that has left
     * the registry *and* has no stored record (the session was deleted or
     * cleaned up) is released. A registered holder keeps the seat however long
     * it stays silent: silence is not death, and a master that ends its turn
     * after dispatching and waits for a notice must not be evicted for it.
     *
     * A release changes seat ownership only: in-flight cards keep their workers
     * and reviewers untouched, and no card is ever re-dispatched by this pass.
     * The board gets one masterHistory row (empty target = vacant seat) and a
     * durable notice the successor reads back from taskboard_claim_master /
     * taskboard_notices; taskboard_handover remains the explicit takeover path
     * while the holder is still alive.
     *
     * Reentry-safe: the guarded release only clears the seat that still names
     * the judged holder, so concurrent passes release each board exactly once.
     * @returns how many seats this pass released.
     */
    reconcileMasterSeats(): Promise<number>;
    /**
     * Release one board's lost master seat: clear the seat, append one
     * master-history row naming the released holder with an empty target (the
     * seat is vacant), and land the durable successor notice. Reentry-safe: the
     * guarded board update only clears the seat that still names the judged
     * holder, so a seat another path already released (or handed over) is
     * returned untouched and exactly one release lands per loss.
     * @param boardId - the board whose seat is released.
     * @param holderAgentId - the judged-lost holder session id.
     * @param reason - the concrete release reason recorded in history/notice.
     * @returns whether this call performed the release.
     */
    private releaseLostMasterSeat;
    /**
     * Record the durable successor-facing notice for one released master seat.
     * Recorded on the board synchronously (the in-board fallback), so the next
     * taskboard_claim_master / taskboard_notices read carries it even when no
     * live or persisted inbox can be reached; a vacant seat makes live delivery
     * a no-op by construction. Best-effort: a notice fault never fails the
     * release that triggered it.
     * @param boardId - the board whose seat was released.
     * @param holderAgentId - the lost holder session id.
     * @param reason - the concrete release reason.
     */
    private recordMasterRelease;
    /**
     * Attach the designated reviewer to an In testing ticket.
     * @param ticketId - the In testing card to seat.
     * @param reviewer - the reviewer identity taking the seat.
     * @param detail - the 'review-claim' history detail.
     * @param resetRetries - V3-43: clear the card's automatic reviewer
     *   redispatch budget (default true — a deliberate reseat starts a fresh
     *   review round: a worker's completion/report, a master's request or a
     *   manual claim). The reviewer-staleness reconciliation passes false so its
     *   own release/redispatch budget keeps accumulating until the cap blocks
     *   the card.
     */
    private attachReviewer;
    /**
     * Record the real reviewer-spawn failure on the card history. Uses the
     * free-form 'edit' change (no reviewer invariant) so the failure note lands
     * on the card without claiming a review seat.
     */
    private recordReviewerSpawnFailure;
    /**
     * One move with reviewer automation when the target is In testing. The
     * origin distinguishes the user-facing move (Remote 'move', the web UI
     * drag) from the master's own taskboard_move tool: only a user-origin move
     * into Not started wakes the master with the user-scheduled notice, so the
     * master never notifies itself about its own scheduling.
     */
    private moveWithReviewer;
    /**
     * Notify the board's master that the user scheduled one card into Not
     * started (a user-origin move), so it adjudicates whether to dispatch:
     * every dependency Done → taskboard_assign; otherwise
     * the master tells the user the refusal reason and records it on the card.
     * Reuses the durable master-notice channel (board notice + live inbox /
     * persisted inbox delivery); best-effort like every master notice, so a
     * notification fault never fails the move itself.
     */
    private notifyUserScheduled;
    /**
     * Whole-board snapshot, sorted by column then position, scoped to one
     * board the caller may see: its own session-private boards plus its
     * workspace's project boards and the unowned legacy ones. A board outside
     * the caller's scope is denied as not found so its existence is not leaked.
     * @param agent - the calling session agent; its session and workspace scope the board.
     * @param boardId - the board to snapshot, or undefined for the caller's default board.
     * @returns the live board snapshot.
     */
    snapshot(agent: Agent, boardId?: string): Promise<BoardSnapshot>;
    private openTable;
    /**
     * List every board the caller may see: its session-private boards (scope
     * 'session' owned by this session), its workspace's project boards (scope
     * 'project' with a matching workspaceId), and the unowned legacy default
     * board awaiting adoption. Boards outside those scopes never appear, so a
     * foreign session-private board or a cross-workspace project board is not
     * leaked. The implicit unowned "default" board row is reported first when
     * no record exists for it yet (v1 compatibility).
     * @param agent - the calling session agent; its session and workspace scope the listing.
     * @returns the visible board rows.
     */
    listBoards(agent: Agent): Promise<BoardView[]>;
    /**
     * Create one board through the Remote boundary. A 'project' scope stamps
     * the board with the caller's workspace ('' when unowned) and shares it
     * with every session of that workspace; the default 'session' scope records
     * the creating session as the owner and keeps the board private to it. The
     * boardId is always a fresh unique id; any workspaceId in the request is
     * ignored. An unowned caller (no resolvable cwd) is forced into 'session'
     * scope regardless of the request: a 'project' request from an unowned
     * session would otherwise mint a workspaceId-'' board shared with every
     * unowned session (the unowned leak).
     * @param agent - the calling session agent; it owns session boards and its workspace owns project boards.
     * @param request - the board name and visibility scope.
     * @returns the created board.
     */
    createBoardRemote(agent: Agent, request: CreateBoardRequest): Promise<BoardView>;
    /**
     * Archive one board through the Remote boundary. A board the caller cannot
     * see is denied as not found (no existence leak).
     * @param agent - the calling session agent.
     * @param request - the board to archive.
     * @returns the archived board.
     */
    archiveBoardRemote(agent: Agent, request: ArchiveBoardRequest): Promise<BoardView>;
    /**
     * Write the board-level worker/reviewer model+effort overrides (V3-5,
     * master only). Omitted patch fields keep the current board overrides; an
     * empty string clears one override so the host config governs again.
     * Effort values must be a deepseek level (off/high/max) or empty; anything
     * else is rejected loudly so the master sees the mistake instead of a
     * silent fallback.
     * @param agent - the board's current master.
     * @param boardId - the board to configure.
     * @param patch - the overrides to apply field by field.
     * @returns the updated board.
     */
    private setBoardModelConfig;
    /**
     * Create one ticket in Backlog through the Remote boundary. The target
     * board must be visible to the caller; an invisible board is denied as not
     * found (no existence leak).
     * @param agent - the calling session agent.
     * @param request - title, description, priority, ordering dependencies, and optional boardId.
     * @returns the created ticket.
     */
    createRemote(agent: Agent, request: CreateTicketRequest): Promise<TicketView>;
    /**
     * Shared Backlog creation used by the Remote surface and the master-only
     * taskboard_create tool. The Remote surface leaves type/targetBranch at
     * their defaults; the master tool supplies them explicitly.
     */
    private createRecordForBoard;
    /** Persist a fresh backlog record after dependency validation. */
    private createRecord;
    /**
     * Move one ticket through the Remote boundary; entering In testing also
     * assigns a fresh reviewer through the subagent seam.
     * @param agent - the session agent driving the move (reviewer parent).
     * @param request - target column and optional position anchors.
     * @returns the moved ticket.
     */
    moveRemote(agent: Agent, request: MoveTicketRequest): Promise<TicketView>;
    /**
     * Edit one ticket through the Remote boundary. The ticket's board must be
     * visible to the caller; an invisible board is denied as not found (no
     * existence leak).
     * @param agent - the calling session agent.
     * @param request - replacement content and dependency edges.
     * @returns the edited ticket.
     */
    editRemote(agent: Agent, request: EditTicketRequest): Promise<TicketView>;
    /**
     * Remove one ticket through the Remote boundary. The ticket's board must be
     * visible to the caller; an invisible board is denied as not found (no
     * existence leak).
     * @param agent - the calling session agent.
     * @param request - the ticket to remove.
     * @returns the removal receipt.
     */
    removeRemote(agent: Agent, request: RemoveTicketRequest): Promise<RemoveTicketResult>;
    /**
     * (Re)assign a reviewer for one In testing ticket through the Remote
     * boundary.
     * @param agent - the session agent spawning the reviewer child.
     * @param request - the In testing ticket to review.
     * @returns the ticket with its fresh reviewer attached.
     */
    requestReviewRemote(agent: Agent, request: RequestReviewRequest): Promise<TicketView>;
    /**
     * Claim the master seat of one board. V3-25/V3-34: the seat is no longer
     * leased by a wall clock and no longer follows the process either — only a
     * holder session that is gone for good (absent from the live agent registry
     * *and* holding no stored session record) is preempted here, so the
     * successor takes a genuinely vacant seat immediately; a holder the host
     * merely restarted or unloaded still owns it. A preemption leaves a
     * masterHistory row plus a durable board notice the claimant reads back from
     * this claim. A board the caller cannot see is denied as not found (no
     * existence leak), so the master seat of a foreign session-private board
     * cannot be seized.
     *
     * The liveness judgment runs before the (synchronous) board updater because
     * the stored-record probe is asynchronous; the updater then re-checks that
     * the judged holder is still the one on the row, and a seat that changed
     * hands in between fails closed as held rather than preempted on stale
     * evidence.
     * @param boardId - the board to claim.
     * @param agent - the claiming session agent.
     * @returns the board with its fresh master.
     */
    claimMaster(boardId: string, agent: Agent): Promise<BoardView>;
    /**
     * Release the master seat of one board; only the current master may. A
     * board the caller cannot see is denied as not found (no existence leak).
     * @param boardId - the board to release.
     * @param agent - the current master.
     * @returns the board with an empty seat.
     */
    releaseMaster(boardId: string, agent: Agent): Promise<BoardView>;
    /**
     * Require the caller to be a top-level session agent, not a spawned
     * subagent child. Master verbs that dispatch workers must run in the
     * master's own session so the spawned worker's parent lineage stays the
     * top-level session (the three-layer hierarchy: master -> worker ->
     * reviewer). A subagent child carries an origin/delegationDepth in its
     * session header; top-level sessions carry neither.
     * @param agent - the calling session agent.
     */
    private static assertRootSession;
    /**
     * Hand over the master seat (master only): generate the structured handover
     * notes — every card's status, each in-flight worker identity, the In
     * testing review seats, the backlog summary, and the master history —
     * write them onto the board's handoverNotes, and release the seat. The
     * successor claims the seat with taskboard_claim_master, whose result
     * carries the notes.
     * @param boardId - the board to hand over.
     * @param agent - the current master.
     * @returns the released board plus the generated notes.
     */
    handover(boardId: string, agent: Agent): Promise<HandoverResult>;
    /**
     * Notify the board's master about one workflow event. Three layers, in
     * order of durability:
     * 1. A durable in-board notice ({kind, text, at, ticketId}) is recorded
     *    synchronously on the board — the master reads it back through
     *    taskboard_claim_master / taskboard_notices even when every delivery
     *    path fails.
     * 2. Live inbox injection when the master session is in the agent registry
     *    (master.followup, the goal-round driver's inbox-injection precedent):
     *    the loop claims the message as ordinary input and acts on it — no
     *    board polling.
     * 3. Persistent inbox delivery when the master is NOT live (e.g. after a
     *    restart the session is absent from the runtime registry): the notice
     *    is appended as an 'agent/inbox/spliced' event to the master's
     *    persisted session log through ctx.sessionPersistence, so the master's
     *    next load/resume replays it as new input (the agent-loop Inbox
     *    rebuilds its pending projection from exactly those events).
     * Same board + ticket + event kind inside the dedupe window records nothing
     * and delivers nothing. Best-effort by design: a vacant seat, an absent
     * registry/persistence backend, or any delivery fault never fails the
     * triggering mutation.
     * @param boardId - the board whose master receives the notice.
     * @param text - the notice text (what happened and what to do next).
     * @param kind - the stable event kind (dedupe key part, e.g. "worker-done").
     * @param ticketId - the ticket the notice refers to (dedupe key part; '' for board-wide notices).
     */
    private notifyMaster;
    /** Record one durable in-board notice; false when deduped or the board vanished. */
    private recordBoardNotice;
    /** Deliver one notice into the master's inbox: live followup, else a persistent inbox splice. */
    private deliverInbox;
    /**
     * Transfer the master seat to another session agent with handover notes.
     * A board the caller cannot see is denied as not found (no existence leak).
     * @param boardId - the board to transfer.
     * @param fromAgent - the current master.
     * @param toAgentId - the receiving session agent id.
     * @param handoverNotes - notes for the next master.
     * @returns the board with the new master.
     */
    transferMaster(boardId: string, fromAgent: Agent, toAgentId: string, handoverNotes: string): Promise<BoardView>;
    /**
     * V3-20: resolve a configured repo from one absolute path, from
     * configuration only (never guessed): the configured preflight repo root
     * that prefixes the path wins (longest match).
     * @param path - the absolute path to locate (a master cwd or a declared scope entry).
     * @returns the matched repo root and its preflight contract, or null when no configured root governs the path.
     */
    private resolvePreflightRepo;
    /**
     * V3-26: locate the repo one card dispatches against, preferring the card's
     * own declared filesScope over the master session cwd. The first declared
     * scope entry that lands inside a configured repo root wins (longest-prefix
     * match; a relative entry names nothing on its own and is skipped). Only
     * when no entry lands anywhere does the master cwd fall back to the
     * pre-V3-26 resolution, so a master started from an unmapped directory no
     * longer rejects cards whose declared scope is governed. When that fallback
     * is what located the repo, the caller names it in the report rather than
     * letting the card masquerade as scope-located (V3-33); V3-41 widens that
     * naming to a scope whose absolute entries all miss every configured root,
     * so a miss is judged per entry rather than by the scope's shape.
     * @param filesScope - the card's declared file scope.
     * @param cwd - the master session cwd, used only as a fallback.
     * @returns the matched root + contract, or null when neither the scope nor the cwd locates a repo.
     */
    private locatePreflightRepo;
    /**
     * V3-20: other in-flight (In progress, running) cards of the same board,
     * for the cross-card file-scope conflict check.
     * @param ticket - the card being dispatched.
     * @returns the in-flight cards' id + declared scope.
     */
    private inFlightScopes;
    /**
     * V3-20/V3-26: run the deterministic repo/worktree preflight for one
     * dispatch, computed fresh at dispatch time (never cached). The card's
     * declared filesScope locates the repo first (V3-26); the master session
     * cwd is only the fallback. Returns null when preflight is not enabled (no
     * configured repos — legacy dispatch path); otherwise always a report, and
     * a safe=false report carries the concrete violations the caller must fail
     * the dispatch with (fail closed). A filesScope that is non-empty yet no
     * entry of which lands in a configured repo root is named as a violation
     * whenever the cwd fallback is what located the repo — no absolute entry at
     * all (V3-33), or absolute entries that all miss every configured root
     * (V3-41) — so the fallback is never silent.
     * @param ticket - the card being dispatched.
     * @param agent - the master session agent (its cwd is the fallback workspace repo).
     * @returns the preflight outcome, or null when preflight is disabled.
     */
    private preflightDispatch;
    /**
     * V3-20: land one preflight-blocked dispatch: the card is marked blocked
     * with the concrete violations as its failure reason (never a worker
     * spawn), and the master is notified.
     * @param running - the card in its In progress/running post-assign state.
     * @param report - the failing preflight report.
     * @returns the blocked card.
     */
    private blockPreflight;
    /**
     * Master assigns a Backlog or Not started ticket to a freshly spawned
     * worker: the card moves to In progress, status running, and a worker
     * subagent is spawned immediately; on success its id is recorded on the
     * card. Not started remains the scheduling display for the next queue,
     * but a card needs no move before dispatch — assign accepts it straight
     * from Backlog (V3-6 relaxation).
     * @param agent - the master session agent.
     * @param ticketId - the Backlog or Not started ticket to dispatch.
     * @param workerLabel - optional display label for the worker child.
     * @returns the card plus the worker-spawn outcome.
     */
    assign(agent: Agent, ticketId: string, workerLabel?: string): Promise<AssignTicketResult>;
    /**
     * The assigned worker reports development done; the ticket enters In
     * testing and a reviewer (same worker model) is spawned.
     * @param agent - the assigned worker session agent.
     * @param ticketId - the owned In progress ticket.
     * @param devNotes - what changed and how it was verified.
     * @returns the In testing ticket plus the reviewer-spawn outcome.
     */
    report(agent: Agent, ticketId: string, devNotes: string): Promise<CompleteTicketResult>;
    /**
     * The assigned worker reports failure; the card stays In progress but is
     * marked blocked with a durable failure record.
     * @param agent - the assigned worker session agent.
     * @param ticketId - the owned In progress ticket.
     * @param reason - the concrete failure reason.
     * @returns the blocked ticket.
     */
    fail(agent: Agent, ticketId: string, reason: string): Promise<TicketView>;
    /**
     * Master re-dispatches one card: "retry" spawns a fresh worker (card back
     * to running, failure cleared), "backlog" returns the card to Not started,
     * and "continue" (V3-28) wakes the card's existing worker session instead of
     * spawning a replacement — the manual entry into the same wake path the
     * automatic recovery uses for a running, blocked, or paused card. A refused
     * wake (no continuation state, dead session, no seam) degrades to the
     * historic fresh spawn, so "continue" never leaves the card without a
     * worker.
     * @param agent - the master session agent.
     * @param ticketId - the In progress card to re-dispatch.
     * @param action - retry, backlog, or continue.
     * @param workerLabel - optional display label for a retry worker.
     * @returns the re-dispatched card plus the worker-spawn outcome.
     */
    reassign(agent: Agent, ticketId: string, action: 'retry' | 'backlog' | 'continue', workerLabel?: string): Promise<ReassignTicketResult>;
    /**
     * Master pauses one In progress/running card (taskboard_pause): the
     * in-flight worker run is aborted through the card's recorded handle, the
     * card status flips to 'paused' (column unchanged, one 'pause' history row
     * naming the pauser and the reason), and the master is notified. A paused
     * card is never marked blocked: the settlement callback and the
     * worker-liveness reconciliation only ever act on status 'running', so the
     * paused status alone keeps the card out of V3-13/V3-9 reclamation. Resume
     * with taskboard_reassign action "retry", which clears the paused status
     * and spawns a fresh worker.
     * @param agent - the master session agent.
     * @param ticketId - the In progress card whose worker to pause.
     * @param reason - why the master pauses the card (recorded in history).
     * @returns the paused card.
     */
    pause(agent: Agent, ticketId: string, reason: string): Promise<TicketView>;
    /**
     * Master records a new ticket on a board's Backlog (the discussion
     * whiteboard: the plan the master agreed with the user is written down).
     * Unlike the Remote create surface, the master tool also sets the ticket
     * type and may target any board the caller masters.
     * @param agent - the master session agent.
     * @param request - title, description, type, priority, dependencies, boardId and optional targetBranch.
     * @returns the created Backlog ticket.
     */
    createAsMaster(agent: Agent, request: CreateTicketRequest & {
        type?: TicketType;
        targetBranch?: string;
    }): Promise<TicketView>;
    /**
     * Master schedules a ticket to another column, optionally next to an
     * anchor; entering In testing still auto-assigns a fresh reviewer. The
     * caller must hold the master seat of the ticket's board.
     * @param agent - the master session agent.
     * @param request - target column and optional position anchors.
     * @returns the moved ticket.
     */
    moveAsMaster(agent: Agent, request: MoveTicketRequest): Promise<TicketView>;
    /**
     * Master adjusts the planning attributes of one ticket: dependency edges,
     * priority, and ordering position inside the ticket's column. Dependencies
     * are validated against the live board; position is an index in the column
     * ordering (halving semantics, like an anchor move).
     * @param agent - the master session agent.
     * @param ticketId - the ticket to plan.
     * @param dependsOn - replacement dependency edges, or undefined to keep them.
     * @param priority - replacement priority, or undefined to keep it.
     * @param position - the desired index in the ticket's column, or undefined to keep it.
     * @returns the planned ticket.
     */
    planAsMaster(agent: Agent, ticketId: string, dependsOn: string[] | undefined, priority: Priority | undefined, position: number | undefined): Promise<TicketView>;
    /**
     * Master claims a Not started ticket and schedules it to In progress.
     * V3-7 closes the free claim: under the dispatch system only the master
     * of the ticket's board may claim — workers and reviewers receive cards
     * through taskboard_assign (dispatch) or taskboard_reassign (re-dispatch),
     * never by claiming. The caller must hold the master seat.
     * @param agent - the master session agent.
     * @param ticketId - the Not started ticket to claim.
     * @returns the claimed ticket, now In progress.
     */
    claim(agent: Agent, ticketId: string): Promise<TicketView>;
    /**
     * Agent takes the empty review seat of one In testing ticket.
     * @param agent - the reviewing agent.
     * @param ticketId - the In testing ticket with no reviewer.
     * @returns the ticket with the reviewer attached.
     */
    claimReview(agent: Agent, ticketId: string): Promise<TicketView>;
    /**
     * Owner marks development done; the ticket enters In testing and gets a
     * reviewer (v1 path).
     * @param agent - the owning developer agent.
     * @param ticketId - the owned In progress ticket.
     * @param devNotes - what changed and how it was verified.
     * @returns the In testing ticket plus the reviewer-spawn outcome.
     */
    complete(agent: Agent, ticketId: string, devNotes: string): Promise<CompleteTicketResult>;
    /**
     * The designated reviewer approves; the ticket lands in Done.
     * @param agent - the designated reviewer agent.
     * @param ticketId - the In testing ticket under review.
     * @param summary - what was inspected and why it passes.
     * @returns the approved Done ticket.
     */
    approve(agent: Agent, ticketId: string, summary: string): Promise<TicketView>;
    /**
     * The designated reviewer rejects; the ticket is returned for rework.
     * @param agent - the designated reviewer agent.
     * @param ticketId - the In testing ticket under review.
     * @param feedback - concrete, actionable rework feedback.
     * @returns the rejected ticket, back In progress.
     */
    reject(agent: Agent, ticketId: string, feedback: string): Promise<TicketView>;
    /**
     * The master resolves a report-mode review against the reviewer-reported
     * verdict (taskboard_resolve_review). Approve lands the card in Done and
     * archives the worker session; reject returns the card for rework, tries to
     * follow up the original worker, and marks the card blocked on the third
     * consecutive reject for the user to decide. The master may not overturn a
     * rejection into an approval — the verdict is applied as reported.
     * @param agent - the master session agent.
     * @param ticketId - the In testing ticket under review.
     * @param verdict - the reviewer-reported conclusion to apply.
     * @param summary - what the reviewer inspected and concluded.
     * @param problems - concrete rework items (empty on approval).
     * @returns the resolved card plus the followup/archive outcomes.
     */
    resolveReview(agent: Agent, ticketId: string, verdict: string, summary: string, problems: string[]): Promise<ResolveReviewResult>;
    /**
     * Route one model-facing card edit (taskboard_update). The master of the
     * ticket's board may correct planning metadata on ANY card of that board
     * (Backlog through In testing, including cards already dispatched to someone
     * else) — title, description, filesScope and devNotes — and every such call
     * appends one history row naming the master and each changed field's old ->
     * new summary; a call that changes nothing records that too, so a master
     * correction is never silent. Every other caller keeps the pre-V3-40
     * assignee-only rule unchanged (TASKBOARD_NOT_OWNER), and only the master may
     * widen a card's filesScope (TASKBOARD_NOT_MASTER), so the worker-side
     * ownership semantics are untouched.
     * @param agent - the calling session agent.
     * @param ticketId - the card to edit.
     * @param edit - replacement fields; omitted fields stay unchanged.
     * @returns the updated ticket.
     */
    private updateTicket;
    /**
     * Edit own-ticket content through the model-facing surface.
     * @param agent - the owning developer agent.
     * @param ticketId - the owned ticket.
     * @param title - replacement title, or undefined to keep it.
     * @param description - replacement description, or undefined to keep it.
     * @param devNotes - replacement notes, or undefined to keep them.
     * @returns the updated ticket.
     */
    updateOwn(agent: Agent, ticketId: string, title: string | undefined, description: string | undefined, devNotes: string | undefined): Promise<TicketView>;
    /**
     * Whole-board rows for the model, optionally filtered.
     * @param column - column filter, or null for every column.
     * @param mine - when true, only rows assigned to agentId.
     * @param agentId - the calling agent's id.
     * @param detail - "compact" (default) returns the compact row; "full" also
     * carries description, devNotes and the pending review report (V3-21 card
     * read layering: compact by default, full when an anomaly needs it).
     * @returns the matching rows in position order.
     */
    listRows(column: ColumnId | null, mine: boolean, agentId: string, detail?: 'compact' | 'full'): Promise<TicketRow[]>;
    /**
     * One full ticket for the model.
     * @param ticketId - the ticket to read.
     * @returns the full ticket view.
     */
    viewTicket(ticketId: string): Promise<TicketView>;
    /**
     * Read the durable master notices of one board — the in-board fallback
     * inbox. Every notifyMaster event lands a row here synchronously, so the
     * master can see what happened even when live followup or persistent inbox
     * delivery could not reach it. A board the caller cannot see is denied as
     * not found (no existence leak).
     * @param boardId - the board to read.
     * @param agent - the calling session agent.
     * @returns the board id and its notices, newest last.
     */
    boardNotices(boardId: string, agent: Agent): Promise<{
        boardId: string;
        notices: BoardNotice[];
    }>;
    /** Capture the opened table handle once the domain resolves. */
    private openedTable;
    /** The caller agent of one tool execution, loud when absent. */
    private static agentOf;
    /** Shared schemastery row schema for the model-facing card view. */
    private static ticketRowSchema;
    /** Register every model-facing taskboard tool on the global tool registry. */
    private registerTools;
}
export default TaskboardService;
//# sourceMappingURL=service.d.ts.map