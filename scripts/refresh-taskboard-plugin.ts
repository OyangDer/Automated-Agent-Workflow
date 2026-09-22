/**
 * Refresh the Taskboard plugins in a DSH profile from verified .tgz artifacts,
 * with a pre-switch dependency self-check and an automatic rollback.
 *
 * # Why link: to a package directory is forbidden
 *
 * On 2026-09-21 the web profile's two Taskboard plugins were switched from
 * link:<development tree> to link:<standalone package directory>. The directory
 * form looked decoupled — it hands over built files instead of sources — but
 * **link: never installs the linked package's dependencies**: pnpm records a
 * symlink and nothing else, so zod and @deepseek-ai/schemastery were never
 * materialized. DSH then died during plugin load, before any UI appeared, and
 * the user could not open the app.
 *
 * file:<standalone>.tgz is the supported form: pnpm unpacks the tarball and
 * installs the dependencies its manifest declares, so the runtime closure is
 * present before the next boot. This script refuses any candidate that is not a
 * .tgz, and it re-checks the runtime closure after pnpm install — before it
 * declares the switch good — so an install that "succeeds" while a dependency
 * is unreachable can never reach the user's next boot.
 *
 * # Sequence (every step fails closed)
 *
 * 1. Build fresh artifacts with scripts/emit-taskboard-standalone.ts, unless
 *    --candidate <emitted tree> supplies an already emitted one.
 * 2. Verify each candidate tarball's sha256 against its SHA256SUMS ledger.
 * 3. Archive the verified tarballs into a NEW releases/<version>-<shortsha>/
 *    directory. The previous release directory is never overwritten, so a
 *    rollback point survives the build that follows it.
 * 4. Copy the profile's manifests (package.json, pnpm-lock.yaml,
 *    cordis.patch.yml, cordis.yml, pnpm-workspace.yaml) and the artifact
 *    ledgers into $DSH_HOME/backups/profiles-<profile>-<stamp>/, with a
 *    ROLLBACK.md that states the restore steps.
 * 5. Rewrite only the two Taskboard dependency specs to file:<archived tgz>;
 *    every other dependency, bundle layer, and profile file is preserved. The
 *    script never edits dsh.profile.bundles: this deployment mounts the two
 *    packages through the profile's cordis.patch.yml, and adding them to the
 *    bundle list as well would mount each one twice.
 * 6. Run pnpm install in the profile directory. The package manager is
 *    resolved explicitly: an `npm_execpath` that names npm (or names anything
 *    other than pnpm) is ignored and pnpm is located on PATH, and when no pnpm
 *    exists the refresh refuses before writing instead of silently running npm.
 * 7. Resolve every installed plugin's runtime dependency closure from the
 *    profile. A missing or unreadable dependency refuses the switch and
 *    restores the profile files from step 4 (then reinstalls), so a broken
 *    plugin never reaches the user's next boot.
 *
 * # Gating
 *
 * Dry-run is the default: without --apply nothing is written, no backup and no
 * archive directory are created, and pnpm is never invoked. With --apply the
 * script prints the same plan and waits for an interactive "apply" confirmation
 * before it touches the profile: actions against the profile a user is
 * currently running are the user's decision, never the script's.
 *
 * --fault-skip-install is a drill switch: it suppresses the install step so the
 * post-install state looks like the 2026-09-21 accident (install reported
 * success, the closure is absent). It exists to demonstrate the refusal and
 * rollback path and never enables a switch.
 *
 * See scripts/refresh-taskboard-plugin.md for the same explanation in prose.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'

/** Repository root, derived from this script's location under scripts/. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The two plugin packages one Taskboard deployment installs together. */
export const TASKBOARD_PLUGINS: readonly string[] = [
  '@deepseek-ai/dsh-taskboard',
  '@deepseek-ai/dsh-client-ui-taskboard',
]

/** Profile files a rollback pack preserves byte for byte. */
export const PROFILE_BACKUP_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
]

/** Profile this deployment refreshes when --profile is omitted. */
export const DEFAULT_PROFILE = 'web'

/** This deployment's artifact repository, holding releases/ and SHA256SUMS. */
export const DEFAULT_ARTIFACTS_ROOT = 'D:/Plugins/dsh-taskboard-standalone'

/** Upper bound on the dependency-closure walk, so a cyclic layout cannot hang. */
const MAX_CLOSURE_PACKAGES = 4000

/**
 * Join a path with / separators, the form pnpm writes into file: specs.
 * @param path - any platform path.
 * @returns the path with forward slashes.
 */
export function slash(path: string): string {
  return path.split(sep).join('/')
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(path + ' is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

function writeJsonObject(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, undefined, 2) + '\n')
}

function firstExisting(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Resolve the Harness home the same way the launcher does: an explicit
 * --dsh-home, then $DSH_HOME, then ~/.dsh.
 * @param configured - the --dsh-home value, when given.
 * @param env - environment mapping read for DSH_HOME.
 * @returns the absolute Harness home.
 */
export function resolveHome(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (configured !== undefined && configured !== '') return resolve(configured)
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Resolve a profile directory under the Harness home, rejecting names that
 * would escape it.
 * @param home - the absolute Harness home.
 * @param profile - the profile name.
 * @returns the absolute profile directory.
 */
export function profileDirectory(home: string, profile: string): string {
  const bad = profile === ''
    || profile.includes('/')
    || profile.includes('\\')
    || profile === '.'
    || profile === '..'
    || profile === 'node_modules'
  if (bad) throw new Error(JSON.stringify(profile) + ' is not a usable profile name')
  return join(home, 'profiles', profile)
}

/**
 * Read one member out of a gzipped ustar archive without spawning an archiver.
 * @param tarball - absolute path of the .tgz.
 * @param wanted - the member path inside the archive, e.g. package/package.json.
 * @returns the member bytes, or undefined when the archive does not carry it.
 */
export function readTarballEntry(tarball: string, wanted: string): Buffer | undefined {
  const archive = gunzipSync(readFileSync(tarball))
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return undefined
    const field = (start: number, length: number): string =>
      header.subarray(start, start + length).toString('binary').replace(/\0.*$/su, '')
    const sizeField = field(124, 12).trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(tarball + ': unreadable tar header at ' + String(offset))
    }
    const name = field(0, 100)
    const prefix = field(345, 155)
    if ((prefix === '' ? name : prefix + '/' + name) === wanted) {
      return Buffer.from(archive.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + size + ((512 - (size % 512)) % 512)
  }
  return undefined
}

/** What a packed plugin tarball declares about itself. */
export interface PackedPlugin {
  /** Published package name. */
  name: string
  /** Package version. */
  version: string
  /** Whether the manifest declares a dsh.bundle layer patch. */
  bundle: boolean
}

/**
 * Read the manifest a packed plugin tarball carries.
 * @param tarball - absolute path of the .tgz.
 * @returns the packed package's name, version, and bundle declaration.
 */
export function readPackedPlugin(tarball: string): PackedPlugin {
  const bytes = readTarballEntry(tarball, 'package/package.json')
  if (bytes === undefined) throw new Error(tarball + ' carries no package/package.json')
  const manifest = JSON.parse(bytes.toString('utf8')) as {
    name?: unknown
    version?: unknown
    dsh?: { bundle?: unknown }
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(tarball + ': package/package.json lacks a string name/version')
  }
  return { name: manifest.name, version: manifest.version, bundle: manifest.dsh?.bundle !== undefined }
}

/** One entry of a SHA256SUMS ledger. */
export interface SumsEntry {
  /** The listed path, `/`-joined and relative to the ledger root. */
  path: string
  /** The recorded sha256. */
  sha256: string
}

/**
 * Parse a SHA256SUMS ledger.
 *
 * Entries keep their full path: an emitted standalone tree legitimately carries
 * two README.md files with different hashes, so a basename key would collide
 * and would also let an unrelated file satisfy a tarball lookup.
 * @param text - the ledger's contents.
 * @returns one entry per listed file, in ledger order.
 */
export function parseSums(text: string): SumsEntry[] {
  const entries: SumsEntry[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '') continue
    const match = /^(?<sha>[0-9a-f]{64})\s+\*?(?<path>\S.*)$/u.exec(line)
    const groups = match?.groups
    if (groups?.sha === undefined || groups.path === undefined) {
      throw new Error('SHA256SUMS: unparsable line ' + JSON.stringify(raw))
    }
    entries.push({ path: groups.path.replaceAll('\\', '/').replace(/^\.\//u, ''), sha256: groups.sha })
  }
  return entries
}

/**
 * Find the ledger entry that covers one tarball, matching its path suffix.
 * @param entries - parsed ledger entries.
 * @param tarball - absolute tarball path.
 * @returns the recorded sha256.
 */
export function ledgerHash(entries: readonly SumsEntry[], tarball: string): string {
  const name = basename(tarball)
  const matches = entries.filter(entry => entry.path === name || entry.path.endsWith('/' + name))
  const hashes = [...new Set(matches.map(entry => entry.sha256))]
  if (hashes.length === 0) {
    throw new Error('SHA256SUMS lists no entry for ' + name + ' — refusing an artifact it does not cover')
  }
  if (hashes.length > 1) {
    throw new Error('SHA256SUMS carries conflicting hashes for ' + name)
  }
  const hash = hashes[0]
  if (hash === undefined) throw new Error('SHA256SUMS carries no hash for ' + name)
  return hash
}

/** One candidate artifact, verified against its ledger. */
export interface CandidateArtifact {
  /** Absolute path of the source .tgz. */
  tarball: string
  /** What the packed manifest declares. */
  packed: PackedPlugin
  /** sha256 of the tarball bytes, confirmed against SHA256SUMS. */
  sha256: string
}

/**
 * Verify every candidate tarball against the ledger and its own manifest.
 * @param tarballs - absolute candidate tarball paths.
 * @param sumsText - the SHA256SUMS ledger that must cover them.
 * @returns the verified artifacts, in the given order.
 */
export function verifyArtifacts(tarballs: readonly string[], sumsText: string): CandidateArtifact[] {
  const sums = parseSums(sumsText)
  const verified: CandidateArtifact[] = []
  for (const tarball of tarballs) {
    const key = basename(tarball)
    const expected = ledgerHash(sums, tarball)
    const actual = sha256File(tarball)
    if (actual !== expected) {
      throw new Error(
        'sha256 mismatch for ' + key + ': SHA256SUMS says ' + expected + ', the file hashes to ' + actual,
      )
    }
    const packed = readPackedPlugin(tarball)
    if (!TASKBOARD_PLUGINS.includes(packed.name)) {
      throw new Error(
        tarball + ' packs ' + packed.name + ', which is not a Taskboard plugin this script may switch',
      )
    }
    verified.push({ tarball, packed, sha256: actual })
  }
  const names = new Set(verified.map(artifact => artifact.packed.name))
  for (const required of TASKBOARD_PLUGINS) {
    if (!names.has(required)) {
      throw new Error(
        'candidate is missing ' + required + '; a Taskboard deployment installs both packages together',
      )
    }
  }
  return verified
}

/** Where a candidate's artifacts and their ledger live. */
export interface CandidateLocation {
  /** The directory the caller named. */
  root: string
  /** The directory holding the .tgz files. */
  tarballDir: string
  /** The SHA256SUMS ledger covering them. */
  sumsPath: string
  /** Absolute tarball paths, sorted. */
  tarballs: string[]
}

/**
 * Locate the tarballs and ledger under a candidate path: either an emitted
 * standalone tree (with releases/) or a plain directory of tarballs.
 * @param input - the --candidate path.
 * @returns the resolved candidate location.
 */
export function locateCandidate(input: string): CandidateLocation {
  const root = resolve(input)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(
      'candidate ' + root + ' is not a directory; a refresh installs verified .tgz artifacts through '
      + 'file:, never a link: to a package directory (link: installs no dependencies of the linked package)',
    )
  }
  const releases = join(root, 'releases')
  const tarballDir = existsSync(releases) && statSync(releases).isDirectory() ? releases : root
  const names = readdirSync(tarballDir).filter(name => name.endsWith('.tgz')).sort()
  if (names.length === 0) {
    throw new Error(
      tarballDir + ' holds no .tgz artifact; a link:/<package dir> install never installs the'
      + ' dependencies a package declares, so it is refused — install file:<artifact>.tgz instead',
    )
  }
  const sumsPath = firstExisting([
    join(root, 'SHA256SUMS'),
    join(dirname(root), 'SHA256SUMS'),
    join(tarballDir, 'SHA256SUMS'),
  ])
  if (sumsPath === undefined) {
    throw new Error('no SHA256SUMS ledger covers ' + tarballDir + '; refusing an unverifiable candidate')
  }
  return { root, tarballDir, sumsPath, tarballs: names.map(name => join(tarballDir, name)) }
}

/** The profile manifest fields a refresh reads and rewrites. */
export interface ProfileManifest {
  /** The profile package.json, verbatim. */
  raw: Record<string, unknown>
  /** Its dependency specs. */
  dependencies: Record<string, string>
  /** Its dsh.profile.bundles layer list. */
  bundles: string[]
}

/**
 * Read a profile's manifest.
 * @param profileDir - the absolute profile directory.
 * @returns the raw manifest plus the fields a refresh touches.
 */
export function readProfileManifest(profileDir: string): ProfileManifest {
  const raw = readJsonObject(join(profileDir, 'package.json'))
  const dependencies = raw.dependencies as Record<string, string> | undefined
  const dsh = raw.dsh as { profile?: { bundles?: string[] } } | undefined
  return { raw, dependencies: dependencies ?? {}, bundles: dsh?.profile?.bundles ?? [] }
}

/** One dependency spec the switch rewrites. */
export interface DependencyChange {
  /** Package name. */
  name: string
  /** The spec installed today, or undefined when the profile does not depend on it yet. */
  before: string | undefined
  /** The file: spec the switch writes. */
  after: string
}

/** Everything a refresh will do, computed without writing anything. */
export interface RefreshPlan {
  /** Absolute Harness home. */
  home: string
  /** Profile name. */
  profile: string
  /** Absolute profile directory. */
  profileDir: string
  /** The artifact repository root. */
  artifactsRoot: string
  /** Where the candidate came from. */
  candidate: CandidateLocation
  /** Verified artifacts to install. */
  artifacts: readonly CandidateArtifact[]
  /** The archive directory's name. */
  tag: string
  /** Absolute archive directory (a NEW directory, never an existing one). */
  archiveDir: string
  /** Absolute rollback pack directory. */
  backupDir: string
  /** Profile files that exist today and will be preserved in the pack. */
  backupFiles: readonly string[]
  /** The ledger of the artifacts installed today, when the specs still resolve. */
  currentLedger: string | undefined
  /** Dependency specs the switch rewrites. */
  dependencyChanges: readonly DependencyChange[]
  /** Current profile manifest, read once. */
  manifest: ProfileManifest
  /** The command that restarts the profile. */
  restartCommand: string
  /** Temporary build directory to clean up afterwards, when --build ran. */
  buildDir: string | undefined
  /** The install command resolved for this machine. */
  installInvocation: PackageManagerInvocation
}

/** Result of one child-process invocation. */
export interface CommandResult {
  /** Process exit status. */
  status: number
  /** The command line that actually ran, exactly as the log reports it. */
  command: string
  /** Combined standard output and standard error. */
  output: string
}

/** The package-manager invocation a refresh decided to run. */
export interface PackageManagerInvocation {
  /** Executable to spawn. */
  command: string
  /** Arguments for that executable. */
  args: string[]
  /** Whether the spawn needs a shell (a Windows .cmd/.bat shim). */
  shell: boolean
  /** The command line a human reads in the log, e.g. `pnpm install`. */
  display: string
  /** Why this invocation was chosen, including any ignored execpath. */
  origin: string
}

/** Everything a refresh does outside its own file work; injected so specs stay hermetic. */
export interface RefreshIo {
  /** Print one plan or progress line. */
  log(line: string): void
  /** Ask the operator to confirm a write; resolves false to abort. */
  confirm(question: string): Promise<boolean>
  /** Resolve the install command for this machine; refuses instead of degrading to npm. */
  resolveInstall(): PackageManagerInvocation
  /** Run the resolved install in a profile directory. */
  install(profileDir: string, invocation: PackageManagerInvocation): CommandResult
  /** Emit a fresh standalone tree into out. */
  build(out: string, noBuild: boolean): void
  /** The current checkout's short commit sha. */
  gitSha(): string
  /** The current time. */
  now(): Date
}

/** Options resolved from the command line. */
export interface RefreshOptions {
  /** Profile name. */
  profile: string
  /** Absolute Harness home. */
  home: string
  /** Artifact repository root. */
  artifactsRoot: string
  /** An emitted tree or tarball directory to install; undefined builds one. */
  candidate: string | undefined
  /** Archive tag override; undefined derives <version>-<shortsha>. */
  tag: string | undefined
  /** Whether the caller asked for a real switch. */
  apply: boolean
  /** Reuse existing build products instead of rebuilding. */
  noBuild: boolean
  /** Keep the temporary build directory. */
  keepBuild: boolean
  /** Drill only: pretend the install succeeded without materializing the closure. */
  faultSkipInstall: boolean
  /** Restore this rollback pack instead of refreshing. */
  rollback: string | undefined
  /** Print usage and exit. */
  help: boolean
}

/**
 * Describe how a profile mounts the plugins a refresh is about to replace.
 * @param plan - the computed plan.
 * @returns one clause for the plan's bundle-layers line.
 */
function mountNote(plan: RefreshPlan): string {
  const listed = plan.dependencyChanges
    .filter(change => plan.manifest.bundles.includes(change.name))
    .map(change => change.name)
  if (listed.length === 0) {
    return 'this script never edits dsh.profile.bundles; the profile mounts them through its own patch'
  }
  return 'this script never edits dsh.profile.bundles; already listed there: ' + listed.join(', ')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timestamp(now: Date): string {
  const date = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
  const time = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
  return date + '-' + time
}

function uniqueDirectory(base: string): string {
  if (!existsSync(base)) return base
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = base + '-' + String(suffix)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('cannot find a free directory next to ' + base)
}

/**
 * Find the ledger of the artifacts installed in a profile today, so a rollback
 * pack records the release that must come back.
 * @param manifest - the profile manifest read from disk.
 * @returns the ledger path, or undefined when no installed spec is a tarball.
 */
export function currentArtifactLedger(manifest: ProfileManifest): string | undefined {
  for (const spec of Object.values(manifest.dependencies)) {
    const match = /^file:(?<path>.+\.tgz)$/u.exec(spec)
    const tarball = match?.groups?.path
    if (tarball === undefined) continue
    const found = firstExisting([
      join(dirname(tarball), 'SHA256SUMS'),
      join(dirname(dirname(tarball)), 'SHA256SUMS'),
    ])
    if (found !== undefined) return found
  }
  return undefined
}

function emitCandidate(io: RefreshIo, options: RefreshOptions): string {
  const out = mkdtempSync(join(tmpdir(), 'dsh-taskboard-refresh-'))
  io.log('build: emitting standalone artifacts into ' + out)
  io.build(out, options.noBuild)
  return out
}

/**
 * Compute the full refresh without writing anything.
 * @param options - resolved command-line options.
 * @param io - the injected side-effect surface (only build and gitSha run here).
 * @returns the plan.
 */
export function buildPlan(options: RefreshOptions, io: RefreshIo): RefreshPlan {
  const profileDir = profileDirectory(options.home, options.profile)
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error(
      'no profile at ' + profileDir + '; run dsh plugin --profile ' + options.profile + ' add once to initialize it',
    )
  }
  // Resolve the installer before anything is built or written: an
  // unresolvable (or npm-only) package manager must refuse here, not after the
  // profile has been rewritten.
  const installInvocation = io.resolveInstall()
  const buildDir = options.candidate === undefined ? emitCandidate(io, options) : undefined
  const candidate = locateCandidate(options.candidate ?? buildDir ?? '')
  const artifacts = verifyArtifacts(candidate.tarballs, readFileSync(candidate.sumsPath, 'utf8'))
  const first = artifacts[0]
  if (first === undefined) throw new Error(candidate.tarballDir + ' holds no verifiable artifact')
  const version = first.packed.version
  for (const artifact of artifacts) {
    if (artifact.packed.version !== version) {
      throw new Error(
        'candidate mixes versions: ' + first.packed.name + '@' + version + ' and '
        + artifact.packed.name + '@' + artifact.packed.version + ' ship together',
      )
    }
  }
  const tag = options.tag ?? version + '-' + io.gitSha()
  const archiveDir = join(options.artifactsRoot, 'releases', tag)
  const stamp = timestamp(io.now())
  const backupDir = uniqueDirectory(join(options.home, 'backups', 'profiles-' + options.profile + '-' + stamp))
  const manifest = readProfileManifest(profileDir)
  const dependencyChanges = artifacts.map(artifact => ({
    name: artifact.packed.name,
    before: manifest.dependencies[artifact.packed.name],
    after: 'file:' + slash(join(archiveDir, basename(artifact.tarball))),
  }))
  return {
    home: options.home,
    profile: options.profile,
    profileDir,
    artifactsRoot: options.artifactsRoot,
    candidate,
    artifacts,
    tag,
    archiveDir,
    backupDir,
    backupFiles: PROFILE_BACKUP_FILES.filter(name => existsSync(join(profileDir, name))),
    currentLedger: currentArtifactLedger(manifest),
    dependencyChanges,
    manifest,
    restartCommand: 'dsh --profile ' + options.profile,
    buildDir,
    installInvocation,
  }
}

/**
 * Render the plan a human reads before deciding.
 * @param plan - the computed plan.
 * @param options - resolved options, for the dry-run banner.
 * @returns the multi-line plan text.
 */
export function formatPlan(plan: RefreshPlan, options: RefreshOptions): string {
  const lines = [
    'refresh plan (' + (options.apply ? 'APPLY' : 'dry-run — nothing will be written') + ')',
    '  profile        : ' + plan.profile + ' -> ' + plan.profileDir,
    '  dsh home       : ' + plan.home,
    '  candidate      : ' + plan.candidate.root + ' (ledger ' + plan.candidate.sumsPath + ')',
  ]
  for (const artifact of plan.artifacts) {
    lines.push(
      '  verified       : ' + artifact.sha256 + '  ' + basename(artifact.tarball)
      + '  (' + artifact.packed.name + '@' + artifact.packed.version + ')',
    )
  }
  const backupFiles = plan.backupFiles.length === 0 ? 'no profile file found yet' : plan.backupFiles.join(', ')
  lines.push(
    '  archive        : ' + plan.archiveDir + '  [new directory; existing releases stay]',
    '  rollback pack  : ' + plan.backupDir + '  (' + backupFiles + ')',
    '  profile changes:',
  )
  for (const change of plan.dependencyChanges) {
    lines.push('    ' + change.name + ': ' + (change.before ?? '(absent)') + ' -> ' + change.after)
  }
  lines.push(
    '  bundle layers  : unchanged — ' + mountNote(plan),
    '  install        : ' + plan.installInvocation.display + ' in ' + plan.profileDir,
    '                   ' + plan.installInvocation.origin,
    '  self-check     : runtime dependency closure of ' + String(plan.artifacts.length) + ' plugin(s)',
    '  restart        : ' + plan.restartCommand + '   (a running host keeps the old code until it restarts)',
    '  on failure     : restore the rollback pack above and re-run pnpm install',
  )
  return lines.join('\n')
}

/**
 * Archive verified artifacts into their new version+sha directory.
 * @param plan - the computed plan.
 * @param io - logging surface.
 */
export function archiveArtifacts(plan: RefreshPlan, io: RefreshIo): void {
  if (existsSync(plan.archiveDir)) {
    throw new Error(
      plan.archiveDir + ' already exists — releases are archived, never overwritten in place;'
      + ' pass --tag <label> to archive this build under a distinct directory',
    )
  }
  mkdirSync(plan.archiveDir, { recursive: true })
  const sums: string[] = []
  for (const artifact of plan.artifacts) {
    const target = join(plan.archiveDir, basename(artifact.tarball))
    copyFileSync(artifact.tarball, target)
    const actual = sha256File(target)
    if (actual !== artifact.sha256) {
      throw new Error('archived copy ' + target + ' hashes to ' + actual + ', not the verified ' + artifact.sha256)
    }
    sums.push(actual + '  ' + basename(target))
  }
  writeFileSync(join(plan.archiveDir, 'SHA256SUMS'), sums.join('\n') + '\n')
  writeJsonObject(join(plan.archiveDir, 'provenance.json'), {
    archivedAt: new Date().toISOString(),
    tag: plan.tag,
    candidate: plan.candidate.root,
    candidateLedger: plan.candidate.sumsPath,
    artifacts: plan.artifacts.map(artifact => ({
      file: basename(artifact.tarball),
      name: artifact.packed.name,
      version: artifact.packed.version,
      sha256: artifact.sha256,
    })),
  })
  io.log('archive: ' + String(plan.artifacts.length) + ' verified artifact(s) -> ' + plan.archiveDir)
}

function renderRollbackDoc(plan: RefreshPlan): string {
  const copies = plan.backupFiles
    .map(name => '   cp "' + join(plan.backupDir, name) + '" "' + join(plan.profileDir, name) + '"')
    .join('\n')
  const body = copies === '' ? '   (the profile held none of the tracked files)' : copies
  const fence = '```'
  const lines = [
    '# Rollback: profile ' + plan.profile,
    '',
    'Saved before switching to ' + plan.archiveDir + '.',
    '',
    '## Restore by hand',
    '',
    '1. Copy the profile files back from this pack:',
    fence + 'sh',
    body,
    fence,
    '2. Reinstall in the profile:',
    fence + 'sh',
    '   cd "' + plan.profileDir + '"',
    '   pnpm install',
    fence,
    '3. Restart the host: ' + plan.restartCommand,
    '',
    '## Restore automatically',
    '',
    fence + 'sh',
    '   tsx scripts/refresh-taskboard-plugin.ts --rollback "' + plan.backupDir + '" --dsh-home "' + plan.home + '"',
    fence,
    '',
    'The artifacts this switch archived stay in ' + plan.archiveDir
      + '; they are inert until a profile points at them.',
    '',
  ]
  return lines.join('\n')
}

/**
 * Copy the profile manifests and artifact ledgers into a rollback pack.
 * @param plan - the computed plan.
 * @param io - logging surface.
 */
export function createRollbackPack(plan: RefreshPlan, io: RefreshIo): void {
  mkdirSync(plan.backupDir, { recursive: true })
  const files: Record<string, { present: boolean; sha256: string | undefined }> = {}
  for (const name of PROFILE_BACKUP_FILES) {
    const source = join(plan.profileDir, name)
    const present = existsSync(source)
    files[name] = { present, sha256: present ? sha256File(source) : undefined }
    if (present) copyFileSync(source, join(plan.backupDir, name))
  }
  const ledgers: Record<string, string> = {}
  if (plan.currentLedger !== undefined) {
    copyFileSync(plan.currentLedger, join(plan.backupDir, 'artifacts-current-SHA256SUMS'))
    ledgers.current = plan.currentLedger
  }
  copyFileSync(plan.candidate.sumsPath, join(plan.backupDir, 'artifacts-candidate-SHA256SUMS'))
  ledgers.candidate = plan.candidate.sumsPath
  writeJsonObject(join(plan.backupDir, 'backup-manifest.json'), {
    profile: plan.profile,
    profileDir: plan.profileDir,
    savedAt: new Date().toISOString(),
    candidateArchive: plan.archiveDir,
    files,
    ledgers,
  })
  writeFileSync(join(plan.backupDir, 'ROLLBACK.md'), renderRollbackDoc(plan))
  io.log(
    'rollback pack: ' + plan.backupDir + ' (' + String(plan.backupFiles.length) + ' profile file(s), '
    + String(Object.keys(ledgers).length) + ' ledger(s), ROLLBACK.md)',
  )
}

/**
 * Rewrite only the Taskboard dependency specs, atomically, preserving every
 * other dependency, bundle layer, and field.
 * @param plan - the computed plan.
 * @param io - logging surface.
 * @returns the manifest that was written.
 */
export function writeProfileSwitch(plan: RefreshPlan, io: RefreshIo): Record<string, unknown> {
  const dependencies: Record<string, string> = { ...plan.manifest.dependencies }
  for (const change of plan.dependencyChanges) dependencies[change.name] = change.after
  const next = { ...plan.manifest.raw, dependencies }
  const target = join(plan.profileDir, 'package.json')
  writeJsonObject(target + '.refresh-staging', next)
  renameSync(target + '.refresh-staging', target)
  io.log(
    'profile: rewrote ' + plan.dependencyChanges.map(change => change.name).join(', ')
    + ' to file: specs in ' + target,
  )
  return next
}

/**
 * Resolve one package directory the way Node does: walk up from the anchor
 * looking for node_modules/<name>, then pnpm's hidden hoisted layer.
 * @param name - the package name, scoped names included.
 * @param fromDir - the anchor directory (a package's real directory).
 * @returns the package's real directory, or undefined when it is unreachable.
 */
export function resolvePackageDirectory(name: string, fromDir: string): string | undefined {
  let dir = resolve(fromDir)
  for (;;) {
    for (const layer of ['node_modules', join('node_modules', '.pnpm', 'node_modules')]) {
      const candidate = join(dir, layer, name)
      if (!existsSync(candidate)) continue
      let real: string
      try {
        real = realpathSync(candidate)
      } catch {
        continue
      }
      if (existsSync(join(real, 'package.json'))) return real
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** One package the runtime closure reached. */
export interface DependencyCheck {
  /** Package name. */
  name: string
  /** Version its installed manifest declares. */
  version: string
  /** The resolved directory. */
  dir: string
  /** Who requires it. */
  requiredBy: string
}

/** One dependency the profile cannot reach. */
export interface DependencyProblem {
  /** Package name. */
  name: string
  /** Who requires it. */
  requiredBy: string
  /** The directory the search started from. */
  anchor: string
  /** Why it is unusable. */
  reason: string
}

/** The result of resolving a plugin set's runtime closure. */
export interface RuntimeClosure {
  /** Every reachable package, in discovery order. */
  packages: DependencyCheck[]
  /** Unreachable dependencies and version mismatches. */
  problems: DependencyProblem[]
}

/**
 * Resolve each expected plugin and, recursively, the runtime dependencies their
 * installed manifests declare. Peer and optional dependencies are out of scope:
 * the host provides peers, and optional dependencies are allowed to be absent.
 * The 2026-09-21 accident left a runtime dependency absent, which is exactly
 * what this walk reports.
 * @param profileDir - the absolute profile directory.
 * @param expected - the verified artifacts that must be installed.
 * @returns the reached packages and the problems that block a switch.
 */
export function runtimeClosure(
  profileDir: string,
  expected: readonly { name: string; version: string }[],
): RuntimeClosure {
  const packages: DependencyCheck[] = []
  const problems: DependencyProblem[] = []
  const visited = new Set<string>()
  const queue: { name: string; requiredBy: string; anchor: string; version: string | undefined }[] =
    expected.map(entry => ({ name: entry.name, requiredBy: '<profile>', anchor: profileDir, version: entry.version }))
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    const dir = resolvePackageDirectory(next.name, next.anchor)
    if (dir === undefined) {
      problems.push({
        name: next.name,
        requiredBy: next.requiredBy,
        anchor: next.anchor,
        reason: 'unresolvable from the profile',
      })
      continue
    }
    if (visited.has(dir)) continue
    if (visited.size >= MAX_CLOSURE_PACKAGES) {
      throw new Error('dependency closure exceeded ' + String(MAX_CLOSURE_PACKAGES) + ' packages; refusing to continue')
    }
    visited.add(dir)
    const manifest = readJsonObject(join(dir, 'package.json'))
    const version = typeof manifest.version === 'string' ? manifest.version : ''
    if (next.version !== undefined && version !== next.version) {
      problems.push({
        name: next.name,
        requiredBy: next.requiredBy,
        anchor: next.anchor,
        reason: 'installed version ' + version + ' is not the verified ' + next.version,
      })
    }
    packages.push({ name: next.name, version, dir, requiredBy: next.requiredBy })
    const dependencies = manifest.dependencies as Record<string, string> | undefined
    if (dependencies !== undefined) {
      for (const dependency of Object.keys(dependencies).sort()) {
        queue.push({ name: dependency, requiredBy: next.name + '@' + version, anchor: dir, version: undefined })
      }
    }
  }
  return { packages, problems }
}

/**
 * Render the self-check result a human reads in the evidence log.
 * @param closure - the resolver result.
 * @returns the multi-line report.
 */
export function formatClosure(closure: RuntimeClosure): string {
  const lines = ['self-check: resolved ' + String(closure.packages.length) + ' package(s)']
  for (const entry of closure.packages) {
    lines.push('  ' + entry.name + '@' + entry.version + '  <- ' + entry.requiredBy)
  }
  if (closure.problems.length > 0) {
    lines.push('self-check FAILED: ' + String(closure.problems.length) + ' unreachable dependency/ies')
    for (const problem of closure.problems) {
      lines.push('  ' + problem.requiredBy + ' requires ' + problem.name + ': ' + problem.reason + ' (' + problem.anchor + ')')
    }
  }
  return lines.join('\n')
}

/** A rollback pack read back from disk. */
export interface RollbackPack {
  /** Absolute pack directory. */
  dir: string
  /** The profile it belongs to. */
  profile: string
  /** The profile directory to restore into. */
  profileDir: string
  /** Per-file restore instructions. */
  files: Record<string, { present: boolean; sha256: string | undefined }>
  /** The archive the pack was taken before switching to. */
  candidateArchive: string
}

/**
 * Read a rollback pack's manifest.
 * @param dir - the pack directory.
 * @returns the pack description.
 */
export function readRollbackPack(dir: string): RollbackPack {
  const manifestPath = join(dir, 'backup-manifest.json')
  if (!existsSync(manifestPath)) throw new Error(dir + ' carries no backup-manifest.json')
  const manifest = readJsonObject(manifestPath)
  const profile = manifest.profile
  const profileDir = manifest.profileDir
  const files = manifest.files as Record<string, { present: boolean; sha256: string | undefined }> | undefined
  if (typeof profile !== 'string' || typeof profileDir !== 'string' || files === undefined) {
    throw new Error(manifestPath + ' is not a rollback pack this script wrote')
  }
  return {
    dir,
    profile,
    profileDir,
    files,
    candidateArchive: typeof manifest.candidateArchive === 'string' ? manifest.candidateArchive : '',
  }
}

/**
 * Restore a rollback pack: put the saved profile files back, delete the files
 * that did not exist before the switch, and reinstall.
 * @param dir - the pack directory.
 * @param io - the injected side-effect surface.
 * @returns the exit code.
 */
export function performRollback(dir: string, io: RefreshIo): number {
  const pack = readRollbackPack(dir)
  io.log('rollback: restoring ' + pack.profile + ' from ' + pack.dir)
  for (const [name, entry] of Object.entries(pack.files)) {
    const target = join(pack.profileDir, name)
    if (entry.present) {
      copyFileSync(join(pack.dir, name), target)
      io.log('rollback: restored ' + target)
      continue
    }
    if (existsSync(target)) {
      rmSync(target, { force: true })
      io.log('rollback: removed ' + target + ' (absent before the switch)')
    }
  }
  let invocation: PackageManagerInvocation
  try {
    invocation = io.resolveInstall()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.log('rollback: ' + message)
    io.log('rollback: profile files restored, but the reinstall needs pnpm; follow ' + join(pack.dir, 'ROLLBACK.md'))
    return 1
  }
  io.log('rollback: running ' + invocation.display + '  [' + invocation.origin + ']')
  const installed = io.install(pack.profileDir, invocation)
  if (installed.status !== 0) {
    io.log('rollback: ' + installed.command + ' exited ' + String(installed.status) + '; finish by hand per ' + join(pack.dir, 'ROLLBACK.md'))
    io.log(installed.output.trim())
    return 1
  }
  io.log('rollback: profile files restored and reinstalled; restart with dsh --profile ' + pack.profile)
  return 0
}

/**
 * Roll a refused switch back and report the refusal, which is always a failure.
 * @param backupDir - the pack taken before the switch.
 * @param io - the injected side-effect surface.
 * @returns 1, whether or not the restore itself succeeded.
 */
function refuseWithRollback(backupDir: string, io: RefreshIo): number {
  const restored = performRollback(backupDir, io)
  if (restored !== 0) {
    io.log('REFUSED: the rollback did not finish; follow ' + join(backupDir, 'ROLLBACK.md'))
  }
  return 1
}

/**
 * Run the refresh end to end.
 * @param options - resolved command-line options.
 * @param io - the injected side-effect surface.
 * @returns the process exit code.
 */
export async function runRefresh(options: RefreshOptions, io: RefreshIo): Promise<number> {
  if (options.rollback !== undefined) {
    const pack = readRollbackPack(options.rollback)
    const question = 'Restore ' + pack.profile + ' from ' + pack.dir + ' and reinstall? type "apply" to continue: '
    if (!(await io.confirm(question))) {
      io.log('aborted: nothing was written')
      return 1
    }
    return performRollback(options.rollback, io)
  }
  const plan = buildPlan(options, io)
  try {
    io.log(formatPlan(plan, options))
    if (!options.apply) {
      io.log('dry-run: wrote nothing — no archive, no rollback pack, no profile change, no install.')
      return 0
    }
    const question = 'Switch profile ' + plan.profile + ' to the artifacts above? type "apply" to continue: '
    if (!(await io.confirm(question))) {
      io.log('aborted: nothing was written')
      return 1
    }
    archiveArtifacts(plan, io)
    createRollbackPack(plan, io)
    writeProfileSwitch(plan, io)
    if (options.faultSkipInstall) {
      io.log('fault-injection (drill only): --fault-skip-install skipped the install, so the new closure is absent')
    } else {
      io.log('install: running ' + plan.installInvocation.display + '  [' + plan.installInvocation.origin + ']')
      const installed = io.install(plan.profileDir, plan.installInvocation)
      if (installed.status !== 0) {
        io.log('install: ' + installed.command + ' exited ' + String(installed.status))
        io.log(installed.output.trim())
        io.log('REFUSED: the install failed; rolling back to the pack taken before the switch')
        return refuseWithRollback(plan.backupDir, io)
      }
      io.log('install: ' + installed.command + ' succeeded')
    }
    const closure = runtimeClosure(
      plan.profileDir,
      plan.artifacts.map(artifact => ({ name: artifact.packed.name, version: artifact.packed.version })),
    )
    io.log(formatClosure(closure))
    if (closure.problems.length > 0) {
      io.log('REFUSED: a plugin runtime dependency is unreachable; rolling back to the pre-switch pack')
      return refuseWithRollback(plan.backupDir, io)
    }
    io.log('switched: profile ' + plan.profile + ' now installs the archived artifacts; restart with ' + plan.restartCommand)
    return 0
  } finally {
    if (plan.buildDir !== undefined && !options.keepBuild) {
      rmSync(plan.buildDir, { recursive: true, force: true })
      io.log('build: removed the temporary build directory ' + plan.buildDir)
    }
  }
}

/**
 * Fold an executable and its arguments into one shell command line. A Windows
 * `.cmd` shim needs a shell, and Node warns (DEP0190) about unescaped arguments
 * passed beside `shell: true`, so the shim is quoted and carries the arguments.
 * @param executable - the shim to run.
 * @param args - its arguments.
 * @returns the quoted command line.
 */
function shellLine(executable: string, args: readonly string[]): string {
  return ['"' + executable + '"', ...args].join(' ')
}

/**
 * Find pnpm on PATH without spawning anything.
 * @param env - the environment whose PATH is searched.
 * @param platform - the platform whose executable names are probed.
 * @returns the absolute pnpm executable, or undefined when PATH carries none.
 */
export function locatePnpmOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  const names = platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat', 'pnpm'] : ['pnpm']
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, '')
    if (directory === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  return undefined
}

/**
 * Resolve the install command for a profile, and never let npm stand in for pnpm.
 *
 * `npm_execpath` is set by npm as well as pnpm, so it is trusted only when it
 * cannot be npm: its basename must not start with `npm`, and either that
 * basename mentions pnpm or `npm_config_user_agent` starts with `pnpm/`. An
 * npm-provided execpath is never used: npm rejects the `link:` protocol the real
 * profile declares (EUNSUPPORTEDPROTOCOL), so degrading to npm would fail on the
 * user's profile while the log claimed pnpm. When no pnpm can be found the
 * refresh refuses with this message instead of installing with npm.
 * @param env - the lifecycle environment to read.
 * @param locate - how pnpm is located on PATH.
 * @returns the invocation to run.
 */
export function resolveInstallInvocation(
  env: NodeJS.ProcessEnv = process.env,
  locate: (env: NodeJS.ProcessEnv) => string | undefined = locatePnpmOnPath,
): PackageManagerInvocation {
  const entrypoint = env.npm_execpath
  const userAgent = env.npm_config_user_agent ?? ''
  const entrypointName = entrypoint === undefined || entrypoint === '' ? '' : basename(entrypoint).toLowerCase()
  const npmEntrypoint = entrypointName.startsWith('npm')
  const pnpmLifecycle = entrypointName !== '' && !npmEntrypoint
    && (entrypointName.includes('pnpm') || userAgent.startsWith('pnpm/'))
  if (pnpmLifecycle && entrypoint !== undefined) {
    const origin = 'npm_execpath from a pnpm lifecycle (' + entrypoint + ')'
    if (/\.[cm]?js$/iu.test(entrypoint)) {
      return { command: process.execPath, args: [entrypoint, 'install'], shell: false, display: 'pnpm install', origin }
    }
    // A .cmd shim takes the whole line, so no argument sits beside a shell.
    return { command: shellLine(entrypoint, ['install']), args: [], shell: true, display: 'pnpm install', origin }
  }
  const found = locate(env)
  if (found === undefined) {
    const startedByNpm = entrypointName === ''
      ? ''
      : '; npm_execpath points at ' + String(entrypoint) + ', so npm started this script'
    throw new Error(
      'cannot find pnpm on PATH' + startedByNpm + '. npm does not implement the link: protocol this profile'
      + ' declares (EUNSUPPORTEDPROTOCOL), so the refresh refuses instead of installing with npm: install pnpm,'
      + ' or start the refresh through pnpm (pnpm exec tsx scripts/refresh-taskboard-plugin.ts ...)',
    )
  }
  const ignored = npmEntrypoint
    ? '; npm_execpath (' + String(entrypoint) + ') is not pnpm and is not used'
    : ''
  const origin = 'pnpm on PATH at ' + found + ignored
  if (process.platform === 'win32' && /\.(cmd|bat)$/iu.test(found)) {
    // A .cmd shim takes the whole line, so no argument sits beside a shell.
    return { command: shellLine(found, ['install']), args: [], shell: true, display: 'pnpm install', origin }
  }
  return { command: found, args: ['install'], shell: false, display: 'pnpm install', origin }
}

/**
 * Run the resolved profile install.
 * @param profileDir - the absolute profile directory.
 * @param invocation - the invocation resolved before the switch started.
 * @returns the combined result.
 */
export function runProfileInstall(profileDir: string, invocation: PackageManagerInvocation): CommandResult {
  // An interactive purge confirmation would block an unattended refresh; the
  // rollback pack is the recovery path for a purge that turns out to be wrong.
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: profileDir,
    encoding: 'utf8',
    shell: invocation.shell,
    env: { ...process.env, npm_config_confirm_modules_purge: 'false' },
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status ?? 1, command: invocation.display, output: result.stdout + result.stderr }
}

/**
 * Emit a fresh standalone tree with the repository's own emitter.
 * @param out - the output directory.
 * @param noBuild - reuse existing build products instead of rebuilding.
 */
export function buildStandalone(out: string, noBuild: boolean): void {
  const manifest = readJsonObject(join(REPO_ROOT, 'node_modules', 'tsx', 'package.json'))
  const bin = manifest.bin as string | Record<string, string> | undefined
  const entry = typeof bin === 'string' ? bin : bin?.tsx
  if (entry === undefined) {
    throw new Error('node_modules/tsx declares no tsx bin; run pnpm install in the checkout first')
  }
  const args = [
    join(REPO_ROOT, 'node_modules', 'tsx', entry),
    join(REPO_ROOT, 'scripts', 'emit-taskboard-standalone.ts'),
    '--out',
    out,
  ]
  if (noBuild) args.push('--no-build')
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      'emit-taskboard-standalone exited ' + String(result.status ?? 1) + '; nothing was archived or written',
    )
  }
}

/**
 * @returns The checkout's short commit sha.
 */
export function currentGitSha(): string {
  const result = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  const sha = result.stdout.trim()
  if (result.status !== 0 || sha === '') {
    throw new Error('git rev-parse --short=8 HEAD failed; artifacts cannot be archived without a version tag')
  }
  return sha
}

/**
 * The default side-effect surface: real pnpm, the real emitter, the real clock.
 * @returns the production RefreshIo.
 */
export function defaultIo(): RefreshIo {
  return {
    log: (line) => {
      process.stdout.write(line + '\n')
    },
    confirm: async (question) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = await readline.question(question)
        return answer.trim() === 'apply'
      } finally {
        readline.close()
      }
    },
    resolveInstall: () => resolveInstallInvocation(),
    install: runProfileInstall,
    build: buildStandalone,
    gitSha: currentGitSha,
    now: () => new Date(),
  }
}

const USAGE = `
Refresh the Taskboard plugins in a DSH profile from verified .tgz artifacts.

  tsx scripts/refresh-taskboard-plugin.ts [options]

  --profile <name>      profile to refresh (default: ${DEFAULT_PROFILE})
  --dsh-home <dir>      Harness home (default: $DSH_HOME, then ~/.dsh)
  --artifacts <dir>     artifact repository (default: ${DEFAULT_ARTIFACTS_ROOT})
  --candidate <dir>     emitted standalone tree (or a directory of tarballs) to
                        install instead of building one
  --tag <label>         archive directory name (default: <version>-<shortsha>)
  --apply               perform the switch (default: dry-run, nothing written)
  --no-build            reuse existing build products (passes through)
  --keep-build          keep the temporary build directory
  --rollback <pack>     restore a rollback pack instead of refreshing
  --fault-skip-install  drill only: pretend pnpm install succeeded so the
                        self-check refusal and rollback can be demonstrated
  -h, --help            print this usage

Why link: is refused
  link:<package dir> hands over a directory and installs NOTHING else: the
  package's own dependencies (zod, @deepseek-ai/schemastery) are never
  materialized. On 2026-09-21 that shape was installed into the web profile and
  the host died during plugin load — the user could not open DSH at all.
  file:<artifact>.tgz is the supported form: pnpm installs the tarball's
  declared dependencies with it, and this script re-checks the resulting
  runtime closure before it reports success.

The install always runs pnpm: an npm-provided npm_execpath is ignored (npm
rejects the link: protocol this deployment's profile declares), pnpm is
resolved from PATH instead, and a refresh refuses when no pnpm can be found.

Sequence
  build -> verify sha256 against SHA256SUMS -> archive into a new
  releases/<version>-<shortsha>/ -> write the rollback pack under
  $DSH_HOME/backups/ -> rewrite only the two file: specs -> pnpm install ->
  dependency self-check -> restart prompt. Any failure refuses the switch and
  restores the pack.

`

/**
 * Parse the command line.
 * @param argv - arguments after the script path.
 * @returns the resolved options.
 */
export function parseOptions(argv: readonly string[]): RefreshOptions {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      profile: { type: 'string' },
      'dsh-home': { type: 'string' },
      artifacts: { type: 'string' },
      candidate: { type: 'string' },
      tag: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      'keep-build': { type: 'boolean', default: false },
      'fault-skip-install': { type: 'boolean', default: false },
      rollback: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (parsed.values.apply && parsed.values['dry-run']) {
    throw new Error('--apply and --dry-run contradict each other')
  }
  if (parsed.values.apply && parsed.values.rollback !== undefined) {
    throw new Error('--rollback restores a pack instead of refreshing; drop --apply')
  }
  const artifacts = parsed.values.artifacts ?? process.env.DSH_TASKBOARD_ARTIFACTS ?? DEFAULT_ARTIFACTS_ROOT
  return {
    profile: parsed.values.profile ?? DEFAULT_PROFILE,
    home: resolveHome(parsed.values['dsh-home']),
    artifactsRoot: resolve(artifacts),
    candidate: parsed.values.candidate,
    tag: parsed.values.tag,
    apply: parsed.values.apply,
    noBuild: parsed.values['no-build'],
    keepBuild: parsed.values['keep-build'],
    faultSkipInstall: parsed.values['fault-skip-install'],
    rollback: parsed.values.rollback,
    help: parsed.values.help,
  }
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    return await runRefresh(options, defaultIo())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('refresh-taskboard-plugin: ' + message + '\n')
    return 1
  }
}

/* v8 ignore next 3 -- the CLI entry runs only when this file is the process entry */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code
  })
}
