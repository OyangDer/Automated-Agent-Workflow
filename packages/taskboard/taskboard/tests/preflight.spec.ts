/**
 * Deterministic repo/worktree preflight acceptance (V3-20): the pure
 * evaluation, the live git-fact gathering against real temporary git
 * repositories (branch, HEAD, dirty list, base/candidate relationship,
 * registered worktrees), the invariant matrix that fails a dispatch closed
 * (dirty tree, wrong branch, off-base HEAD, missing canonical branch,
 * reserved/integration worktree occupancy, cross-card file-scope conflicts),
 * and the service integration — assign/retry gates the worker spawn on the
 * preflight and inlines the raw facts into the worker prompt.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import TaskboardService from '@deepseek-ai/dsh-taskboard'
import type { TicketView } from '@deepseek-ai/dsh-taskboard'
import {
  collectGitFacts, evaluatePreflight, isInsidePath, normalizePath, parseFilesScope,
  parseWorktrees, preflightPromptSection, resolveRepoPath, runPreflight, scopeConflicts,
  type PreflightInput, type RepoPreflightConfig,
} from '../src/preflight.ts'
import type { PreflightReport } from '../src/types.ts'

/**
 * Normalize a real path for comparison, resolving Windows 8.3 short paths
 * (e.g. "O'YAN'~1") to the long form git reports, so temp-dir facts compare
 * equal regardless of which form the OS handed out.
 */
async function normPath(p: string): Promise<string> {
  return normalizePath(await realpath(p))
}

/** The forward-slash form a declared scope entry takes after parseFilesScope. */
function slash(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Run one git command in a directory; throws on failure. */
function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed (' + String(result.status) + '): ' + result.stderr)
  }
  return result.stdout.trim()
}

/**
 * Explicit per-case budget for the suites that drive real git repositories.
 *
 * Every red observed in this file was "Test timed out in 5000ms" — vitest's
 * default — never an assertion. Measured on this host (Windows, quiet), the
 * slowest case (the pinned-commit ahead/behind/diverged matrix) takes ~2.3s
 * and the file costs ~29s of test time; the same code crosses 5s once the
 * machine carries a few dozen node processes. 30s is ~12x the quiet-machine
 * worst case, so a loaded machine stays distinguishable from a real
 * regression: a real break still fails on an assertion, not on the clock. The
 * pure suites keep vitest's 5s default, so a genuine hang there still fails
 * fast.
 */
const GIT_TEST_TIMEOUT_MS = 30_000

/** Temp directories created by the helpers, cleaned between cases. */
const openDirs: string[] = []

/** The per-file temp root, selected and created in beforeAll. */
let suiteTmpRoot = ''

/**
 * Choose the root every real-git fixture lives under.
 *
 * `os.tmpdir()` here is the 8.3 short form of a profile that carries an
 * apostrophe ("C:\Users\O'YAN'~1\AppData\Local\Temp"): real git init/commit
 * calls under it are measurably slower to settle, and apostrophe temp paths are
 * the family that historically broke path/URL handling. On Windows we therefore
 * prefer a drive-root directory with no apostrophe, no space and no 8.3 alias;
 * a writability probe falls back to the platform temp dir where the drive root
 * is not writable. DSH_TEST_TMP_ROOT overrides the choice outright.
 */
async function selectTempBase(): Promise<string> {
  const override = process.env.DSH_TEST_TMP_ROOT
  if (override !== undefined && override !== '') return override
  const candidates = process.platform === 'win32'
    ? [join(parse(tmpdir()).root, 'dsh-test-tmp'), join(tmpdir(), 'dsh-test-tmp')]
    : [join(tmpdir(), 'dsh-test-tmp')]
  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true })
      const probe = join(candidate, '.write-probe-' + String(process.pid))
      await writeFile(probe, '')
      await rm(probe, { force: true })
      return candidate
    } catch (error) {
      const code = (error as { code?: string }).code ?? String(error)
      console.warn('[preflight-test] temp root ' + candidate + ' is unusable (' + code + '), trying the next candidate')
    }
  }
  console.warn('[preflight-test] no candidate temp root worked; using ' + tmpdir())
  return tmpdir()
}

/**
 * Delete a path, retrying the Windows refusals (ENOTEMPTY/EBUSY/EPERM) that
 * appear while a just-exited git process still holds a handle. `force` makes
 * it idempotent and `maxRetries` backs it off. This variant rethrows, for
 * deletions a case's own precondition depends on.
 */
async function removeTestPath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/**
 * Delete a test temp directory without ever reddening a case: cleanup residue
 * is logged (so it stays visible next to a failure) and the whole suite root is
 * removed again in afterAll.
 */
async function removeTree(target: string, label: string): Promise<void> {
  try {
    await removeTestPath(target)
  } catch (error) {
    const code = (error as { code?: string }).code ?? String(error)
    console.warn('[preflight-test] cleanup could not remove ' + label + ' (' + code + '): ' + target)
  }
}

beforeAll(async () => {
  suiteTmpRoot = join(await selectTempBase(), 'preflight-' + String(process.pid) + '-' + Date.now().toString(36))
  await mkdir(suiteTmpRoot, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(openDirs.splice(0).map(dir => removeTree(dir, 'case temp dir')))
})

afterAll(async () => {
  await removeTree(suiteTmpRoot, 'suite temp root')
})

/** A fresh directory under the suite temp root (no apostrophe, no 8.3 alias). */
async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(suiteTmpRoot, prefix))
}

/** Create a fresh real git repository on branch "main" with a committed file. */
async function createRepo(): Promise<string> {
  const dir = await makeTempDir('preflight-repo-')
  openDirs.push(dir)
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Preflight Test'])
  await writeFile(join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

/** Create a linked worktree (e.g. the integration worktree) inside a repo. */
async function addWorktree(repo: string, relativePath: string, branch: string): Promise<string> {
  const wtDir = join(repo, relativePath)
  await mkdir(join(repo, relativePath.split(/[\\/]/)[0]!), { recursive: true })
  git(repo, ['worktree', 'add', '-b', branch, wtDir])
  return wtDir
}

/** A registry-compatible agent around one concrete session (cwd optional). */
function stubAgentForSession(session: Session): Agent {
  const nextTurn: Parameters<Inbox['append']>[1][] = []
  const nextStep: Parameters<Inbox['append']>[1][] = []
  const inbox: Inbox = {
    nextTurn,
    nextStep,
    clear() { nextTurn.splice(0); nextStep.splice(0) },
    append(target, message) { (target === 'next-turn' ? nextTurn : nextStep).push(message) },
    prepend(target, message) { (target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
    replace(messageId, message) {
      for (const pending of [nextTurn, nextStep]) {
        const index = pending.findIndex(candidate => candidate.id === messageId)
        if (index >= 0) { pending.splice(index, 1, message); return true }
      }
      return false
    },
    remove(messageId) {
      for (const pending of [nextTurn, nextStep]) {
        const index = pending.findIndex(candidate => candidate.id === messageId)
        if (index >= 0) { pending.splice(index, 1); return true }
      }
      return false
    },
    splice(target, start, deleteCount, inserted) {
      return (target === 'next-turn' ? nextTurn : nextStep).splice(start, deleteCount, ...inserted)
    },
  }
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** A fresh master-session agent whose header carries the given cwd (or none). */
function masterAgent(rawId: string, cwd?: string): Agent {
  const id = SessionId(rawId)
  const session = cwd === undefined
    ? Session.create(id)
    : Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      isSeeded: false,
      cwd,
    })
  return stubAgentForSession(session)
}

/** The minimal service harness: real storage chain, stubbed subagent seam. */
interface Harness {
  ctx: Context
  service: TaskboardService
  /** The vi.fn backing the stubbed subagents.start seam. */
  subagentsStart: ReturnType<typeof vi.fn>
}

async function harness(options: { preflightRepos?: Record<string, RepoPreflightConfig> } = {}): Promise<Harness> {
  const root = await makeTempDir('taskboard-preflight-')
  openDirs.push(root)
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const subagentsStart = vi.fn(async (_provider: string, _request: SubagentStartRequest) => {
    return { id: 'worker-child-agent' }
  })
  ctx.provide('subagents', { start: subagentsStart } as never)
  await ctx.plugin(TaskboardService, {
    reconcileIntervalMs: 0,
    ...(options.preflightRepos === undefined ? {} : { preflightRepos: options.preflightRepos }),
  })
  return { ctx, service: ctx.taskboard, subagentsStart }
}

/** Create a card on the default board and schedule it into Not started as master. */
async function createNotStarted(service: TaskboardService, agent: Agent, title: string, filesScope: string): Promise<TicketView> {
  const ticket = await service.createRemote(agent, { title, description: '', priority: 'normal', dependsOn: [], filesScope })
  return await service.moveAsMaster(agent, { ticketId: ticket.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
}

describe('collectGitFacts with real temp git repositories', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('gathers branch, HEAD, a clean tree and an equal relationship on the canonical base', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const facts = collectGitFacts(repo, 'main')
    expect(facts.ok).toBe(true)
    expect(facts.error).toBeUndefined()
    expect(await normPath(facts.repoRoot)).toBe(await normPath(repo))
    expect(facts.actualBranch).toBe('main')
    expect(facts.head).toBe(head)
    expect(facts.dirtyFiles).toEqual([])
    expect(facts.canonicalBranchExists).toBe(true)
    expect(facts.canonicalCommit).toBe(head)
    expect(facts.relationship).toBe('equal')
    expect(facts.worktrees).toHaveLength(1)
    expect(facts.worktrees[0]!.branch).toBe('main')
    expect(await normPath(facts.mainWorktree)).toBe(await normPath(repo))
  })

  it('lists uncommitted and untracked changes as porcelain entries', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'tracked.txt'), 'modified\n')
    await writeFile(join(repo, 'untracked.txt'), 'new\n')
    const facts = collectGitFacts(repo, 'main')
    expect(facts.dirtyFiles).toHaveLength(2)
    expect(facts.dirtyFiles.some(entry => entry.includes('tracked.txt'))).toBe(true)
    expect(facts.dirtyFiles.some(entry => entry.startsWith('??') && entry.includes('untracked.txt'))).toBe(true)
  })

  it('reports a detached HEAD and still resolves the relationship', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '--detach', head])
    const facts = collectGitFacts(repo, 'main')
    expect(facts.actualBranch).toBe('(detached)')
    expect(facts.head).toBe(head)
    expect(facts.relationship).toBe('equal')
  })

  it('computes ahead, behind and diverged relationships against a pinned canonical commit', async () => {
    const repo = await createRepo()
    const c1 = git(repo, ['rev-parse', 'HEAD'])
    // ahead: HEAD descends from the pinned base.
    await writeFile(join(repo, 'b.txt'), 'b\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'second'])
    const c2 = git(repo, ['rev-parse', 'HEAD'])
    const ahead = collectGitFacts(repo, 'main', c1)
    expect(ahead.canonicalCommit).toBe(c1)
    expect(ahead.relationship).toBe('ahead')
    // behind: HEAD is an ancestor of the pinned base.
    git(repo, ['checkout', '--detach', c1])
    const behind = collectGitFacts(repo, 'main', c2)
    expect(behind.relationship).toBe('behind')
    // diverged: HEAD and the pinned base share no ancestor relationship.
    git(repo, ['checkout', 'main'])
    git(repo, ['checkout', '-b', 'topic', c1])
    await writeFile(join(repo, 't.txt'), 't\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'topic'])
    const topicHead = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', 'main'])
    await writeFile(join(repo, 'm.txt'), 'm\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'main-advance'])
    const diverged = collectGitFacts(repo, 'main', topicHead)
    expect(diverged.relationship).toBe('diverged')
  })

  it('reports a missing canonical branch and honors a pinned commit without it', async () => {
    const repo = await createRepo()
    const missing = collectGitFacts(repo, 'no-such-branch')
    expect(missing.canonicalBranchExists).toBe(false)
    expect(missing.canonicalCommit).toBeNull()
    expect(missing.relationship).toBeNull()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const pinned = collectGitFacts(repo, 'no-such-branch', head)
    expect(pinned.canonicalBranchExists).toBe(false)
    expect(pinned.canonicalCommit).toBe(head)
    expect(pinned.relationship).toBe('equal')
  })

  it('fails closed outside a git repository', async () => {
    const dir = await makeTempDir('preflight-nogit-')
    openDirs.push(dir)
    const facts = collectGitFacts(dir, 'main')
    expect(facts.ok).toBe(false)
    expect(facts.error).toBeTruthy()
  })

  it('reports an unborn repo with an empty HEAD and a missing canonical ref', async () => {
    const dir = await makeTempDir('preflight-unborn-')
    openDirs.push(dir)
    git(dir, ['init', '-b', 'main'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Preflight Test'])
    const facts = collectGitFacts(dir, 'main')
    expect(facts.ok).toBe(true)
    expect(facts.head).toBe('')
    expect(facts.actualBranch).toBe('main')
    expect(facts.canonicalBranchExists).toBe(false)
    expect(facts.canonicalCommit).toBeNull()
    expect(facts.relationship).toBeNull()
  })

  it('fails closed when git cannot even be started for the repo root', () => {
    // A NUL byte in the cwd makes node's spawnSync throw synchronously.
    const facts = collectGitFacts('C:\\repo' + String.fromCharCode(0) + 'bad', 'main')
    expect(facts.ok).toBe(false)
    expect(facts.error).toContain('git executable unavailable')
  })

  it('fails closed when the repo root does not exist', () => {
    const missing = join(suiteTmpRoot, 'preflight-missing-' + String(Date.now()))
    const facts = collectGitFacts(missing, 'main')
    expect(facts.ok).toBe(false)
    expect(facts.error).toBeTruthy()
  })

  it('lists linked worktrees with their checked-out branches (integration worktree)', async () => {
    const repo = await createRepo()
    const wtDir = await addWorktree(repo, '.worktrees/integration', 'integration')
    const facts = collectGitFacts(repo, 'main')
    const paths = await Promise.all(facts.worktrees.map(entry => normPath(entry.path)))
    const branches = facts.worktrees.map(entry => entry.branch)
    expect(paths).toContain(await normPath(repo))
    expect(paths).toContain(await normPath(wtDir))
    expect(branches).toContain('main')
    expect(branches).toContain('integration')
    expect(await normPath(facts.mainWorktree)).toBe(await normPath(repo))
  })
})

describe('worktree porcelain parsing', () => {
  it('parses entries with branches and detached worktrees; fails closed on error', () => {
    const entries = parseWorktrees({
      status: 0,
      stdout: [
        'worktree C:/repo',
        'HEAD 1111111',
        'branch refs/heads/main',
        '',
        'worktree C:/repo/.worktrees/integration',
        'HEAD 2222222',
        'detached',
        '',
      ].join('\n'),
      stderr: '',
    })
    expect(entries).toEqual([
      { path: 'C:/repo', branch: 'main' },
      { path: 'C:/repo/.worktrees/integration', branch: '' },
    ])
    expect(parseWorktrees({ status: 1, stdout: '', stderr: 'boom' })).toEqual([])
  })

  it('flushes entries between back-to-back blocks and at EOF without blank separators', () => {
    // Real porcelain always separates blocks with blank lines; a stream that
    // omits them must still flush each block when the next 'worktree ' line
    // arrives and once more at the end of the input.
    const entries = parseWorktrees({
      status: 0,
      stdout: [
        'worktree C:/repo',
        'HEAD 1111111',
        'branch refs/heads/main',
        'worktree C:/repo/.worktrees/integration',
        'HEAD 2222222',
        'branch refs/heads/integration',
      ].join('\n'),
      stderr: '',
    })
    expect(entries).toEqual([
      { path: 'C:/repo', branch: 'main' },
      { path: 'C:/repo/.worktrees/integration', branch: 'integration' },
    ])
  })
})

describe('path helpers', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('normalizes paths and judges containment at separator boundaries', async () => {
    const repo = await createRepo()
    const child = join(repo, 'src', 'a.ts')
    const sibling = repo + '-other'
    expect(isInsidePath(repo, repo)).toBe(true)
    expect(isInsidePath(repo, child)).toBe(true)
    expect(isInsidePath(repo, sibling)).toBe(false)
    expect(isInsidePath(repo, tmpdir())).toBe(false)
    // Trailing separators and relative inputs normalize.
    expect(normalizePath(repo + '/')).toBe(normalizePath(repo))
    expect(normalizePath('relative/dir').endsWith('relative/dir')).toBe(true)
  })

  it('resolves absolute and repo-root-relative worktree entries', async () => {
    const repo = await createRepo()
    const abs = join(repo, 'custom-wt')
    expect(normalizePath(resolveRepoPath(repo, 'custom-wt'))).toBe(normalizePath(abs))
    expect(normalizePath(resolveRepoPath(repo, abs))).toBe(normalizePath(abs))
  })
})

describe('runPreflight invariants against real repos', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('reports a safe report on a clean repo sitting exactly on the canonical base', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const report = runPreflight(repo, { canonicalBranch: 'main' }, 'src/a.ts')
    expect(report.safe).toBe(true)
    expect(report.violations).toEqual([])
    expect(report.canonicalBase).toEqual({ branch: 'main', commit: head })
    expect(await normPath(report.assignedWorktree)).toBe(await normPath(repo))
    expect(report.actualBranch).toBe('main')
    expect(report.head).toBe(head)
    expect(report.dirtyFiles).toEqual([])
    expect(report.baseCandidateRelationship).toBe('equal')
    expect(report.filesScope).toBe('src/a.ts')
    expect(report.conflicts).toEqual([])
    expect(report.checkedAt).toBeGreaterThan(0)
  })

  it('blocks a dirty or wrong-branch repo with concrete violations', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'dirty.txt'), 'x\n')
    git(repo, ['checkout', '-b', 'feature/x'])
    const report = runPreflight(repo, { canonicalBranch: 'main' }, '')
    expect(report.safe).toBe(false)
    const joined = report.violations.join(' | ')
    expect(joined).toContain('actual branch "feature/x" is not the canonical base branch "main"')
    expect(joined).toContain('dirty.txt')
  })

  it('blocks a repo whose HEAD is ahead of a pinned canonical base', async () => {
    const repo = await createRepo()
    const c1 = git(repo, ['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'b.txt'), 'b\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'second'])
    const report = runPreflight(repo, { canonicalBranch: 'main', canonicalCommit: c1 }, '')
    expect(report.safe).toBe(false)
    expect(report.baseCandidateRelationship).toBe('ahead')
    expect(report.violations.join(' | ')).toContain('is ahead the canonical base main @ ' + c1)
  })

  it('blocks when the canonical base branch does not exist', async () => {
    const repo = await createRepo()
    const report = runPreflight(repo, { canonicalBranch: 'no-such-branch' }, '')
    expect(report.safe).toBe(false)
    expect(report.violations.join(' | ')).toContain('canonical base branch "no-such-branch" does not exist')
  })

  it('fails closed when the repo is not a git repository', async () => {
    const dir = await makeTempDir('preflight-norepo-')
    openDirs.push(dir)
    const report = runPreflight(dir, { canonicalBranch: 'main' }, '')
    expect(report.safe).toBe(false)
    expect(report.violations.join(' | ')).toContain('cannot gather git facts')
    expect(report.baseCandidateRelationship).toBe('unknown')
  })

  it('blocks when the assigned worktree is the reserved integration worktree', async () => {
    const repo = await createRepo()
    const report = runPreflight(repo, {
      canonicalBranch: 'main',
      worktree: '.worktrees/integration',
      reservedWorktrees: ['.worktrees/integration'],
    }, '')
    expect(report.safe).toBe(false)
    const joined = report.violations.join(' | ')
    expect(joined).toContain('assigned worktree')
    expect(joined).toContain('reserved worktree')
  })

  it('blocks when dispatch runs from inside an occupied reserved worktree', async () => {
    const repo = await createRepo()
    const wtDir = await addWorktree(repo, '.worktrees/integration', 'integration')
    const report = runPreflight(wtDir, {
      canonicalBranch: 'main',
      reservedWorktrees: ['.worktrees/integration'],
    }, '')
    expect(report.safe).toBe(false)
    const joined = report.violations.join(' | ')
    expect(joined).toContain('dispatch source')
    expect(joined).toContain('reserved worktree')
    expect(await normPath(report.repoRoot)).toBe(await normPath(wtDir))
  })

  it('accepts an absolute assigned worktree outside the repo', async () => {
    const repo = await createRepo()
    const absolute = join(suiteTmpRoot, 'preflight-custom-wt')
    const report = runPreflight(repo, { canonicalBranch: 'main', worktree: absolute }, '')
    expect(report.safe).toBe(true)
    expect(normalizePath(report.assignedWorktree)).toBe(normalizePath(absolute))
  })

  it('blocks on a cross-card file-scope conflict', async () => {
    const repo = await createRepo()
    const report = runPreflight(repo, { canonicalBranch: 'main' }, 'src/components',
      [{ ticketId: 'other-1', filesScope: 'src/components/button.tsx' }])
    expect(report.safe).toBe(false)
    expect(report.violations.join(' | ')).toContain('file-scope conflict with in-flight card "other-1"')
    expect(report.conflicts).toHaveLength(1)
  })
})

describe('evaluatePreflight pure judgment', () => {
  const base: PreflightInput = {
    repoRoot: 'C:/repo',
    canonicalBase: { branch: 'main', commit: 'aaaa' },
    canonicalBranchExists: true,
    assignedWorktree: 'C:/repo',
    actualBranch: 'main',
    head: 'aaaa',
    dirtyFiles: [],
    worktrees: [{ path: 'C:/repo', branch: 'main' }],
    relationship: 'equal',
    filesScope: '',
    inFlightScopes: [],
    reservedWorktrees: [],
    checkedAt: 1,
  }

  it('reports raw facts with every concrete violation on a bad dispatch', () => {
    const report = evaluatePreflight({
      ...base,
      actualBranch: 'feature/x',
      head: 'bbbb',
      dirtyFiles: [' M src/a.ts', '?? new.ts'],
      relationship: 'ahead',
      filesScope: 'src/a.ts',
    })
    expect(report.safe).toBe(false)
    const joined = report.violations.join(' | ')
    expect(joined).toContain('actual branch "feature/x" is not the canonical base branch "main"')
    expect(joined).toContain('HEAD bbbb is ahead the canonical base main @ aaaa')
    expect(joined).toContain('working tree of "C:/repo" has uncommitted change(s)')
    expect(report.repoRoot).toBe('C:/repo')
    expect(report.assignedWorktree).toBe('C:/repo')
    expect(report.baseCandidateRelationship).toBe('ahead')
    expect(report.filesScope).toBe('src/a.ts')
    expect(report.conflicts).toEqual([])
    expect(report.checkedAt).toBe(1)
  })

  it('reports the missing canonical branch without a redundant relationship violation', () => {
    const report = evaluatePreflight({
      ...base,
      canonicalBranchExists: false,
      canonicalBase: { branch: 'main', commit: '' },
      relationship: 'unknown',
    })
    expect(report.safe).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toContain('canonical base branch "main" does not exist')
  })

  it('judges a behind relationship as a violation', () => {
    const report = evaluatePreflight({ ...base, head: '0000', relationship: 'behind' })
    expect(report.safe).toBe(false)
    expect(report.violations.join(' | ')).toContain('HEAD 0000 is behind the canonical base')
  })

  it('blocks a dispatch that would occupy a reserved worktree', () => {
    const report = evaluatePreflight({
      ...base,
      assignedWorktree: 'C:/repo/.worktrees/integration',
      reservedWorktrees: ['C:/repo/.worktrees/integration'],
    })
    expect(report.safe).toBe(false)
    expect(report.violations.join(' | ')).toContain('assigned worktree "C:/repo/.worktrees/integration" is a reserved worktree')
  })

  it('blocks a dispatch whose source is inside an occupied reserved worktree', () => {
    const report = evaluatePreflight({
      ...base,
      repoRoot: 'C:/repo/.worktrees/integration',
      assignedWorktree: 'C:/repo/.worktrees/integration',
      actualBranch: 'integration',
      reservedWorktrees: ['C:/repo/.worktrees/integration'],
    })
    expect(report.safe).toBe(false)
    expect(report.violations.join(' | ')).toContain('dispatch source "C:/repo/.worktrees/integration" is inside reserved worktree')
  })

  it('keeps a dispatch outside the reserved worktree boundaries clean', () => {
    const report = evaluatePreflight({
      ...base,
      reservedWorktrees: ['C:/repo/.worktrees/integration'],
    })
    expect(report.safe).toBe(true)
    expect(report.violations).toEqual([])
  })

  it('flags cross-card file-scope conflicts and stays clean without overlap', () => {
    const conflicted = evaluatePreflight({
      ...base,
      filesScope: 'src/components',
      inFlightScopes: [{ ticketId: 't1', filesScope: 'src/components/button.tsx' }],
    })
    expect(conflicted.safe).toBe(false)
    expect(conflicted.violations.join(' | ')).toContain('file-scope conflict with in-flight card "t1"')
    expect(conflicted.conflicts).toHaveLength(1)
    const clean = evaluatePreflight({
      ...base,
      filesScope: 'src/other.ts',
      inFlightScopes: [{ ticketId: 't1', filesScope: 'src/components/button.tsx' }],
    })
    expect(clean.safe).toBe(true)
    expect(clean.violations).toEqual([])
    expect(clean.conflicts).toEqual([])
  })
})

describe('scope parsing and conflicts', () => {
  it('parses declared file scopes: separators, annotations, dedupe', () => {
    expect(parseFilesScope('src/a.ts; src/b.ts(新增); src/b.ts')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parseFilesScope('a\\b\\c.ts, d/e/f.ts')).toEqual(['a/b/c.ts', 'd/e/f.ts'])
    expect(parseFilesScope('  ;  ,  ')).toEqual([])
    expect(parseFilesScope('')).toEqual([])
  })

  it('computes conflicts and skips empty or unparseable scopes', () => {
    expect(scopeConflicts('', [{ ticketId: 'x', filesScope: 'src/a.ts' }])).toEqual([])
    expect(scopeConflicts('src/a.ts', [{ ticketId: 'x', filesScope: '' }])).toEqual([])
    expect(scopeConflicts('src/a.ts', [{ ticketId: 'x', filesScope: 'src/a.ts' }]))
      .toEqual(['file-scope conflict with in-flight card "x": its scope "src/a.ts" overlaps "src/a.ts"'])
    expect(scopeConflicts('src/a.ts', [
      { ticketId: 'x', filesScope: 'src/b.ts' },
      { ticketId: 'y', filesScope: 'src/c.ts' },
    ])).toEqual([])
    expect(scopeConflicts('src/a.ts', [{ ticketId: '', filesScope: 'src/a.ts' }])).toEqual([])
  })
})

describe('worker prompt preflight section', () => {
  const safeReport: PreflightReport = {
    safe: true,
    violations: [],
    repoRoot: 'C:/repo',
    canonicalBase: { branch: 'main', commit: 'aaaa' },
    assignedWorktree: 'C:/repo',
    actualBranch: 'main',
    head: 'aaaa',
    dirtyFiles: [],
    baseCandidateRelationship: 'equal',
    filesScope: 'src/a.ts',
    conflicts: [],
    checkedAt: 1,
  }

  it('inlines the raw facts, not just a SAFE flag', () => {
    const text = preflightPromptSection(safeReport)
    expect(text).toContain('Deterministic repo preflight')
    expect(text).toContain('canonical base: main @ aaaa')
    expect(text).toContain('assigned worktree: C:/repo')
    expect(text).toContain('actual branch: main')
    expect(text).toContain('HEAD: aaaa')
    expect(text).toContain('dirty files: (none)')
    expect(text).toContain('base/candidate relationship: equal')
    expect(text).toContain('declared file scope: src/a.ts')
    expect(text).toContain('SAFE')
  })

  it('renders the dirty list and violations on an unsafe report', () => {
    const text = preflightPromptSection({
      ...safeReport,
      safe: false,
      violations: ['working tree has changes'],
      dirtyFiles: [' M x.ts'],
      filesScope: '',
    })
    expect(text).toContain('dirty files:  M x.ts')
    expect(text).toContain('VIOLATED: working tree has changes')
    expect(text).toContain('declared file scope: (not declared)')
  })
})

describe('service dispatch preflight (V3-20)', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('blocks dispatch on a dirty governed repo: card blocked, violations in failure, no worker', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'extra.txt'), 'x\n')
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'dirty repo card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.workerAgentId).toBeNull()
    expect(result.ticket.column).toBe('in_progress')
    expect(result.ticket.status).toBe('blocked')
    expect(result.ticket.failure?.reason).toContain('preflight blocked')
    expect(result.ticket.failure?.reason).toContain('extra.txt')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('facts-only mode (enforce: false) dispatches anyway and still injects the raw facts and violations', async () => {
    // The session-branch workflow keeps the live tree off the canonical
    // branch and dirty by design; facts-only mode turns the same mismatch
    // from a hard block into plain information for the worker.
    const repo = await createRepo()
    await writeFile(join(repo, 'extra.txt'), 'x\n')
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: { [repo]: { canonicalBranch: 'main', enforce: false } },
    })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'facts-only card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    // No block: the worker spawns and the card runs.
    expect(result.worker).toBe('spawned')
    expect(result.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.status).toBe('running')
    // The capsule still carries the raw facts and the violated invariant.
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('Deterministic repo preflight (computed at dispatch time)')
    expect(prompt).toContain('extra.txt')
    expect(prompt).toContain('VIOLATED')
  })

  it('spawns a worker on a clean governed repo and injects the preflight facts into the prompt', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    // V3-33: the scope must be absolute to locate the repo, so this card's
    // scope names the mapped repo explicitly instead of relying on the cwd.
    const scope = join(repo, 'src', 'a.ts')
    const ticket = await createNotStarted(service, dev, 'clean repo card', scope)
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(result.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.status).toBe('running')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('Deterministic repo preflight (computed at dispatch time)')
    expect(prompt).toContain('canonical base: main @ ' + head)
    expect(prompt).toContain('HEAD: ' + head)
    expect(prompt).toContain('dirty files: (none)')
    expect(prompt).toContain('base/candidate relationship: equal')
    expect(prompt).toContain('SAFE')
    // The raw facts travel with the ticket's own scope, not just a flag.
    expect(prompt).toContain('declared file scope: ' + scope)
  })

  it('resolves the dispatch repo from a master-corrected filesScope (V3-40)', async () => {
    const wrongRepo = await createRepo()
    const rightRepo = await createRepo()
    // A distinct commit so the two repos' HEADs can never collide.
    await writeFile(join(rightRepo, 'right.txt'), 'right\n')
    git(rightRepo, ['add', '.'])
    git(rightRepo, ['commit', '-m', 'right-only'])
    const rightHead = git(rightRepo, ['rev-parse', 'HEAD'])
    const wrongHead = git(wrongRepo, ['rev-parse', 'HEAD'])
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: {
        [wrongRepo]: { canonicalBranch: 'main' },
        [rightRepo]: { canonicalBranch: 'main' },
      },
    })
    const dev = masterAgent('dev-agent-a', wrongRepo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    // Planned against the wrong repo; the declaration is frozen at create time.
    const ticket = await createNotStarted(service, dev, 'scope typo card', join(wrongRepo, 'src', 'a.ts'))
    const rightScope = join(rightRepo, 'src', 'b.ts')
    const corrected = await ctx.tools.execute({
      callId: ToolCallId('tool-preflight-scope-fix'),
      name: 'taskboard_update',
      arguments: { ticketId: ticket.id, filesScope: rightScope },
      agent: dev,
      signal: new AbortController().signal,
    })
    expect(corrected.isError).toBe(false)
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    // Dispatch preflight located the repo from the corrected card, not the
    // master cwd (the wrong repo) and not the created scope.
    expect(prompt).toContain('declared file scope: ' + rightScope)
    expect(prompt).toContain('HEAD: ' + rightHead)
    expect(prompt).not.toContain(wrongHead)
  })

  it('fails closed when the master cwd maps to no configured repo', async () => {
    const repo = await createRepo()
    const elsewhere = await makeTempDir('preflight-elsewhere-')
    openDirs.push(elsewhere)
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'unmapped card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.ticket.status).toBe('blocked')
    expect(result.ticket.failure?.reason).toContain('no repo mapping')
    expect(result.ticket.failure?.reason).toContain('fail closed')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('fails closed when the master session has no cwd at all', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a')
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'cwd-less card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.ticket.status).toBe('blocked')
    expect(result.ticket.failure?.reason).toContain('(none)')
    expect(result.ticket.failure?.reason).toContain('no repo mapping')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('keeps the legacy dispatch path when preflight is not configured', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness()
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'legacy card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(subagentsStart).toHaveBeenCalledTimes(1)
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).not.toContain('Deterministic repo preflight')
  })

  it('blocks dispatch on a scope conflict with an in-flight card of the same board', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const first = await createNotStarted(service, dev, 'first card', join(repo, 'src', 'components'))
    const firstResult = await service.assign(dev, first.id)
    expect(firstResult.worker).toBe('spawned')
    const second = await createNotStarted(service, dev, 'second card', join(repo, 'src', 'components', 'button.tsx'))
    const secondResult = await service.assign(dev, second.id)
    expect(secondResult.worker).toBe('failed')
    expect(secondResult.ticket.status).toBe('blocked')
    expect(secondResult.ticket.failure?.reason).toContain('file-scope conflict with in-flight card')
    expect(subagentsStart).toHaveBeenCalledTimes(1)
  })

  it('ignores in-flight cards of other boards for the scope conflict check', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    await service.claimMaster('alpha', dev)
    const otherBoard = await service.createRemote(dev, {
      title: 'other board card', description: '', priority: 'normal', dependsOn: [], filesScope: join(repo, 'src', 'components'), boardId: 'alpha',
    })
    await service.moveAsMaster(dev, { ticketId: otherBoard.id, column: 'not_started', beforeTicketId: null, afterTicketId: null })
    const otherResult = await service.assign(dev, otherBoard.id)
    expect(otherResult.worker).toBe('spawned')
    const ticket = await createNotStarted(service, dev, 'default card', join(repo, 'src', 'components'))
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(subagentsStart).toHaveBeenCalledTimes(2)
  })

  it('skips non-running in-flight cards (blocked) in the scope conflict check', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    // Dirty repo blocks the first card (In progress, status blocked).
    await writeFile(join(repo, 'dirty.txt'), 'x\n')
    const first = await createNotStarted(service, dev, 'first card', join(repo, 'src', 'components'))
    const blocked = await service.assign(dev, first.id)
    expect(blocked.ticket.status).toBe('blocked')
    // Clean the repo; the blocked card is not running, so no scope conflict.
    await removeTestPath(join(repo, 'dirty.txt'))
    const second = await createNotStarted(service, dev, 'second card', join(repo, 'src', 'components'))
    const result = await service.assign(dev, second.id)
    expect(result.worker).toBe('spawned')
    expect(subagentsStart).toHaveBeenCalledTimes(1)
  })

  it('resolves the deepest configured repo root for a nested cwd', async () => {
    const repo = await createRepo()
    const sub = join(repo, 'nested')
    await mkdir(sub, { recursive: true })
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: {
        [repo]: { canonicalBranch: 'main' },
        [sub]: { canonicalBranch: 'sub-branch' },
      },
    })
    const dev = masterAgent('dev-agent-a', sub)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'nested cwd card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    // The deepest root governs: its canonical branch does not exist → blocked
    // by THAT config, proving the longest-prefix match won.
    expect(result.worker).toBe('failed')
    expect(result.ticket.status).toBe('blocked')
    expect(result.ticket.failure?.reason).toContain('canonical base branch "sub-branch" does not exist')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('blocks reassign retry on a violated repo and re-dispatches once it is clean', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'retry card', join(repo, 'src', 'a.ts'))
    const first = await service.assign(dev, ticket.id)
    expect(first.worker).toBe('spawned')
    // The tree is now dirty; a master retry must fail closed, no worker.
    await writeFile(join(repo, 'dirty.txt'), 'x\n')
    const retried = await service.reassign(dev, ticket.id, 'retry')
    expect(retried.worker).toBe('failed')
    expect(retried.workerAgentId).toBeNull()
    expect(retried.ticket.status).toBe('blocked')
    expect(retried.ticket.failure?.reason).toContain('dirty.txt')
    expect(subagentsStart).toHaveBeenCalledTimes(1)
    // After cleaning, the retry spawns a fresh worker with the preflight facts.
    await removeTestPath(join(repo, 'dirty.txt'))
    const clean = await service.reassign(dev, ticket.id, 'retry')
    expect(clean.worker).toBe('spawned')
    expect(clean.workerAgentId).toBe('worker-child-agent')
    expect(clean.ticket.status).toBe('running')
    expect(subagentsStart).toHaveBeenCalledTimes(2)
    const call = subagentsStart.mock.calls[1] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('Deterministic repo preflight')
    expect(prompt).toContain('dirty files: (none)')
  })

  it('drops invalid preflight repo configs with warnings and normalizes valid ones', async () => {
    const root = await makeTempDir('taskboard-preflight-cfg-')
    openDirs.push(root)
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root })
    await ctx.plugin(storageDomain, { backend: 'json' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const service = new TaskboardService(ctx, {
      preflightRepos: {
        '/invalid-null': null,
        '/invalid-empty': { canonicalBranch: '   ' },
        '/valid': { canonicalBranch: ' main ', reservedWorktrees: ['ok', '', '  wt  '] },
      },
    } as never)
    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(text => text.includes('invalid config'))).toBe(true)
    expect(warnings.some(text => text.includes('no canonicalBranch'))).toBe(true)
    const normalized = (service as unknown as { resolved: { preflightRepos: Record<string, RepoPreflightConfig> } }).resolved.preflightRepos
    expect(Object.keys(normalized)).toEqual(['/valid'])
    expect(normalized['/valid']).toEqual({ canonicalBranch: 'main', reservedWorktrees: ['ok', 'wt'] })
  })

  it('drops a configured repo whose canonical branch is empty via the plugin path (legacy dispatch)', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: '   ' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'ungoverned card', 'src/a.ts')
    const result = await service.assign(dev, ticket.id)
    // The repo was dropped at load time, so the dispatch keeps the legacy path.
    expect(result.worker).toBe('spawned')
    expect(subagentsStart).toHaveBeenCalledTimes(1)
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).not.toContain('Deterministic repo preflight')
  })

  it('locates the repo from the card filesScope when the master cwd is unmapped (V3-26)', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const elsewhere = await makeTempDir('preflight-elsewhere-')
    openDirs.push(elsewhere)
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    // The scope is absolute and inside the mapped repo; the cwd is not.
    const ticket = await createNotStarted(service, dev, 'scope-located card', join(repo, 'packages', 'x', 'src', 'a.ts'))
    const result = await service.assign(dev, ticket.id)
    // The dispatch passes and the report is gathered from the mapped repo,
    // never from the unmapped cwd (which holds no git facts at all).
    expect(result.worker).toBe('spawned')
    expect(result.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.status).toBe('running')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('canonical base: main @ ' + head)
    expect(prompt).toContain('HEAD: ' + head)
    expect(prompt).toContain('base/candidate relationship: equal')
    expect(prompt).toContain('SAFE')
    expect(prompt).not.toContain('VIOLATED')
  })

  it('prefers the card filesScope repo over a mapped master cwd (V3-26)', async () => {
    const cwdRepo = await createRepo()
    const scopeRepo = await createRepo()
    // Only the scope repo is dirty: a cwd-first resolution would report SAFE.
    await writeFile(join(scopeRepo, 'extra.txt'), 'x\n')
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: {
        [cwdRepo]: { canonicalBranch: 'main' },
        [scopeRepo]: { canonicalBranch: 'main' },
      },
    })
    const dev = masterAgent('dev-agent-a', cwdRepo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'scope wins card', join(scopeRepo, 'src', 'a.ts'))
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.ticket.failure?.reason).toContain('extra.txt')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('uses the first filesScope entry that lands in a configured root, skipping unlocatable ones (V3-26)', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const ungoverned = await makeTempDir('preflight-ungoverned-')
    openDirs.push(ungoverned)
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    // No cwd at all: only the declared scope can locate the repo.
    const dev = masterAgent('dev-agent-a')
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const scope = join(ungoverned, 'src', 'a.ts') + '; src/relative.ts; ' + join(repo, 'src', 'b.ts')
    const ticket = await createNotStarted(service, dev, 'multi entry scope card', scope)
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('canonical base: main @ ' + head)
    expect(prompt).toContain('SAFE')
  })

  it('fails closed naming both misses when neither the filesScope nor the cwd maps (V3-26)', async () => {
    const repo = await createRepo()
    const elsewhere = await makeTempDir('preflight-elsewhere-')
    const ungoverned = await makeTempDir('preflight-ungoverned-')
    openDirs.push(elsewhere, ungoverned)
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const scope = join(ungoverned, 'src', 'a.ts')
    const ticket = await createNotStarted(service, dev, 'both unmapped card', scope)
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.ticket.status).toBe('blocked')
    const reason = result.ticket.failure?.reason ?? ''
    expect(reason).toContain('preflight blocked')
    expect(reason).toContain('no repo mapping')
    expect(reason).toContain('neither the declared filesScope')
    expect(reason).toContain(scope)
    expect(reason).toContain('master cwd')
    expect(reason).toContain(elsewhere)
    expect(reason).toContain('fail closed')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('keeps the cwd fallback when the card declares no filesScope (V3-26)', async () => {
    const repo = await createRepo()
    const head = git(repo, ['rev-parse', 'HEAD'])
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'no scope card', '')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('canonical base: main @ ' + head)
    expect(prompt).toContain('SAFE')
    expect(prompt).toContain('declared file scope: (not declared)')
  })

  it('names the missing filesScope when no scope is declared and the cwd is unmapped (V3-26)', async () => {
    const repo = await createRepo()
    const elsewhere = await makeTempDir('preflight-elsewhere-')
    openDirs.push(elsewhere)
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'no scope unmapped card', '')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    const reason = result.ticket.failure?.reason ?? ''
    expect(reason).toContain('declares no filesScope')
    expect(reason).toContain(elsewhere)
    // Distinct from the both-missing wording: here the operator fixes the cwd.
    expect(reason).not.toContain('neither the declared filesScope')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('facts-only mode injects facts and never blocks when the repo came from the filesScope (V3-26)', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'extra.txt'), 'x\n')
    const elsewhere = await makeTempDir('preflight-elsewhere-')
    openDirs.push(elsewhere)
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: { [repo]: { canonicalBranch: 'main', enforce: false } },
    })
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'facts-only scope card', join(repo, 'src', 'a.ts'))
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(result.workerAgentId).toBe('worker-child-agent')
    expect(result.ticket.status).toBe('running')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('Deterministic repo preflight (computed at dispatch time)')
    expect(prompt).toContain('extra.txt')
    expect(prompt).toContain('VIOLATED')
  })

  it('re-dispatch retry locates the repo from the filesScope when the cwd is unmapped (V3-26)', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'dirty.txt'), 'x\n')
    const elsewhere = await makeTempDir('preflight-elsewhere-')
    openDirs.push(elsewhere)
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'retry scope card', join(repo, 'src', 'a.ts'))
    // The scope-located repo is dirty: the retry must fail closed, no worker.
    const first = await service.assign(dev, ticket.id)
    expect(first.worker).toBe('failed')
    expect(first.ticket.failure?.reason).toContain('dirty.txt')
    expect(subagentsStart).not.toHaveBeenCalled()
    await removeTestPath(join(repo, 'dirty.txt'))
    const retried = await service.reassign(dev, ticket.id, 'retry')
    expect(retried.worker).toBe('spawned')
    expect(retried.workerAgentId).toBe('worker-child-agent')
    expect(retried.ticket.status).toBe('running')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('dirty files: (none)')
    expect(prompt).toContain('SAFE')
  })

  it('names the cwd fallback when the scope carries no absolute entry (V3-33)', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    // Every entry is relative, so locatePreflightRepo skips all of them and the
    // repo comes from the mapped master cwd: the card never chose its repo.
    const ticket = await createNotStarted(service, dev, 'relative scope card', 'packages/x/src; scripts/')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.ticket.status).toBe('blocked')
    const reason = result.ticket.failure?.reason ?? ''
    expect(reason).toContain('preflight blocked')
    expect(reason).toContain('declares only relative path(s) and no absolute entry')
    expect(reason).toContain('falling back to the master cwd "' + repo + '"')
    expect(reason).toContain('declare absolute filesScope paths')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('names the relative-scope cwd fallback in facts-only mode without blocking (V3-33)', async () => {
    const repo = await createRepo()
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: { [repo]: { canonicalBranch: 'main', enforce: false } },
    })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'relative facts-only card', 'packages/x/src')
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(result.ticket.status).toBe('running')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    // enforce:false keeps the dispatch alive, but the fallback is still named
    // where the operator and the worker both read it.
    expect(prompt).toContain('VIOLATED')
    expect(prompt).toContain('declares only relative path(s) and no absolute entry')
    expect(prompt).toContain('falling back to the master cwd "' + repo + '"')
    expect(prompt).toContain('declared file scope: packages/x/src')
  })

  it('never warns while an absolute scope entry still chooses the repo (V3-33)', async () => {
    const cwdRepo = await createRepo()
    const scopeRepo = await createRepo()
    const head = git(scopeRepo, ['rev-parse', 'HEAD'])
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: {
        [cwdRepo]: { canonicalBranch: 'main' },
        [scopeRepo]: { canonicalBranch: 'main' },
      },
    })
    const dev = masterAgent('dev-agent-a', cwdRepo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    // A relative entry rides alongside the absolute one: the absolute entry
    // still chooses the repo, and no cwd-fallback warning is raised.
    const ticket = await createNotStarted(service, dev, 'mixed scope card', 'packages/relative; ' + join(scopeRepo, 'src', 'a.ts'))
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('canonical base: main @ ' + head)
    expect(prompt).toContain('SAFE')
    expect(prompt).not.toContain('declares only relative path(s)')
    expect(prompt).not.toContain('falling back to the master cwd')
  })

  it('names the cwd fallback when every absolute scope entry misses the configured roots (V3-41)', async () => {
    const repo = await createRepo()
    const elsewhere = await makeTempDir('preflight-outside-')
    openDirs.push(elsewhere)
    // One absolute entry exists but is governed by no configured root; the
    // other does not exist at all. Both miss, so the repo still comes from the
    // mapped master cwd and V3-41 names that instead of passing silently.
    const existing = join(elsewhere, 'keep.ts')
    const absent = join(elsewhere, 'gone', 'b.ts')
    await writeFile(existing, 'x\n')
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'missing absolute scope card', existing + '; ' + absent)
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('failed')
    expect(result.ticket.status).toBe('blocked')
    const reason = result.ticket.failure?.reason ?? ''
    expect(reason).toContain('preflight blocked')
    expect(reason).toContain('declares absolute entry/entries')
    // Each entry carries its own miss reason: outside the configured roots vs
    // absent from disk, so the operator knows which declaration to move. The
    // report quotes the normalized scope entry (forward slashes), not the raw
    // platform path.
    expect(reason).toContain('"' + slash(existing) + '" (exists but is outside every configured preflight repo root)')
    expect(reason).toContain('"' + slash(absent) + '" (does not exist on disk)')
    expect(reason).toContain('none of which lands inside any configured preflight repo root')
    expect(reason).toContain('falling back to the master cwd "' + repo + '"')
    expect(reason).not.toContain('declares only relative path(s)')
    expect(subagentsStart).not.toHaveBeenCalled()
  })

  it('names the missed absolute scope entries in facts-only mode without blocking (V3-41)', async () => {
    const repo = await createRepo()
    const elsewhere = await makeTempDir('preflight-outside-facts-')
    openDirs.push(elsewhere)
    const absent = join(elsewhere, 'absent', 'b.ts')
    const { ctx, service, subagentsStart } = await harness({
      preflightRepos: { [repo]: { canonicalBranch: 'main', enforce: false } },
    })
    const dev = masterAgent('dev-agent-a', repo)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'missing scope facts-only card', absent)
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    expect(result.ticket.status).toBe('running')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    // enforce:false keeps the dispatch alive, but the widened fallback notice
    // still reaches the worker prompt.
    expect(prompt).toContain('VIOLATED')
    expect(prompt).toContain('declares absolute entry/entries')
    expect(prompt).toContain('"' + slash(absent) + '" (does not exist on disk)')
    expect(prompt).toContain('falling back to the master cwd "' + repo + '"')
    expect(prompt).toContain('declared file scope: ' + absent)
  })

  it('never warns while one absolute scope entry still hits a configured root (V3-41)', async () => {
    const repo = await createRepo()
    const elsewhere = await makeTempDir('preflight-outside-mixed-')
    openDirs.push(elsewhere)
    const head = git(repo, ['rev-parse', 'HEAD'])
    const { ctx, service, subagentsStart } = await harness({ preflightRepos: { [repo]: { canonicalBranch: 'main' } } })
    // The cwd is unmapped, so only the scope can locate the repo: a missing
    // absolute entry riding alongside a governed one must not trigger the
    // fallback warning — the miss is judged per entry, not per scope.
    const dev = masterAgent('dev-agent-a', elsewhere)
    ctx.agents.register(dev)
    await service.claimMaster('default', dev)
    const ticket = await createNotStarted(service, dev, 'mixed miss scope card', join(elsewhere, 'gone.ts') + '; ' + join(repo, 'src', 'a.ts'))
    const result = await service.assign(dev, ticket.id)
    expect(result.worker).toBe('spawned')
    const call = subagentsStart.mock.calls[0] as [string, SubagentStartRequest]
    const prompt = (call[1].prompt as { type: string; text: string }[])[0]!.text
    expect(prompt).toContain('canonical base: main @ ' + head)
    expect(prompt).toContain('SAFE')
    expect(prompt).not.toContain('declares absolute entry/entries')
    expect(prompt).not.toContain('declares only relative path(s)')
    expect(prompt).not.toContain('falling back to the master cwd')
  })
})
