/**
 * Role context capsules (V3-19): the minimal, accurate, current context
 * package each role (worker / reviewer) receives for one ticket. The
 * compiler is a pure function of the current board state (the ticket) plus
 * the dispatch-time git facts (the [B] preflight report) — it never caches
 * and never appends to a previous prompt, so every dispatch, redispatch and
 * retry recompiles a fresh capsule from current facts. The card description
 * is decomposed into capsule fields (goal, acceptance, constraints)
 * VERBATIM — no LLM summary ever replaces the original text — and everything
 * not mapped to a field lands once in the additional-details field, so the
 * description content appears exactly once in the prompt. The reviewer
 * capsule carries the worker's compact claims (from devNotes) as CLAIMS to
 * verify, never as facts.
 * @module @deepseek-ai/dsh-taskboard
 */
import type { PreflightReport } from './types.ts';
/** One marker-delimited section of a card description. */
export interface CardSection {
    /** The marker line, e.g. "【目标】"; null for text before the first marker. */
    marker: string | null;
    /** The marker title without brackets, e.g. "目标". */
    title: string;
    /** The section body verbatim (trimmed) — the text after the marker line. */
    body: string;
    /** The whole section verbatim (trimmed) — the marker plus its body in the
     * original layout; equals {@link body} for a preamble section. */
    text: string;
}
/**
 * Decompose a card description into its 【...】-delimited sections. Text
 * before the first marker is one preamble section (marker null); when the
 * description has no markers at all, the whole trimmed description is a
 * single preamble section. Empty sections are dropped.
 * @param description - the raw card description.
 * @returns the parsed sections in original order.
 */
export declare function parseSections(description: string): CardSection[];
/** The dispatch-time git facts the worker capsule carries (from the [B]
 * preflight report when computed; available=false otherwise). */
export interface WorkerGitFacts {
    /** Whether the facts were computed at dispatch time (preflight report). */
    available: boolean;
    /** The git top-level of the repo ('' when unavailable). */
    repoRoot: string;
    /** The authoritative baseline: branch + commit. */
    canonicalBase: {
        branch: string;
        commit: string;
    };
    /** The worktree assigned to this dispatch (absolute path). */
    assignedWorktree: string;
    /** The branch actually checked out. */
    actualBranch: string;
    /** The HEAD commit actually checked out. */
    head: string;
    /** Uncommitted changes as porcelain entries (untracked included). */
    dirtyFiles: string[];
    /** HEAD-vs-canonical-base relationship ('equal' | 'ahead' | ...). */
    relationship: string;
}
/** The worker capsule: exactly the fields the worker role needs, nothing more. */
export interface WorkerCapsule {
    ticketId: string;
    title: string;
    /** The task goal, extracted verbatim from the 【目标】 section ('' when absent). */
    goal: string;
    /** The acceptance criteria, extracted verbatim from the 【验收】 section ('' when absent). */
    acceptance: string;
    /** The dispatch-time git facts (canonical base, worktree, branch/HEAD, dirty state). */
    gitFacts: WorkerGitFacts;
    /** The card's declared file scope (verbatim). */
    filesScope: string;
    /** Recovery/hard constraints, extracted verbatim from the 【纪律】/【硬约束】 sections ('' when absent). */
    constraints: string;
    /** Description content not mapped to a capsule field, verbatim ('' when absent). */
    additionalDetails: string;
}
/**
 * Compile the worker capsule for one ticket from the current board state and
 * the dispatch-time preflight facts. Pure: same inputs always yield the same
 * capsule, and the caller gets a fresh capsule on every dispatch/redispatch —
 * retry never carries a previous prompt's appendix.
 * @param ticket - the card (id/title/description/filesScope).
 * @param preflight - the [B] dispatch-time preflight report, when computed.
 * @returns the compiled worker capsule.
 */
export declare function compileWorkerCapsule(ticket: {
    id: string;
    title: string;
    description: string;
    filesScope: string;
}, preflight?: PreflightReport | null): WorkerCapsule;
/**
 * Render the worker capsule as the model-visible markdown block. The git
 * facts field carries the preflight facts when computed; otherwise it names
 * the working directory and tells the worker to verify with git directly.
 * @param capsule - the compiled worker capsule.
 * @param cwd - the spawning session's working directory ('' when unknown).
 * @returns the capsule section text.
 */
export declare function renderWorkerCapsule(capsule: WorkerCapsule, cwd?: string): string;
/** The worker's compact claims, structured from devNotes (V3-19). */
export interface WorkerClaims {
    /** Claimed root cause, when devNotes carries a labeled line ('' otherwise). */
    rootCause: string;
    /** Claimed files changed, when labeled. */
    filesChanged: string;
    /** Claimed tests run (the command), when labeled. */
    testsRun: string;
    /** The key output line the claimed command produced (V3-24): the reviewer
     * re-runs the command and compares exactly this line. Empty = the claim
     * arrived without its key line and is treated as missing, never guessed. */
    keyOutputLine: string;
    /** Claimed known anomaly / known issue, when labeled. */
    knownAnomaly: string;
    /** The developer's notes verbatim — the compact claim source. */
    devNotes: string;
}
/**
 * Structure the worker's compact claims from its devNotes: labeled lines
 * ("Root cause:", "Files changed:", "Tests run:", "Key output line:",
 * "Known anomaly:") fill their claim slots; the notes stay verbatim as the
 * claim source. Lines without a label are ignored by the extractor — the
 * notes field always carries the full text, so nothing is lost. An absent
 * "Key output line:" leaves the slot empty on purpose (V3-24): the reviewer
 * treats that claim as missing instead of inventing a line to compare.
 * @param devNotes - the developer's completion notes.
 * @returns the structured claims.
 */
export declare function parseWorkerClaims(devNotes: string): WorkerClaims;
/** The review-time git facts the reviewer capsule carries (base/candidate
 * commits and the touched-file list; available=false when not computed). */
export interface ReviewerGitFacts {
    /** Whether the base/candidate/touched facts were computed at review time. */
    available: boolean;
    /** The git top-level of the repo ('' when unavailable). */
    repoRoot: string;
    /** The canonical base commit the candidate descends from. */
    baseCommit: string;
    /** The candidate commit under review. */
    candidateCommit: string;
    /** Files touched by the candidate diff (empty = the reviewer computes the diff). */
    touchedFiles: string[];
}
/**
 * Map a [B] dispatch-time preflight report onto the reviewer git facts: the
 * canonical base commit is the base, the reported HEAD is the candidate. The
 * touched-file list is not derivable from the preflight ('' — the reviewer
 * computes the diff itself).
 * @param report - the preflight report.
 * @returns the reviewer git facts.
 */
export declare function reviewerFactsFromPreflight(report: PreflightReport): ReviewerGitFacts;
/** The reviewer verification depth (V3-24): 'standard' is the default and
 * 'deep' is opt-in from the card — the card's 【审核】 section must read
 * exactly "deep" to upgrade the reviewer. */
export type ReviewerDepth = 'standard' | 'deep';
/**
 * Derive the reviewer verification depth from the card description (V3-24).
 * The default is 'standard': run the card's acceptance command once, derive
 * the change set from the workspace, check the scope, probe the named
 * boundary inputs — and read outside the change set only when a claim
 * conflicts with the evidence. The card upgrades the reviewer to 'deep' only
 * when its description carries a 【审核】 section whose body is exactly
 * "deep" (case-insensitive); any other 【审核】 body is ordinary card content
 * and leaves the default.
 * @param description - the raw card description.
 * @returns the reviewer depth.
 */
export declare function reviewerDepthFromDescription(description: string): ReviewerDepth;
/** The reviewer capsule: exactly the fields the reviewer role needs. */
export interface ReviewerCapsule {
    ticketId: string;
    title: string;
    /** The acceptance criteria, extracted verbatim from the 【验收】 section ('' when absent). */
    acceptance: string;
    /** The verification depth (V3-24), derived from the card description. */
    depth: ReviewerDepth;
    /** The card's declared file scope (verbatim). */
    filesScope: string;
    /** The base/candidate commits and touched files under review. */
    git: ReviewerGitFacts;
    /** The worker's compact claims (claims, never facts). */
    claims: WorkerClaims;
    /** Description content not mapped to a capsule field, verbatim ('' when absent). */
    additionalDetails: string;
}
/**
 * Compile the reviewer capsule for one ticket from the current board state.
 * The worker's devNotes are structured into compact claims — the worker's
 * long exploration process is never part of the capsule.
 * @param ticket - the card under review (id/title/description/filesScope/devNotes).
 * @param facts - the review-time git facts, when computed.
 * @returns the compiled reviewer capsule.
 */
export declare function compileReviewerCapsule(ticket: {
    id: string;
    title: string;
    description: string;
    filesScope: string;
    devNotes: string;
}, facts?: ReviewerGitFacts | null): ReviewerCapsule;
/**
 * Render the reviewer capsule as the model-visible markdown block: the
 * acceptance criteria, base/candidate commits, declared scope, touched files,
 * the worker's compact claims, the built-in runtime output discipline, the
 * ≤10-step budget with its no-evidence-no-approval failure posture, and the
 * independent diff-first (not diff-only) verification path at the capsule's
 * depth — standard reads outside the change set only on a claim/evidence
 * conflict, deep may follow the acceptance call paths out of it.
 * @param capsule - the compiled reviewer capsule.
 * @returns the capsule section text.
 */
export declare function renderReviewerCapsule(capsule: ReviewerCapsule): string;
//# sourceMappingURL=capsule.d.ts.map