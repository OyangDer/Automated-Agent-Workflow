/**
 * One-line reuse path for the Taskboard "is the UI actually clickable"
 * acceptance (V6-13).
 *
 * A card whose deliverable is a clickable Taskboard surface attaches the real
 * run of this command to its report. It fails loud on the two prerequisites
 * that otherwise waste a browser boot, then drives one assembled-browser smoke
 * through `vitest.web.config.ts` (the lane `test:web:built` runs): the shipped
 * plugin layers over the real Host
 * composition plus a real Chromium. The lane prints the evidence line the
 * report quotes — the on-screen number and the Host state around one click.
 *
 * Reuse for another Taskboard UI card: copy `taskboard-roster.e2e.ts`, keep its
 * dual-evidence shape, pass `--file <your file>`. The three-step recipe lives in
 * `apps/web/tests/README.md`.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root, derived from this script's location under `scripts/`. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The smoke this command drives unless `--file` names another one. */
const DEFAULT_FILE = join('apps', 'web', 'tests', 'taskboard-roster.e2e.ts')

const USAGE = `
Drive one assembled-browser Taskboard smoke and print its evidence line.

  tsx scripts/taskboard-ui-acceptance.ts [--file <e2e file>] [-- <vitest args>]

  --file <path>  smoke to run, resolved against the repository root
                 (default: ${DEFAULT_FILE})
  -h, --help     print this usage

Build first (pnpm run build, or pnpm run test:web for the build plus the whole
lane): this command never builds, so a stale dist fails loud instead of testing
yesterday's bundle. The lane needs the Chromium revision that the apps/web
Playwright asks for; the root CLI resolves an older one.
`

/** Resolved command line. */
interface Options {
  /** Smoke to run, relative to the repository root. */
  file: string
  /** Arguments after `--`, handed to vitest unchanged. */
  passthrough: string[]
  /** Print the usage instead of running. */
  help: boolean
}

/**
 * Parse the command line.
 * @param argv - arguments after the script path.
 * @returns the resolved options.
 */
function parseOptions(argv: readonly string[]): Options {
  const options: Options = { file: DEFAULT_FILE, passthrough: [], help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      options.passthrough = argv.slice(index + 1)
      break
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--file') {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new Error('--file needs a path')
      options.file = value
      index += 1
      continue
    }
    throw new Error('unknown argument ' + JSON.stringify(arg))
  }
  return options
}

/**
 * The browser the e2e lane will launch: the Playwright copy `apps/web` depends
 * on, not the root CLI (`pnpm exec playwright` resolves an older release and so
 * installs the wrong Chromium revision).
 * @returns the resolved Playwright version and its Chromium executable.
 */
async function laneBrowser(): Promise<{ version: string; executable: string }> {
  const require = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'))
  const manifest = JSON.parse(readFileSync(require.resolve('playwright/package.json'), 'utf8')) as {
    version?: unknown
  }
  const entry = require.resolve('playwright')
  // Playwright's entry is CommonJS, so the dynamic import carries it on
  // `default`; accept either shape rather than guessing the loader's choice.
  const lane = await import(pathToFileURL(entry).href) as {
    chromium?: { executablePath(): string }
    default?: { chromium?: { executablePath(): string } }
  }
  const chromium = lane.chromium ?? lane.default?.chromium
  if (chromium === undefined) throw new Error('the resolved playwright at ' + entry + ' exposes no chromium')
  return {
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    executable: chromium.executablePath(),
  }
}

/**
 * Check what the lane needs before it spends a browser boot.
 * @param file - the absolute smoke path.
 * @returns the Playwright version in play.
 */
async function requirePrerequisites(file: string): Promise<string> {
  if (!existsSync(file)) throw new Error('no such smoke: ' + file)
  const dist = join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(dist)) {
    throw new Error('apps/web/dist is not built — run `pnpm run build`, or `pnpm run test:web` for the build'
      + ' plus the whole lane (`support.ts` fails the same way)')
  }
  const { version, executable } = await laneBrowser()
  if (!existsSync(executable)) {
    throw new Error('playwright ' + version + ' launches ' + executable + ', which is not installed;'
      + ' `pnpm exec playwright install chromium` resolves the root release and installs the wrong revision —'
      + ' run `node node_modules/playwright/cli.js install chromium` from apps/web instead')
  }
  return version
}

/**
 * Drive one smoke.
 * @returns the lane's exit code.
 */
async function main(): Promise<number> {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(USAGE)
      return 0
    }
    const file = resolve(REPO_ROOT, options.file)
    const version = await requirePrerequisites(file)
    const vitest = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
    if (!existsSync(vitest)) throw new Error('vitest is not installed — run `pnpm install`')
    const shown = relative(REPO_ROOT, file).split('\\').join('/')
    process.stdout.write('taskboard-ui-acceptance: ' + shown + ' on playwright ' + version + '\n')
    const result = spawnSync(
      process.execPath,
      [vitest, 'run', '--config', 'vitest.web.config.ts', relative(REPO_ROOT, file), ...options.passthrough],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    if (result.error !== undefined) throw result.error
    return result.status ?? 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write('taskboard-ui-acceptance: ' + message + '\n')
    return 1
  }
}

/* v8 ignore next 3 -- the CLI entry runs only when this file is the process entry */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code
  })
}
