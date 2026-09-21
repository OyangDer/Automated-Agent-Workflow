/**
 * Deterministic repo/worktree preflight (V3-20): before a worker is spawned,
 * the service computes the live git facts of the repo a card dispatches
 * against and judges them against the configured canonical base — the repo's
 * authoritative baseline (branch + commit), the assigned worktree, the
 * reserved integration worktrees, and the cross-card file-scope conflicts.
 * The pure core (evaluatePreflight) turns facts into a PreflightReport with
 * concrete violations; the git seam (collectGitFacts) gathers those facts
 * fresh on every dispatch (never cached). Any invariant violation fails the
 * dispatch closed (card blocked, no worker spawned) — a worker never has to
 * guess the branch, switch worktrees, or archaeology the repository.
 * @module @deepseek-ai/dsh-taskboard/preflight
 */
import type { BaseCandidateRelationship, PreflightReport } from './types.ts';
/** One configured repo's preflight contract (Config.preflightRepos, keyed by
 * absolute repo root path). */
export interface RepoPreflightConfig {
    /** The authoritative baseline branch (e.g. "codex/glass-integration"). */
    canonicalBranch: string;
    /** Pinned baseline commit; when absent, the branch tip at dispatch time is the base. */
    canonicalCommit?: string;
    /** The worktree assigned to dispatched workers; absolute or repo-root-relative. Absent = the main working tree. */
    worktree?: string;
    /** Worktree paths (absolute or repo-root-relative) that workers must never occupy (e.g. the integration worktree). */
    reservedWorktrees?: string[];
    /**
     * Whether invariant violations BLOCK the dispatch (default true, fail
     * closed). With `enforce: false` the report still carries the raw facts and
     * every violation into the worker prompt (facts-only mode) — used where the
     * repo's live branch state legitimately differs from the canonical base at
     * dispatch time (session-branch workflows) and hard gating would block all
     * work instead of informing it.
     */
    enforce?: boolean;
}
/** One registered worktree of the repo (git worktree list). */
export interface WorktreeEntry {
    /** Absolute worktree path. */
    path: string;
    /** Checked-out branch; '' when detached. */
    branch: string;
}
/** The live git facts gathered at dispatch time (never cached). */
export interface GitFacts {
    /** The canonical top-level of the repo (git rev-parse --show-toplevel). */
    repoRoot: string;
    /** The branch checked out; '(detached)' when HEAD is detached, '(none)' when the repo has no commits. */
    actualBranch: string;
    /** The HEAD commit; '' when the repo has no commits. */
    head: string;
    /** Uncommitted changes as porcelain entries (untracked included). */
    dirtyFiles: string[];
    /** Every registered worktree (main + linked), main first. */
    worktrees: WorktreeEntry[];
    /** The main working tree path (first worktree entry); equals repoRoot when the list is unavailable. */
    mainWorktree: string;
    /** The resolved canonical base commit (configured pin, else the canonical branch tip); null when neither resolves. */
    canonicalCommit: string | null;
    /** Whether the canonical branch ref exists in the repo. */
    canonicalBranchExists: boolean;
    /** HEAD-vs-canonical-base relationship; null when the canonical commit is unresolvable. */
    relationship: BaseCandidateRelationship | null;
    /** Whether every gather step succeeded. */
    ok: boolean;
    /** Gather failure detail; present when ok=false. */
    error?: string;
}
/** The pure preflight input: live facts plus the dispatch context. */
export interface PreflightInput {
    /** The canonical top-level of the repo the dispatch targets. */
    repoRoot: string;
    /** The authoritative baseline the dispatch must sit on. */
    canonicalBase: {
        branch: string;
        commit: string;
    };
    /** Whether the canonical branch ref exists in the repo. */
    canonicalBranchExists: boolean;
    /** The absolute worktree assigned to this dispatch. */
    assignedWorktree: string;
    /** The branch actually checked out. */
    actualBranch: string;
    /** The HEAD commit actually checked out. */
    head: string;
    /** Uncommitted changes as porcelain entries (untracked included). */
    dirtyFiles: string[];
    /** Every registered worktree (absolute paths). */
    worktrees: WorktreeEntry[];
    /** HEAD-vs-canonical-base relationship ('unknown' when unresolvable). */
    relationship: BaseCandidateRelationship;
    /** The card's declared file scope. */
    filesScope: string;
    /** Other in-flight cards of the same board (id + declared scope). */
    inFlightScopes: {
        ticketId: string;
        filesScope: string;
    }[];
    /** Absolute paths of worktrees workers must never occupy. */
    reservedWorktrees: string[];
    /** Unix epoch milliseconds when the facts were gathered. */
    checkedAt: number;
}
/** One git command result; a nonzero status is a fact, never a throw. */
interface GitResult {
    status: number;
    stdout: string;
    stderr: string;
}
/**
 * Normalize a path for comparison: resolve against the process cwd when
 * relative, forward slashes, trimmed trailing separator, and lowercase on
 * Windows so "C:\\Repo" and "c:/repo/" compare equal.
 * @param path - the path to normalize.
 * @returns the normalized absolute path.
 */
export declare function normalizePath(path: string): string;
/**
 * True when one path is inside (or equals) another, at a path-separator
 * boundary — a parent directory check, not a string-prefix check.
 * @param parent - the containing path.
 * @param candidate - the path to test.
 * @returns true when candidate is parent or nested under it.
 */
export declare function isInsidePath(parent: string, candidate: string): boolean;
/**
 * Resolve one configured worktree entry (absolute or repo-root-relative) to
 * an absolute path.
 * @param repoRoot - the repo root the entry is relative to.
 * @param entry - the configured entry.
 * @returns the absolute path.
 */
export declare function resolveRepoPath(repoRoot: string, entry: string): string;
/**
 * Parse `git worktree list --porcelain` into entries: the absolute worktree
 * path and the checked-out branch ('' when detached). The main working tree
 * is the first entry.
 * @param porcelain - the porcelain command result.
 * @returns the parsed worktree entries.
 */
export declare function parseWorktrees(porcelain: GitResult): WorktreeEntry[];
/**
 * Compute the HEAD-vs-canonical-base relationship through the commit graph.
 * @param repoRoot - the repo to ask.
 * @param head - the HEAD commit.
 * @param canonical - the canonical base commit.
 * @returns the relationship.
 */
export declare function relationshipOf(repoRoot: string, head: string, canonical: string): BaseCandidateRelationship;
/**
 * Gather the live git facts of one repo fresh (never cached): canonical
 * top-level, actual branch, HEAD, dirty-file list, registered worktrees, and
 * the canonical base resolution plus the HEAD-vs-base relationship.
 * @param repoRoot - the working directory to inspect (main tree or worktree).
 * @param canonicalBranch - the canonical base branch to resolve.
 * @param canonicalCommit - an optional pinned canonical commit (overrides the branch tip).
 * @returns the gathered facts; ok=false when the directory is not a usable git repo.
 */
export declare function collectGitFacts(repoRoot: string, canonicalBranch: string, canonicalCommit?: string): GitFacts;
/**
 * Parse a declared filesScope into normalized path entries: split on ';' or
 * ',', strip parenthesized annotations like "(新增)", normalize separators,
 * and dedupe.
 * @param scope - the raw declared scope.
 * @returns the normalized entries (empty when the scope is empty/unparseable).
 */
export declare function parseFilesScope(scope: string): string[];
/**
 * The cross-card file-scope conflicts of one card against other in-flight
 * cards: two scopes overlap when any entry is equal to or nested under an
 * entry of the other. A card with no parseable scope conflicts with nothing.
 * @param filesScope - the dispatched card's declared scope.
 * @param inFlightScopes - other in-flight cards (id + declared scope).
 * @returns one message per conflicting card.
 */
export declare function scopeConflicts(filesScope: string, inFlightScopes: {
    ticketId: string;
    filesScope: string;
}[]): string[];
/**
 * The pure preflight judgment: given the live facts and the dispatch
 * context, decide every invariant and produce the report with concrete
 * violations. Deterministic — the same input always yields the same report.
 * @param input - the live facts plus the dispatch context.
 * @returns the preflight report (safe=false carries the violations).
 */
export declare function evaluatePreflight(input: PreflightInput): PreflightReport;
/**
 * Run the full preflight for one dispatch: gather the live git facts (never
 * cached) and judge them against the configured canonical base. A gather
 * failure fails closed with a concrete violation.
 * @param repoRoot - the working directory to inspect (main tree or worktree).
 * @param config - the repo's preflight contract.
 * @param filesScope - the card's declared file scope.
 * @param inFlightScopes - other in-flight cards of the same board.
 * @returns the preflight report.
 */
export declare function runPreflight(repoRoot: string, config: RepoPreflightConfig, filesScope: string, inFlightScopes?: {
    ticketId: string;
    filesScope: string;
}[]): PreflightReport;
/**
 * The model-visible preflight section inlined into the worker prompt: the
 * raw facts (canonical base, assigned worktree, actual branch, HEAD, dirty
 * list, base/candidate relationship, declared scope) — not just a SAFE flag —
 * so the worker starts from deterministic facts it can re-check.
 * @param report - the dispatch-time preflight report.
 * @returns the prompt section text (leading blank line, ready to append).
 */
export declare function preflightPromptSection(report: PreflightReport): string;
export {};
//# sourceMappingURL=preflight.d.ts.map