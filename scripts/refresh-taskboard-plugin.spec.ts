import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { packDirectory } from './emit-taskboard-standalone.ts'
import {
  DEFAULT_PROFILE,
  ledgerHash,
  locateCandidate,
  locatePnpmOnPath,
  parseSums,
  performRollback,
  readProfileManifest,
  resolveInstallInvocation,
  runRefresh,
  verifyArtifacts,
  type PackageManagerInvocation,
  type RefreshIo,
  type RefreshOptions,
} from './refresh-taskboard-plugin.ts'

const HOST = '@deepseek-ai/dsh-taskboard'
const TAB = '@deepseek-ai/dsh-client-ui-taskboard'
const VERSION = '0.1.5-alpha.1'
const HOST_DEPS: Record<string, string> = { zod: '^4.4.3', '@deepseek-ai/schemastery': '^0.1.5-rc.2' }
const TAB_DEPS: Record<string, string> = { clsx: '^2.0.0' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, undefined, 2) + '\n')
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function writePackage(dir: string, manifest: Record<string, unknown>, dependency: string): void {
  writeJson(join(dir, 'package.json'), manifest)
  writeText(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: ' + dependency + '\n')
  writeText(join(dir, 'lib', 'index.js'), 'export const marker = ' + JSON.stringify(manifest.name) + '\n')
}

/** One packed plugin tarball inside a candidate tree. */
interface PackedFixture {
  /** Published package name. */
  name: string
  /** Package version. */
  version: string
  /** Absolute tarball path. */
  file: string
}

function packPlugin(candidate: string, name: string, slug: string, dependencies: Record<string, string>): PackedFixture {
  const staging = join(candidate, '.staging', slug)
  writePackage(staging, { name, version: VERSION, dependencies, dsh: { bundle: { patch: './cordis.patch.yml' } } }, slug)
  const file = join(candidate, 'releases', slug + '-' + VERSION + '.tgz')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, packDirectory(staging))
  return { name, version: VERSION, file }
}

/**
 * Emit a candidate tree: two tarballs plus a ledger that deliberately lists two
 * different README.md files, the shape that broke a basename-keyed lookup.
 * @param root - scratch root for the candidate.
 * @returns the candidate directory and its packed plugins.
 */
function candidateTree(root: string): { candidate: string; plugins: PackedFixture[] } {
  const candidate = join(root, 'candidate')
  const plugins = [packPlugin(candidate, HOST, 'dsh-taskboard', HOST_DEPS), packPlugin(candidate, TAB, 'dsh-client-ui-taskboard', TAB_DEPS)]
  return { candidate, plugins }
}

function writeLedger(candidate: string, plugins: readonly PackedFixture[], tamper?: string): void {
  const lines: string[] = ['d'.repeat(64) + '  packages/dsh-taskboard/README.md', 'e'.repeat(64) + '  packages/dsh-client-ui-taskboard/README.md']
  for (const plugin of plugins) {
    const bytes = readFileSync(plugin.file)
    const hash = plugin.name === tamper ? digest('tampered') : digest(bytes)
    lines.push(hash + '  releases/' + basename(plugin.file))
  }
  writeText(join(candidate, 'SHA256SUMS'), lines.join('\n') + '\n')
}

/** Seed a profile directory plus the installed tree a real pnpm install would leave. */
interface ProfileFixture {
  /** Harness home. */
  home: string
  /** Absolute profile directory. */
  profileDir: string
  /** The profile package.json before any refresh. */
  before: string
}

function seedProfile(root: string, mode: 'installed' | 'linked'): ProfileFixture {
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', DEFAULT_PROFILE)
  const fileDeps: Record<string, string> = {
    [HOST]: 'file:D:/Plugins/dsh-taskboard-standalone/releases/dsh-taskboard-' + VERSION + '.tgz',
    [TAB]: 'file:D:/Plugins/dsh-taskboard-standalone/releases/dsh-client-ui-taskboard-' + VERSION + '.tgz',
    'dsh-whale-widget': 'link:D:/Plugins/dsh-whale-widget',
  }
  const linkDeps: Record<string, string> = {
    [HOST]: 'link:D:/Plugins/dsh-taskboard-standalone/packages/dsh-taskboard',
    [TAB]: 'link:D:/Plugins/dsh-taskboard-standalone/packages/dsh-client-ui-taskboard',
    'dsh-whale-widget': 'link:D:/Plugins/dsh-whale-widget',
  }
  writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: mode === 'installed' ? fileDeps : linkDeps,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-whale-widget'], patchReload: 'live' } },
  })
  writeText(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeText(join(profileDir, 'cordis.yml'), '[]\n')
  writeText(join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: taskboard\n      name: ' + HOST + '\n')
  if (mode === 'linked') {
    // The accident's shape: pnpm recorded a symlink, so the linked package's own
    // runtime dependencies are absent from the profile.
    writePackage(join(profileDir, 'node_modules', HOST), { name: HOST, version: VERSION, dependencies: HOST_DEPS }, 'taskboard')
    writePackage(join(profileDir, 'node_modules', TAB), { name: TAB, version: VERSION, dependencies: TAB_DEPS }, 'ui-taskboard')
  }
  if (mode === 'installed') {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    writePackage(join(profileDir, 'node_modules', HOST), { name: HOST, version: VERSION, dependencies: HOST_DEPS }, 'taskboard')
    writePackage(join(profileDir, 'node_modules', TAB), { name: TAB, version: VERSION, dependencies: TAB_DEPS }, 'ui-taskboard')
    writeJson(join(profileDir, 'node_modules', 'zod', 'package.json'), { name: 'zod', version: '4.4.3' })
    writeJson(join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'), { name: '@deepseek-ai/schemastery', version: '0.1.5-rc.2' })
    writeJson(join(profileDir, 'node_modules', 'clsx', 'package.json'), { name: 'clsx', version: '2.0.0' })
  }
  return { home, profileDir, before: readFileSync(join(profileDir, 'package.json'), 'utf8') }
}

/** The command line an invocation will actually run, for assertions. */
function invocationLine(invocation: PackageManagerInvocation): string {
  return invocation.command + ' ' + invocation.args.join(' ')
}

/** The stub install the fake surface resolves unless a test says otherwise. */
const STUB_INVOCATION: PackageManagerInvocation = {
  command: 'pnpm',
  args: ['install'],
  shell: false,
  display: 'pnpm install',
  origin: 'test stub',
}

/** A RefreshIo that records everything and never touches the network. */
interface FakeIo extends RefreshIo {
  /** Every line the run logged. */
  lines: string[]
  /** Every profile directory an install ran in. */
  installCalls: string[]
  /** Every invocation an install was handed. */
  installInvocations: PackageManagerInvocation[]
  /** Every build output directory requested. */
  buildCalls: string[]
}

function fakeIo(options: {
  confirm?: boolean
  installStatus?: number
  invocation?: PackageManagerInvocation
  onInstall?: (profileDir: string) => void
  onBuild?: (out: string) => void
} = {}): FakeIo {
  const lines: string[] = []
  const installCalls: string[] = []
  const installInvocations: PackageManagerInvocation[] = []
  const buildCalls: string[] = []
  const invocation = options.invocation ?? STUB_INVOCATION
  return {
    lines,
    installCalls,
    installInvocations,
    buildCalls,
    log: (line) => {
      lines.push(line)
    },
    confirm: async () => options.confirm !== false,
    resolveInstall: () => invocation,
    install: (profileDir, resolved) => {
      installCalls.push(profileDir)
      installInvocations.push(resolved)
      options.onInstall?.(profileDir)
      return { status: options.installStatus ?? 0, command: resolved.display, output: 'ok' }
    },
    build: (out) => {
      buildCalls.push(out)
      options.onBuild?.(out)
    },
    gitSha: () => 'deadbeef',
    now: () => new Date('2026-09-23T12:00:00Z'),
  }
}

function options(home: string, candidate: string, overrides: Partial<RefreshOptions> = {}): RefreshOptions {
  return {
    profile: DEFAULT_PROFILE,
    home,
    artifactsRoot: join(home, 'artifacts'),
    candidate,
    tag: undefined,
    apply: false,
    noBuild: false,
    keepBuild: false,
    faultSkipInstall: false,
    rollback: undefined,
    help: false,
    ...overrides,
  }
}

function posix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Build one candidate tree with its ledger and return the pair. */
function readyCandidate(root: string): { candidate: string; plugins: PackedFixture[] } {
  const built = candidateTree(root)
  writeLedger(built.candidate, built.plugins)
  return built
}

describe('artifact ledger', () => {
  it('keys entries by full path, so two README.md files cannot collide', () => {
    const entries = parseSums('a'.repeat(64) + '  packages/dsh-taskboard/README.md\n' + 'b'.repeat(64) + '  packages/x/README.md\n')
    expect(entries).toEqual([
      { path: 'packages/dsh-taskboard/README.md', sha256: 'a'.repeat(64) },
      { path: 'packages/x/README.md', sha256: 'b'.repeat(64) },
    ])
  })

  it('finds a tarball by path suffix and refuses one the ledger does not cover', () => {
    const root = fixture('dsh-refresh-ledger-')
    const { candidate, plugins } = readyCandidate(root)
    const entries = parseSums(readFileSync(join(candidate, 'SHA256SUMS'), 'utf8'))
    expect(ledgerHash(entries, plugins[0]!.file)).toBe(digest(readFileSync(plugins[0]!.file)))
    expect(() => ledgerHash(entries, join(root, 'elsewhere', 'other.tgz'))).toThrow(/no entry for other\.tgz/)
  })

  it('refuses a tampered artifact', () => {
    const root = fixture('dsh-refresh-tamper-')
    const { candidate, plugins } = candidateTree(root)
    writeLedger(candidate, plugins, HOST)
    expect(() => verifyArtifacts(plugins.map(plugin => plugin.file), readFileSync(join(candidate, 'SHA256SUMS'), 'utf8')))
      .toThrow(/sha256 mismatch for dsh-taskboard-0\.1\.5-alpha\.1\.tgz/)
  })

  it('refuses a candidate that is a package directory rather than tarballs', () => {
    const root = fixture('dsh-refresh-locate-')
    const packageDir = join(root, 'packages', 'dsh-taskboard')
    writePackage(packageDir, { name: HOST, version: VERSION }, 'taskboard')
    expect(() => locateCandidate(packageDir)).toThrow(/holds no \.tgz artifact/)
    expect(() => locateCandidate(join(root, 'missing'))).toThrow(/is not a directory/)
  })
})

describe('package manager resolution', () => {
  it('uses npm_execpath only when it is pnpm', () => {
    const invocation = resolveInstallInvocation(
      { npm_execpath: 'C:/pnpm/pnpm.cjs', npm_config_user_agent: 'pnpm/12.4.2 npm/? node/v24 win32 x64' },
      () => undefined,
    )
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.args).toEqual(['C:/pnpm/pnpm.cjs', 'install'])
    expect(invocation.display).toBe('pnpm install')
    expect(invocation.origin).toContain('pnpm lifecycle')
  })

  it('never runs npm when npm started the script', () => {
    const located = join('C:', 'tools', 'pnpm.cmd')
    const invocation = resolveInstallInvocation(
      { npm_execpath: 'C:/node/npm-cli.js', npm_config_user_agent: 'npm/10.9.0 node/v24 win32 x64' },
      () => located,
    )
    expect(invocationLine(invocation)).toContain(located)
    expect(invocationLine(invocation)).not.toContain('npm-cli.js')
    expect(invocation.display).toBe('pnpm install')
    expect(invocation.origin).toContain('is not pnpm and is not used')
  })

  it('ignores a contradictory user agent that claims pnpm over an npm execpath', () => {
    const invocation = resolveInstallInvocation(
      { npm_execpath: 'C:/node/npm-cli.js', npm_config_user_agent: 'pnpm/12.0.0 node/v24' },
      () => 'pnpm',
    )
    expect(invocationLine(invocation)).toContain('pnpm')
    expect(invocationLine(invocation)).not.toContain('npm-cli.js')
  })

  it('folds a Windows .cmd shim into one shell command line', () => {
    const located = join('C:', 'tools', 'pnpm.cmd')
    const invocation = resolveInstallInvocation({ npm_execpath: 'C:/node/npm-cli.js' }, () => located)
    if (process.platform === 'win32') {
      expect(invocation.shell).toBe(true)
      expect(invocation.args).toEqual([])
      expect(invocation.command).toContain(located)
      expect(invocation.command).toContain('install')
      return
    }
    expect(invocation.shell).toBe(false)
    expect(invocation.args).toEqual(['install'])
  })

  it('refuses with an actionable message instead of installing with npm', () => {
    const refuse = (): PackageManagerInvocation =>
      resolveInstallInvocation({ npm_execpath: 'C:/node/npm-cli.js' }, () => undefined)
    expect(refuse).toThrow(/cannot find pnpm on PATH/)
    expect(refuse).toThrow(/does not implement the link: protocol/)
    expect(refuse).toThrow(/npm_execpath points at C:\/node\/npm-cli\.js/)
  })

  it('locates pnpm on PATH and reports none when PATH carries no pnpm', () => {
    const root = fixture('dsh-refresh-pnpm-')
    writeText(join(root, 'pnpm.cmd'), '@echo off' + String.fromCharCode(10))
    expect(locatePnpmOnPath({ PATH: root }, 'win32')).toBe(join(root, 'pnpm.cmd'))
    expect(locatePnpmOnPath({ PATH: join(root, 'empty') }, 'win32')).toBeUndefined()
    expect(locatePnpmOnPath({ PATH: root }, 'linux')).toBeUndefined()
  })

  it('logs the resolved command rather than a hardcoded pnpm line', async () => {
    const root = fixture('dsh-refresh-log-')
    const { candidate } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    const invocation: PackageManagerInvocation = {
      command: 'C:/tools/pnpm.cmd',
      args: ['install'],
      shell: true,
      display: 'pnpm install (C:/tools/pnpm.cmd)',
      origin: 'resolved for the test',
    }
    const io = fakeIo({ invocation })
    expect(await runRefresh(options(profile.home, candidate, { apply: true }), io)).toBe(0)
    expect(io.installInvocations).toEqual([invocation])
    expect(io.lines.some(line => line.includes('install: running pnpm install (C:/tools/pnpm.cmd)'))).toBe(true)
    expect(io.lines.some(line => line === 'install: pnpm install (C:/tools/pnpm.cmd) succeeded')).toBe(true)
  })

  it('refuses before any write when no pnpm can be resolved', async () => {
    const root = fixture('dsh-refresh-nopnpm-')
    const { candidate } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    const io = fakeIo()
    io.resolveInstall = () => {
      throw new Error('cannot find pnpm on PATH; npm does not implement the link: protocol')
    }
    await expect(runRefresh(options(profile.home, candidate, { apply: true }), io)).rejects.toThrow(/cannot find pnpm/)
    expect(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')).toBe(profile.before)
    expect(existsSync(join(profile.home, 'artifacts'))).toBe(false)
    expect(existsSync(join(profile.home, 'backups'))).toBe(false)
    expect(io.installCalls).toEqual([])
  })
})

describe('refresh flow', () => {
  it('dry-run writes nothing and never installs', async () => {
    const root = fixture('dsh-refresh-dry-')
    const { candidate } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    const io = fakeIo()
    const code = await runRefresh(options(profile.home, candidate), io)
    expect(code).toBe(0)
    expect(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')).toBe(profile.before)
    expect(existsSync(join(profile.home, 'artifacts'))).toBe(false)
    expect(existsSync(join(profile.home, 'backups'))).toBe(false)
    expect(io.installCalls).toEqual([])
    expect(io.lines.some(line => line.includes('dry-run: wrote nothing'))).toBe(true)
  })

  it('aborts on a refused confirmation without writing anything', async () => {
    const root = fixture('dsh-refresh-abort-')
    const { candidate } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    const io = fakeIo({ confirm: false })
    const code = await runRefresh(options(profile.home, candidate, { apply: true }), io)
    expect(code).toBe(1)
    expect(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')).toBe(profile.before)
    expect(existsSync(join(profile.home, 'artifacts'))).toBe(false)
    expect(io.installCalls).toEqual([])
  })

  it('archives by version+sha, packs a rollback, switches only the two specs, and self-checks', async () => {
    const root = fixture('dsh-refresh-apply-')
    const { candidate, plugins } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    const io = fakeIo()
    const code = await runRefresh(options(profile.home, candidate, { apply: true }), io)
    expect(code).toBe(0)

    const archive = join(profile.home, 'artifacts', 'releases', VERSION + '-deadbeef')
    expect(existsSync(join(archive, 'SHA256SUMS'))).toBe(true)
    expect(existsSync(join(archive, 'provenance.json'))).toBe(true)
    expect(existsSync(join(archive, basename(plugins[0]!.file)))).toBe(true)
    expect(readFileSync(join(archive, 'SHA256SUMS'), 'utf8')).toContain(digest(readFileSync(plugins[0]!.file)))

    const manifest = readProfileManifest(profile.profileDir)
    expect(manifest.dependencies[HOST]).toBe('file:' + posix(join(archive, basename(plugins[0]!.file))))
    expect(manifest.dependencies[TAB]).toBe('file:' + posix(join(archive, basename(plugins[1]!.file))))
    expect(manifest.dependencies['dsh-whale-widget']).toBe('link:D:/Plugins/dsh-whale-widget')
    expect(manifest.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-whale-widget'])
    expect(manifest.raw.private).toBe(true)

    const backups = readdirSyncSafe(join(profile.home, 'backups'))
    expect(backups).toHaveLength(1)
    const pack = join(profile.home, 'backups', backups[0]!)
    const packed = readdirSyncSafe(pack).sort()
    expect(packed).toContain('ROLLBACK.md')
    expect(packed).toContain('backup-manifest.json')
    expect(packed).toContain('artifacts-candidate-SHA256SUMS')
    expect(readFileSync(join(pack, 'package.json'), 'utf8')).toBe(profile.before)
    expect(io.installCalls).toEqual([profile.profileDir])
    expect(io.lines.some(line => line.includes('self-check: resolved 5 package(s)'))).toBe(true)
    expect(io.lines.some(line => line.includes('restart with dsh --profile web'))).toBe(true)
  })

  it('refuses the switch and restores the pre-switch profile when a runtime dependency is missing', async () => {
    const root = fixture('dsh-refresh-refuse-')
    const { candidate } = readyCandidate(root)
    const profile = seedProfile(root, 'linked')
    const io = fakeIo()
    const code = await runRefresh(options(profile.home, candidate, { apply: true, faultSkipInstall: true }), io)
    expect(code).toBe(1)
    expect(io.lines.some(line => line.includes('REFUSED: a plugin runtime dependency is unreachable'))).toBe(true)
    expect(io.lines.some(line => line.includes('requires zod'))).toBe(true)
    expect(io.lines.some(line => line.includes('rollback: profile files restored'))).toBe(true)
    expect(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')).toBe(profile.before)
    expect(io.installCalls).toEqual([profile.profileDir])
  })

  it('refuses to overwrite an archive directory that already exists', async () => {
    const root = fixture('dsh-refresh-tag-')
    const { candidate } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    expect(await runRefresh(options(profile.home, candidate, { apply: true }), fakeIo())).toBe(0)
    writeText(join(profile.profileDir, 'package.json'), profile.before)
    await expect(runRefresh(options(profile.home, candidate, { apply: true }), fakeIo()))
      .rejects.toThrow(/already exists/)
    expect(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')).toBe(profile.before)
    expect(readdirSyncSafe(join(profile.home, 'backups'))).toHaveLength(1)
  })

  it('builds a candidate when none is given and cleans the temporary directory', async () => {
    const root = fixture('dsh-refresh-build-')
    const { candidate, plugins } = readyCandidate(root)
    const profile = seedProfile(root, 'installed')
    const io = fakeIo({
      onBuild: (out) => {
        mkdirSync(join(out, 'releases'), { recursive: true })
        for (const plugin of plugins) writeFileSync(join(out, 'releases', basename(plugin.file)), readFileSync(plugin.file))
        writeFileSync(join(out, 'SHA256SUMS'), readFileSync(join(candidate, 'SHA256SUMS')))
      },
    })
    const code = await runRefresh(options(profile.home, candidate, { candidate: undefined }), io)
    expect(code).toBe(0)
    expect(io.buildCalls).toHaveLength(1)
    expect(existsSync(io.buildCalls[0]!)).toBe(false)
    expect(io.lines.some(line => line.includes('removed the temporary build directory'))).toBe(true)
  })
})

describe('rollback', () => {
  it('restores saved files and removes files that did not exist before the switch', async () => {
    const root = fixture('dsh-refresh-rollback-')
    const profile = seedProfile(root, 'installed')
    const pack = join(root, 'pack')
    writeText(join(pack, 'package.json'), profile.before)
    writeJson(join(pack, 'backup-manifest.json'), {
      profile: DEFAULT_PROFILE,
      profileDir: profile.profileDir,
      savedAt: '2026-09-23T12:00:00.000Z',
      candidateArchive: 'D:/Plugins/dsh-taskboard-standalone/releases/x',
      files: {
        'package.json': { present: true, sha256: digest(profile.before) },
        'pnpm-lock.yaml': { present: false },
      },
      ledgers: {},
    })
    writeText(join(profile.profileDir, 'package.json'), '{"changed":true}\n')
    writeText(join(profile.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const io = fakeIo()
    expect(performRollback(pack, io)).toBe(0)
    expect(readFileSync(join(profile.profileDir, 'package.json'), 'utf8')).toBe(profile.before)
    expect(existsSync(join(profile.profileDir, 'pnpm-lock.yaml'))).toBe(false)
    expect(io.installCalls).toEqual([profile.profileDir])
  })
})

/**
 * List a directory's entry names.
 * @param path - the directory to read.
 * @returns the entry names.
 */
function readdirSyncSafe(path: string): string[] {
  return readdirSync(path)
}
