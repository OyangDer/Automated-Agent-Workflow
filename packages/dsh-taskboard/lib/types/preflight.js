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
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
/**
 * Normalize a path for comparison: resolve against the process cwd when
 * relative, forward slashes, trimmed trailing separator, and lowercase on
 * Windows so "C:\\Repo" and "c:/repo/" compare equal.
 * @param path - the path to normalize.
 * @returns the normalized absolute path.
 */
export function normalizePath(path) {
    const absolute = isAbsolute(path) ? path : resolve(path);
    /* v8 ignore next -- the win32/POSIX alternates are exercised on the matching
       native lane; the primary Linux coverage lane sees one side only. */
    const lowered = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    return lowered.replace(/\\/g, '/').replace(/\/+$/, '');
}
/**
 * True when one path is inside (or equals) another, at a path-separator
 * boundary — a parent directory check, not a string-prefix check.
 * @param parent - the containing path.
 * @param candidate - the path to test.
 * @returns true when candidate is parent or nested under it.
 */
export function isInsidePath(parent, candidate) {
    const p = normalizePath(parent);
    const c = normalizePath(candidate);
    return c === p || c.startsWith(p + '/');
}
/**
 * Resolve one configured worktree entry (absolute or repo-root-relative) to
 * an absolute path.
 * @param repoRoot - the repo root the entry is relative to.
 * @param entry - the configured entry.
 * @returns the absolute path.
 */
export function resolveRepoPath(repoRoot, entry) {
    return isAbsolute(entry) ? entry : resolve(repoRoot, entry);
}
/**
 * Run one git command against the repo. Never throws for a nonzero exit —
 * the status and output are facts the preflight judges.
 * @param repoRoot - the working directory to run git in.
 * @param args - the git arguments.
 * @returns the status, stdout and stderr.
 */
function git(repoRoot, args) {
    let result;
    try {
        result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    }
    catch {
        return { status: -1, stdout: '', stderr: 'git executable unavailable' };
    }
    if (result.error !== undefined) {
        return { status: -1, stdout: '', stderr: result.error.message };
    }
    /* v8 ignore start -- defensive: every git call passes encoding 'utf8' and runs to
       exit, so status is a number and stdout/stderr are strings; a signal-killed
       child (status null) or a decode failure is never exercised by the harnessed lanes. */
    return {
        status: result.status ?? -1,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
    /* v8 ignore stop */
}
/**
 * Parse `git worktree list --porcelain` into entries: the absolute worktree
 * path and the checked-out branch ('' when detached). The main working tree
 * is the first entry.
 * @param porcelain - the porcelain command result.
 * @returns the parsed worktree entries.
 */
export function parseWorktrees(porcelain) {
    if (porcelain.status !== 0)
        return [];
    const entries = [];
    let path = '';
    let branch = '';
    for (const line of porcelain.stdout.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
            if (path !== '')
                entries.push({ path, branch });
            path = line.slice('worktree '.length).trim();
            branch = '';
        }
        else if (line.startsWith('branch ')) {
            branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        }
        else if (line.trim() === '' && path !== '') {
            entries.push({ path, branch });
            path = '';
            branch = '';
        }
    }
    if (path !== '')
        entries.push({ path, branch });
    return entries;
}
/**
 * Compute the HEAD-vs-canonical-base relationship through the commit graph.
 * @param repoRoot - the repo to ask.
 * @param head - the HEAD commit.
 * @param canonical - the canonical base commit.
 * @returns the relationship.
 */
export function relationshipOf(repoRoot, head, canonical) {
    if (head === canonical)
        return 'equal';
    const ahead = git(repoRoot, ['merge-base', '--is-ancestor', canonical, head]).status === 0;
    const behind = git(repoRoot, ['merge-base', '--is-ancestor', head, canonical]).status === 0;
    if (ahead)
        return 'ahead';
    if (behind)
        return 'behind';
    return 'diverged';
}
/**
 * Gather the live git facts of one repo fresh (never cached): canonical
 * top-level, actual branch, HEAD, dirty-file list, registered worktrees, and
 * the canonical base resolution plus the HEAD-vs-base relationship.
 * @param repoRoot - the working directory to inspect (main tree or worktree).
 * @param canonicalBranch - the canonical base branch to resolve.
 * @param canonicalCommit - an optional pinned canonical commit (overrides the branch tip).
 * @returns the gathered facts; ok=false when the directory is not a usable git repo.
 */
export function collectGitFacts(repoRoot, canonicalBranch, canonicalCommit) {
    const topLevel = git(repoRoot, ['rev-parse', '--show-toplevel']);
    if (topLevel.status !== 0) {
        return {
            repoRoot,
            actualBranch: '',
            head: '',
            dirtyFiles: [],
            worktrees: [],
            mainWorktree: repoRoot,
            canonicalCommit: null,
            canonicalBranchExists: false,
            relationship: null,
            ok: false,
            /* v8 ignore next -- git failures always write a fatal message to stderr; the empty-stderr fallback is defensive. */
            error: topLevel.stderr.trim() === '' ? 'not a git repository' : topLevel.stderr.trim(),
        };
    }
    const root = topLevel.stdout.trim();
    const branchOut = git(root, ['branch', '--show-current']);
    /* v8 ignore next -- 'git branch --show-current' cannot fail in a work tree after --show-toplevel succeeded. */
    const branch = branchOut.status === 0 ? branchOut.stdout.trim() : '';
    const headOut = git(root, ['rev-parse', 'HEAD']);
    const head = headOut.status === 0 ? headOut.stdout.trim() : '';
    const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
    /* v8 ignore next -- a porcelain status failure needs a corrupt index; the empty-list fallback is defensive. */
    const dirtyFiles = status.status === 0
        ? status.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
        : [];
    const worktrees = parseWorktrees(git(root, ['worktree', 'list', '--porcelain']));
    /* v8 ignore next -- a valid work tree always lists its main worktree; the root fallback is defensive. */
    const mainWorktree = worktrees.length > 0 ? (worktrees[0]?.path ?? root) : root;
    const branchTip = git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + canonicalBranch]);
    const canonicalBranchExists = branchTip.status === 0;
    const resolvedCommit = canonicalCommit !== undefined && canonicalCommit.trim() !== ''
        ? canonicalCommit.trim()
        : (canonicalBranchExists ? branchTip.stdout.trim() : null);
    const relationship = resolvedCommit === null ? null : relationshipOf(root, head, resolvedCommit);
    return {
        repoRoot: root,
        /* v8 ignore next -- '(none)' needs an empty branch output AND an empty HEAD
           together (unborn detached HEAD), which the harnessed lanes never combine;
           '(detached)' and the named branch are exercised. */
        actualBranch: branch === '' ? (head === '' ? '(none)' : '(detached)') : branch,
        head,
        dirtyFiles,
        worktrees,
        mainWorktree,
        canonicalCommit: resolvedCommit,
        canonicalBranchExists,
        relationship,
        ok: true,
    };
}
/**
 * Parse a declared filesScope into normalized path entries: split on ';' or
 * ',', strip parenthesized annotations like "(新增)", normalize separators,
 * and dedupe.
 * @param scope - the raw declared scope.
 * @returns the normalized entries (empty when the scope is empty/unparseable).
 */
export function parseFilesScope(scope) {
    const entries = [];
    const seen = new Set();
    for (const raw of scope.split(/[;,]/)) {
        const entry = raw.trim()
            .replace(/\s*\([^)]*\)\s*$/, '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        if (entry === '' || seen.has(entry))
            continue;
        seen.add(entry);
        entries.push(entry);
    }
    return entries;
}
/** True when two normalized scope-entry lists share any path (equal or nested). */
function scopesOverlap(a, b) {
    for (const x of a) {
        for (const y of b) {
            if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/'))
                return true;
        }
    }
    return false;
}
/**
 * The cross-card file-scope conflicts of one card against other in-flight
 * cards: two scopes overlap when any entry is equal to or nested under an
 * entry of the other. A card with no parseable scope conflicts with nothing.
 * @param filesScope - the dispatched card's declared scope.
 * @param inFlightScopes - other in-flight cards (id + declared scope).
 * @returns one message per conflicting card.
 */
export function scopeConflicts(filesScope, inFlightScopes) {
    const mine = parseFilesScope(filesScope);
    if (mine.length === 0)
        return [];
    const conflicts = [];
    for (const other of inFlightScopes) {
        if (other.ticketId === '')
            continue;
        const theirs = parseFilesScope(other.filesScope);
        if (theirs.length === 0)
            continue;
        if (scopesOverlap(mine, theirs)) {
            conflicts.push('file-scope conflict with in-flight card "' + other.ticketId + '": its scope "' + other.filesScope + '" overlaps "' + filesScope + '"');
        }
    }
    return conflicts;
}
/**
 * The pure preflight judgment: given the live facts and the dispatch
 * context, decide every invariant and produce the report with concrete
 * violations. Deterministic — the same input always yields the same report.
 * @param input - the live facts plus the dispatch context.
 * @returns the preflight report (safe=false carries the violations).
 */
export function evaluatePreflight(input) {
    const violations = [];
    if (!input.canonicalBranchExists) {
        violations.push('canonical base branch "' + input.canonicalBase.branch + '" does not exist in "' + input.repoRoot + '"');
    }
    if (input.actualBranch !== input.canonicalBase.branch) {
        violations.push('actual branch "' + input.actualBranch + '" is not the canonical base branch "' + input.canonicalBase.branch + '"');
    }
    if (input.relationship !== 'equal' && input.relationship !== 'unknown') {
        violations.push('HEAD ' + input.head + ' is ' + input.relationship + ' the canonical base '
            + input.canonicalBase.branch + ' @ ' + input.canonicalBase.commit + ' (dispatch requires HEAD exactly on the canonical base)');
    }
    if (input.dirtyFiles.length > 0) {
        violations.push('working tree of "' + input.repoRoot + '" has uncommitted change(s): ' + input.dirtyFiles.join('; '));
    }
    for (const reservedPath of input.reservedWorktrees) {
        if (isInsidePath(reservedPath, input.assignedWorktree)) {
            violations.push('assigned worktree "' + input.assignedWorktree + '" is a reserved worktree ("' + reservedPath + '"); workers must never occupy it');
        }
        if (isInsidePath(reservedPath, input.repoRoot)) {
            violations.push('dispatch source "' + input.repoRoot + '" is inside reserved worktree "' + reservedPath + '" (occupied); dispatch from the main working tree');
        }
    }
    const conflicts = scopeConflicts(input.filesScope, input.inFlightScopes);
    for (const conflict of conflicts)
        violations.push(conflict);
    return {
        safe: violations.length === 0,
        violations,
        repoRoot: input.repoRoot,
        canonicalBase: input.canonicalBase,
        assignedWorktree: input.assignedWorktree,
        actualBranch: input.actualBranch,
        head: input.head,
        dirtyFiles: input.dirtyFiles,
        baseCandidateRelationship: input.relationship,
        filesScope: input.filesScope,
        conflicts,
        checkedAt: input.checkedAt,
    };
}
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
export function runPreflight(repoRoot, config, filesScope, inFlightScopes = []) {
    const facts = collectGitFacts(repoRoot, config.canonicalBranch, config.canonicalCommit);
    const baseRoot = facts.mainWorktree;
    const assignedWorktree = config.worktree === undefined ? facts.repoRoot : resolveRepoPath(baseRoot, config.worktree);
    const canonicalCommit = facts.canonicalCommit;
    const canonicalBase = { branch: config.canonicalBranch, commit: canonicalCommit ?? '' };
    const checkedAt = Date.now();
    if (!facts.ok) {
        return {
            safe: false,
            /* v8 ignore next -- collectGitFacts always sets error on ok=false; the fallback is defensive. */
            violations: ['cannot gather git facts for "' + repoRoot + '": ' + String(facts.error ?? 'git unavailable')],
            repoRoot: facts.repoRoot,
            canonicalBase,
            assignedWorktree,
            actualBranch: facts.actualBranch,
            head: facts.head,
            dirtyFiles: facts.dirtyFiles,
            baseCandidateRelationship: 'unknown',
            filesScope,
            conflicts: [],
            checkedAt,
        };
    }
    const reservedWorktrees = (config.reservedWorktrees ?? []).map(entry => resolveRepoPath(baseRoot, entry));
    return evaluatePreflight({
        repoRoot: facts.repoRoot,
        canonicalBase,
        canonicalBranchExists: facts.canonicalBranchExists,
        assignedWorktree,
        actualBranch: facts.actualBranch,
        head: facts.head,
        dirtyFiles: facts.dirtyFiles,
        worktrees: facts.worktrees,
        relationship: facts.relationship ?? 'unknown',
        filesScope,
        inFlightScopes,
        reservedWorktrees,
        checkedAt,
    });
}
/**
 * The model-visible preflight section inlined into the worker prompt: the
 * raw facts (canonical base, assigned worktree, actual branch, HEAD, dirty
 * list, base/candidate relationship, declared scope) — not just a SAFE flag —
 * so the worker starts from deterministic facts it can re-check.
 * @param report - the dispatch-time preflight report.
 * @returns the prompt section text (leading blank line, ready to append).
 */
export function preflightPromptSection(report) {
    return [
        '',
        'Deterministic repo preflight (computed at dispatch time):',
        '  canonical base: ' + report.canonicalBase.branch + ' @ ' + report.canonicalBase.commit,
        '  assigned worktree: ' + report.assignedWorktree,
        '  actual branch: ' + report.actualBranch,
        '  HEAD: ' + report.head,
        '  dirty files: ' + (report.dirtyFiles.length === 0 ? '(none)' : report.dirtyFiles.join('; ')),
        '  base/candidate relationship: ' + report.baseCandidateRelationship,
        '  declared file scope: ' + (report.filesScope.trim() === '' ? '(not declared)' : report.filesScope),
        '  invariants: ' + (report.safe ? 'SAFE (all invariants satisfied)' : 'VIOLATED: ' + report.violations.join(' | ')),
    ].join('\n');
}
//# sourceMappingURL=preflight.js.map