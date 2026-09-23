/**
 * Emit the standalone, DSH-free release form of the Taskboard plugins: a
 * self-contained repository tree that installs into any released `dsh` with
 * one `dsh plugin add` — no DSH source tree, no `workspace:` protocol, no
 * `node_modules`.
 *
 * The monorepo manifests must keep `workspace:^` (pnpm links them that way),
 * so every rewrite happens on the emitted copies only. This script never writes
 * inside the two source package directories.
 *
 * Pipeline: build the two packages with the repository's own tooling, rewrite
 * each manifest to its publish form, assemble the published file set, pack both
 * deterministic tarballs, then audit the result for leaked workspace protocol,
 * vendored host source, and node_modules.
 *
 * The tree defaults to a directory outside this checkout: the documentation
 * gates read every Markdown pair in the working tree, and the emitted README
 * pair links the standalone repository's layout, so a tree left inside the
 * checkout turns `pnpm run test:docs` red until it is deleted. `--out` still
 * selects any location, including one inside the checkout.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'

/** Repository root, derived from this script's location under `scripts/`. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The default output directory for the emitted tree.
 *
 * It sits outside the checkout on purpose: the documentation gates walk the
 * working tree, and an emitted README pair links the standalone repository's
 * layout, so a tree left inside the checkout fails `pnpm run test:docs` until it
 * is deleted. Naming the directory after the checkout keeps parallel worktrees
 * from overwriting each other's release.
 * @returns the absolute default output directory.
 */
export function defaultOutDir(): string {
  return join(tmpdir(), 'dsh-taskboard-standalone-' + basename(REPO_ROOT))
}

/**
 * Render a path for the log: repository-relative when it is inside the
 * checkout, absolute otherwise (the default output directory is outside it).
 * @param file - the path to render.
 * @returns the human-facing path.
 */
function displayPath(file: string): string {
  const shown = relative(REPO_ROOT, file)
  return shown.startsWith('..') ? file : shown
}

/** The remote that carries the emitted tree on its `main` branch. */
export const STANDALONE_REMOTE = 'https://github.com/OyangDer/Automated-Agent-Workflow.git'

/** Fixed POSIX mtime stamped into every tar entry, so packing is reproducible. */
const TAR_MTIME = 0

/** One plugin package lifted from the monorepo into the standalone tree. */
export interface PluginPackage {
  /** Published package name. */
  name: string
  /** Monorepo-relative source directory. */
  dir: string
  /** Directory name inside the emitted `packages/` tree. */
  slug: string
}

/** The two packages the standalone release ships. */
export const PLUGIN_PACKAGES: readonly [PluginPackage, PluginPackage] = [
  { name: '@deepseek-ai/dsh-taskboard', dir: 'packages/taskboard/taskboard', slug: 'dsh-taskboard' },
  {
    name: '@deepseek-ai/dsh-client-ui-taskboard',
    dir: 'packages/client/ui-taskboard',
    slug: 'dsh-client-ui-taskboard',
  },
]

/** Options accepted on the command line. */
export interface EmitOptions {
  /** Output directory for the emitted tree. */
  out: string
  /** Whether to build the two packages before emitting. */
  build: boolean
  /** Print usage and exit without emitting. */
  help: boolean
}

function slash(path: string): string {
  return path.split(sep).join('/')
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Every file below `root`, as `/`-joined paths relative to it, sorted. */
export function walk(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else found.push(slash(relative(root, path)))
    }
  }
  visit(root)
  return found.sort()
}

/**
 * Map every workspace package name to its monorepo version.
 * @param root - repository root holding the workspace manifest.
 * @returns name to version for every package the `workspaces` globs reach.
 */
export function workspaceVersions(root: string = REPO_ROOT): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] }
  const versions = new Map<string, string>()
  for (const pattern of manifest.workspaces ?? []) {
    for (const relativeManifest of globSync(`${pattern}/package.json`, { cwd: root })) {
      const path = slash(relativeManifest)
      if (path.includes('node_modules/')) continue
      const pkg = JSON.parse(readFileSync(join(root, path), 'utf8')) as { name?: string; version?: string }
      if (pkg.name !== undefined && pkg.version !== undefined) versions.set(pkg.name, pkg.version)
    }
  }
  return versions
}

/**
 * Rewrite one dependency spec out of the `workspace:` protocol.
 * @param name - the dependency's package name.
 * @param spec - the manifest's current spec.
 * @param versions - workspace name to version.
 * @returns the spec with real semver, or the spec unchanged.
 */
export function rewriteWorkspaceSpec(
  name: string,
  spec: string,
  versions: ReadonlyMap<string, string>,
): string {
  if (!spec.startsWith('workspace:')) return spec
  const version = versions.get(name)
  if (version === undefined) {
    throw new Error(`emit-taskboard-standalone: no workspace version for ${name}`)
  }
  const range = spec.slice('workspace:'.length)
  if (range === '') return version
  if (range === '*') return version
  if (range === '^') return `^${version}`
  if (range === '~') return `~${version}`
  return range
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * Build a package's publish-form manifest: real semver everywhere, no
 * development-only fields, and the standalone repository as the origin.
 * @param manifest - the monorepo manifest, read verbatim.
 * @param versions - workspace name to version.
 * @returns a fresh manifest safe to publish or commit to the standalone repo.
 */
export function toPublishManifest(
  manifest: Record<string, unknown>,
  versions: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest }
  delete out.devDependencies
  // The emitted package ships built artifacts; its bundle scripts reference a
  // devDependency the standalone tree deliberately does not carry.
  delete out.scripts
  for (const field of DEPENDENCY_FIELDS) {
    const declared = out[field] as Record<string, string> | undefined
    if (declared === undefined) continue
    const rewritten: Record<string, string> = {}
    for (const [name, spec] of Object.entries(declared).sort(([a], [b]) => (a < b ? -1 : 1))) {
      rewritten[name] = rewriteWorkspaceSpec(name, spec, versions)
    }
    out[field] = rewritten
  }
  out.repository = { type: 'git', url: `git+${STANDALONE_REMOTE}` }
  return out
}

/**
 * Expand a manifest's `files` list against the package directory.
 * @param packageDir - the source package directory.
 * @param patterns - the manifest's `files` entries.
 * @returns package-relative `/`-joined paths, sorted and deduplicated.
 */
export function collectPublishedFiles(packageDir: string, patterns: readonly string[]): string[] {
  const collected = new Set<string>()
  for (const pattern of patterns) {
    if (/[*?]/.test(pattern)) {
      const matches = globSync(pattern, { cwd: packageDir })
        .map(slash)
        .filter(path => !path.split('/').includes('node_modules'))
      if (matches.length === 0) {
        throw new Error(`emit-taskboard-standalone: files pattern matched nothing: ${pattern}`)
      }
      for (const match of matches) collected.add(match)
      continue
    }
    if (!existsSync(join(packageDir, pattern))) {
      throw new Error(`emit-taskboard-standalone: files entry is missing: ${pattern}`)
    }
    collected.add(pattern)
  }
  return [...collected].sort()
}

interface TarEntry {
  path: string
  data: Buffer
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`tar: field overflow for ${value}`)
  bytes.copy(buffer, offset)
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

/**
 * Serialize entries as a POSIX ustar archive with a fixed mtime.
 * @param entries - archive members, in the order they should be written.
 * @returns the raw tar bytes.
 */
export function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    writeString(header, 0, 100, entry.path)
    writeOctal(header, 100, 8, 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, entry.data.length)
    writeOctal(header, 136, 12, TAR_MTIME)
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    writeString(header, 257, 6, 'ustar')
    writeString(header, 263, 2, '00')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, entry.data)
    const padding = (512 - (entry.data.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/**
 * Pack one emitted package directory the way a registry would: every member
 * under a `package/` prefix, gzipped deterministically.
 * @param packageDir - the assembled publish-form package directory.
 * @returns tarball bytes.
 */
export function packDirectory(packageDir: string): Buffer {
  const entries: TarEntry[] = walk(packageDir).map(path => ({
    path: `package/${path}`,
    data: readFileSync(join(packageDir, path)),
  }))
  return gzipSync(tar(entries), { level: 9 })
}

/** Resolve a workspace-installed package's CLI entry script. */
function packageBin(name: string, binName: string): string {
  const manifestPath = join(REPO_ROOT, 'node_modules', name, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (bin === undefined) {
    throw new Error(`emit-taskboard-standalone: ${name} declares no ${binName} bin`)
  }
  return join(dirname(manifestPath), bin)
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`emit-taskboard-standalone: ${command} ${args.join(' ')} exited ${result.status ?? 1}`)
  }
}

/**
 * Build both packages with the repository's own tooling. Scope is deliberate:
 * the TypeScript project references plus a filtered tsdown pass for the host
 * half and the package-local Client pass for the browser half reproduce the
 * artifacts the full workspace build emits, without paying for the other ~200
 * packages.
 */
export function buildPackages(): void {
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const tsdown = packageBin('tsdown', 'tsdown')
  run(process.execPath, [tsc, '-b', ...PLUGIN_PACKAGES.map(pkg => pkg.dir + '/tsconfig.json')], REPO_ROOT)
  run(
    process.execPath,
    [tsdown, '--env.DSH_BUILD_FACE', 'host', '--filter', '@deepseek-ai/dsh-taskboard'],
    REPO_ROOT,
  )
  // The browser half only compiles under the package's own tsdown config; the
  // root workspace filter addresses the node half's config name, not the
  // `/client` companion's.
  run(
    process.execPath,
    [tsdown, '--env.DSH_BUILD_FACE', 'client'],
    join(REPO_ROOT, 'packages/client/ui-taskboard'),
  )
}

const ALLOWED_TOP_LEVEL = new Set([
  'README.md',
  'LICENSE',
  'SHA256SUMS',
  '.gitattributes',
  'packages',
  'releases',
])

/**
 * Keep every emitted byte as packed, whatever the consumer's \`core.autocrlf\`
 * is: a git install must ship the same artifacts as the tarball.
 */
const GITATTRIBUTES = '#' + '# Emitted by scripts/emit-taskboard-standalone.ts — do not edit by hand.\n'
  + '#' + '# The artifacts are byte-exact release payloads; disable text conversion.\n'
  + '* -text\n'

/**
 * The `workspace:` dependency protocol, which only ever appears as a quoted spec
 * value (`"workspace:^"`). Matching the closing delimiter as well as the prefix separates
 * a leaked protocol from the object property `workspace: { … }` and the prose
 * `… per workspace:` that the built artifacts legitimately contain.
 */
const WORKSPACE_PROTOCOL = /["'`]workspace:/

/** Outcome of auditing one emitted tree. */
export interface AuditReport {
  /** Violations that must block the release. */
  problems: string[]
  /**
   * `workspace:` occurrences that are not the dependency protocol — prose and
   * identifiers inside built artifacts. Reported, never fatal.
   */
  proseOccurrences: string[]
}

/**
 * Audit an emitted tree for what must never ship: the `workspace:` dependency
 * protocol, vendored DSH sources, and `node_modules`.
 * @param outDir - the emitted standalone tree.
 * @returns blocking problems plus the non-protocol `workspace:` residue.
 */
export function auditArtifact(outDir: string): AuditReport {
  const problems: string[] = []
  const proseOccurrences: string[] = []
  for (const path of walk(outDir)) {
    const segments = path.split('/')
    if (segments.includes('node_modules')) problems.push(`node_modules vendored: ${path}`)
    const top = segments[0] ?? ''
    if (!ALLOWED_TOP_LEVEL.has(top)) problems.push(`unexpected top-level entry: ${path}`)
    if (/\.tsx?$/.test(path) && !path.endsWith('.d.ts')) problems.push(`host source vendored: ${path}`)
    const bytes = readFileSync(join(outDir, path))
    const text = path.endsWith('.tgz') ? gunzipSync(bytes).toString('binary') : bytes.toString('binary')
    if (WORKSPACE_PROTOCOL.test(text)) problems.push(`workspace: protocol leaked into ${path}`)
    else if (text.includes('workspace:')) proseOccurrences.push(path)
  }
  return { problems, proseOccurrences }
}

/**
 * Emit the standalone tree.
 * @param options - output directory and whether to build first.
 * @returns the output directory, the two packed tarballs, and the audit report.
 */
export function emit(options: EmitOptions): { out: string; tarballs: string[]; audit: AuditReport } {
  if (options.build) buildPackages()
  const versions = workspaceVersions()
  rmSync(options.out, { recursive: true, force: true })
  mkdirSync(join(options.out, 'releases'), { recursive: true })
  const tarballs: string[] = []
  const versionsByName = new Map<string, string>()
  for (const pkg of PLUGIN_PACKAGES) {
    const sourceDir = join(REPO_ROOT, pkg.dir)
    const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as
      Record<string, unknown> & { files?: string[]; version: string }
    const publishManifest = toPublishManifest(manifest, versions)
    const targetDir = join(options.out, 'packages', pkg.slug)
    mkdirSync(targetDir, { recursive: true })
    const published = collectPublishedFiles(sourceDir, manifest.files ?? [])
    for (const path of published) {
      mkdirSync(dirname(join(targetDir, path)), { recursive: true })
      copyFileSync(join(sourceDir, path), join(targetDir, path))
    }
    // A registry tarball always carries the readme and licence siblings; the
    // emitted directory mirrors that so a git install and a `files`-only
    // install ship the identical set.
    for (const pattern of ['README*', 'LICENSE*']) {
      for (const extra of globSync(pattern, { cwd: sourceDir }).map(slash).sort()) {
        copyFileSync(join(sourceDir, extra), join(targetDir, extra))
      }
    }
    writeJson(join(targetDir, 'package.json'), publishManifest)
    versionsByName.set(pkg.name, manifest.version)
    const tarball = join(options.out, 'releases', `${pkg.slug}-${manifest.version}.tgz`)
    writeFileSync(tarball, packDirectory(targetDir))
    tarballs.push(tarball)
  }
  writeFileSync(join(options.out, 'README.md'), renderReadme(versionsByName))
  const license = join(REPO_ROOT, 'LICENSE')
  if (existsSync(license)) copyFileSync(license, join(options.out, 'LICENSE'))
  writeFileSync(join(options.out, '.gitattributes'), GITATTRIBUTES)
  writeFileSync(join(options.out, 'SHA256SUMS'), renderSums(options.out))
  const audit = auditArtifact(options.out)
  if (audit.problems.length > 0) {
    throw new Error(
      `emit-taskboard-standalone: emitted tree failed its audit:\n  ${audit.problems.join('\n  ')}`,
    )
  }
  return { out: options.out, tarballs, audit }
}

/**
 * Render the `SHA256SUMS` ledger for every emitted file except itself.
 * @param outDir - the emitted standalone tree.
 * @returns `<sha256>  <path>` lines, sorted by path.
 */
export function renderSums(outDir: string): string {
  return walk(outDir)
    .filter(path => path !== 'SHA256SUMS')
    .map(path => `${createHash('sha256').update(readFileSync(join(outDir, path))).digest('hex')}  ${path}`)
    .join('\n')
    .concat('\n')
}

/**
 * Read one plugin package's version, failing closed when the workspace lookup
 * misses (a rename that would otherwise print `undefined` into the README).
 * @param versions - workspace name to version.
 * @param pkg - the plugin package descriptor.
 * @returns the package version.
 */
function pluginVersion(versions: ReadonlyMap<string, string>, pkg: PluginPackage): string {
  const version = versions.get(pkg.name)
  if (version === undefined) {
    throw new Error(`emit-taskboard-standalone: no workspace version for ${pkg.name}`)
  }
  return version
}

/**
 * Render the standalone repository README: what these packages are and the
 * three `dsh plugin add` specs a user can paste.
 * @param versions - plugin package name to version.
 * @returns the README markdown.
 */
export function renderReadme(versions: ReadonlyMap<string, string>): string {
  const [host, tab] = PLUGIN_PACKAGES
  const hostTarball = `${host.slug}-${pluginVersion(versions, host)}`
  const tabTarball = `${tab.slug}-${pluginVersion(versions, tab)}`
  return `# DSH Taskboard plugins

The Taskboard plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
packaged as a standalone release: install them into **any** released \`dsh\` with
one command each. No DSH source tree, no workspace checkout, no pnpm workspace protocol.

| Package | Role |
| --- | --- |
| \`${host.name}\` | The durable five-column board domain, the agent-facing workflow tools, reviewer automation, and the browser Remote API. |
| \`${tab.name}\` | The **Taskboard** browser tab that renders the board. |

Both are required: the tab reads the Remote surface the host package mounts.

## Install

Ask your DSH to install the plugin, or run the command directly. All three spec
forms below install the same two packages; the tarball form is the one that
needs no registry publication and no repository access, so it is the verified
path today.

**Local tarball** (from a clone of this repository):

\`\`\`sh
dsh plugin --profile web add ./releases/${hostTarball}.tgz
dsh plugin --profile web add ./releases/${tabTarball}.tgz
\`\`\`

**Git** — this installs straight from a checkout. pnpm accepts a \`#<committish>\` or a
\`#path:/<subdir>\` fragment but never both, and it resolves the \`path:\` form against
the repository's **default branch**. So this form resolves only when the branch
carrying this tree is that repository's default branch — otherwise point the
spec at a local clone whose \`HEAD\` carries it:

\`\`\`sh
dsh plugin --profile web add "git+${STANDALONE_REMOTE}#path:/packages/${host.slug}"
dsh plugin --profile web add "git+${STANDALONE_REMOTE}#path:/packages/${tab.slug}"
\`\`\`

**npm name** (works once the packages are published to the registry; they are
not published at the time of this release):

\`\`\`sh
dsh plugin --profile web add ${host.name}
dsh plugin --profile web add ${tab.name}
\`\`\`

Restart the profile afterwards (\`dsh --profile web\`). \`dsh plugin\` appends every
installed dependency whose manifest declares \`dsh.bundle\` to the profile's
\`dsh.profile.bundles\` layer list, so both packages join the stack; the
**Taskboard** tab then mounts next to the conversation view.

## Layout

\`\`\`
packages/${host.slug}/                \`${host.name}@${versions.get(host.name)}\`
packages/${tab.slug}/   \`${tab.name}@${versions.get(tab.name)}\`
releases/                         deterministic tarballs for GitHub Releases
SHA256SUMS                        integrity ledger for every file below
.gitattributes                    disables checkout text conversion, so a clone matches the tarball
\`\`\`

Each \`packages/\` directory is a complete, installable package: the built
artifacts a registry would ship are committed here, so both \`dsh plugin add\`
specs work without a build step on the consumer's machine.

## Provenance

Every file here is generated from the DeepSeek Harness repository by
\`scripts/emit-taskboard-standalone.ts\`. Do not edit this tree by hand — regenerate
it from the monorepo commit you want to ship. The emitter builds both packages
with the repository's own tooling, rewrites each manifest to real semver, packs
the tarballs, and refuses to write a tree whose manifests still carry the pnpm
workspace protocol or that vendors \`node_modules\` or DSH sources.
`
}

/**
 * Parse the command line.
 * @param argv - arguments after the script path, including \`--help\`.
 * @returns resolved options.
 */
export function parseOptions(argv: readonly string[]): EmitOptions {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string' },
      'no-build': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  return {
    out: resolve(parsed.values.out ?? defaultOutDir()),
    build: !parsed.values['no-build'],
    help: parsed.values.help,
  }
}

const USAGE = `
Emit the standalone, DSH-free release of the Taskboard plugins.

  tsx scripts/emit-taskboard-standalone.ts [options]

  --out <dir>   output directory (default:
                <system temp>/dsh-taskboard-standalone-<checkout>). The default
                sits outside this checkout on purpose: the documentation gates
                scan the working tree, and the emitted README pair links the
                standalone repository's layout. Pass a path inside the checkout
                only when you intend to remove the tree again.
  --no-build    reuse the existing lib/ products instead of rebuilding
  -h, --help    print this usage

The emitted tree is a complete repository: root README with the three
\`dsh plugin add\` specs, both publish-form packages under \`packages/\`, and
deterministic tarballs under \`releases/\` for GitHub Releases. The emitter
fails closed if the tree carries the pnpm workspace protocol, node_modules, or
DSH sources, and it rebuilds both packages with the repository's own tooling.
`

function main(): void {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  const result = emit(options)
  process.stdout.write(`emit-taskboard-standalone: wrote ${result.out}\n`)
  for (const tarball of result.tarballs) {
    process.stdout.write(
      `emit-taskboard-standalone: ${displayPath(tarball)} sha256=`
      + `${createHash('sha256').update(readFileSync(tarball)).digest('hex')}\n`,
    )
  }
  process.stdout.write(
    `emit-taskboard-standalone: audit problems=${result.audit.problems.length}`
    + ` prose-workspace:=${result.audit.proseOccurrences.length}\n`,
  )
}

/* v8 ignore next 3 -- the CLI entry runs only when this file is the process entry */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
