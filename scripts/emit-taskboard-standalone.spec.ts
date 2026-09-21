import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

import {
  auditArtifact,
  collectPublishedFiles,
  emit,
  packDirectory,
  parseOptions,
  rewriteWorkspaceSpec,
  toPublishManifest,
  walk,
  workspaceVersions,
} from './emit-taskboard-standalone.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-taskboard-standalone-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, content = ''): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

/** Minimal ustar reader that verifies each header checksum, mirroring a consumer. */
function readTar(archive: Buffer): { path: string; data: Buffer }[] {
  const entries: { path: string; data: Buffer }[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number): string =>
      header.subarray(start, start + length).toString('binary').replace(/\0.*$/s, '')
    const stored = parseInt(field(148, 8).trim(), 8)
    const masked = Buffer.from(header)
    masked.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of masked) sum += byte
    expect(sum).toBe(stored)
    const size = parseInt(field(124, 12).trim(), 8)
    entries.push({
      path: field(0, 100),
      data: Buffer.from(archive.subarray(offset + 512, offset + 512 + size)),
    })
    offset += 512 + size + ((512 - (size % 512)) % 512)
  }
  return entries
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('rewriteWorkspaceSpec', () => {
  const versions = new Map([['@scope/pkg', '1.2.3']])

  it('maps every workspace range form onto real semver', () => {
    expect(rewriteWorkspaceSpec('@scope/pkg', 'workspace:^', versions)).toBe('^1.2.3')
    expect(rewriteWorkspaceSpec('@scope/pkg', 'workspace:~', versions)).toBe('~1.2.3')
    expect(rewriteWorkspaceSpec('@scope/pkg', 'workspace:*', versions)).toBe('1.2.3')
    expect(rewriteWorkspaceSpec('@scope/pkg', 'workspace:', versions)).toBe('1.2.3')
    expect(rewriteWorkspaceSpec('@scope/pkg', 'workspace:>=1.0.0', versions)).toBe('>=1.0.0')
  })

  it('passes registry specs through untouched', () => {
    expect(rewriteWorkspaceSpec('zod', '^4.4.3', versions)).toBe('^4.4.3')
  })

  it('refuses a workspace spec whose package has no version', () => {
    expect(() => rewriteWorkspaceSpec('@scope/missing', 'workspace:^', versions)).toThrow(/no workspace version/)
  })
})

describe('toPublishManifest', () => {
  it('rewrites dependencies and peers, drops development-only fields, and repoints the origin', () => {
    const manifest = toPublishManifest(
      {
        name: '@scope/pkg',
        version: '1.0.0',
        scripts: { bundle: 'tsdown' },
        devDependencies: { typescript: 'workspace:^' },
        dependencies: { '@scope/dep': 'workspace:^' },
        peerDependencies: { '@scope/peer': 'workspace:~' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      new Map([['@scope/dep', '2.0.0'], ['@scope/peer', '3.0.0']]),
    )
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
    expect(manifest.dependencies).toEqual({ '@scope/dep': '^2.0.0' })
    expect(manifest.peerDependencies).toEqual({ '@scope/peer': '~3.0.0' })
    expect(manifest.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
  })
})

describe('collectPublishedFiles', () => {
  it('expands globs, keeps declared entries, and skips node_modules', () => {
    const root = fixture()
    write(root, 'lib/index.js')
    write(root, 'lib/types/a.d.ts')
    write(root, 'lib/types/nested/b.d.ts')
    write(root, 'cordis.patch.yml')
    write(root, 'lib/node_modules/dep/index.js')
    expect(collectPublishedFiles(root, ['lib/index.js', 'lib/types/**/*.d.ts', 'cordis.patch.yml']))
      .toEqual(['cordis.patch.yml', 'lib/index.js', 'lib/types/a.d.ts', 'lib/types/nested/b.d.ts'])
  })

  it('fails closed when a declared entry or a glob matches nothing', () => {
    const root = fixture()
    write(root, 'lib/index.js')
    expect(() => collectPublishedFiles(root, ['lib/missing.js'])).toThrow(/files entry is missing/)
    expect(() => collectPublishedFiles(root, ['lib/**/*.d.ts'])).toThrow(/matched nothing/)
  })
})

describe('packDirectory', () => {
  it('emits a checksum-valid, reproducible archive rooted at package/', () => {
    const root = fixture()
    write(root, 'package.json', '{}\n')
    write(root, 'lib/index.js', 'export {}\n')
    const first = packDirectory(root)
    const second = packDirectory(root)
    expect(first.equals(second)).toBe(true)
    const entries = readTar(gunzipSync(first))
    expect(entries.map(entry => entry.path)).toEqual(['package/lib/index.js', 'package/package.json'])
    expect(entries[1]?.data.toString()).toBe('{}\n')
  })
})

describe('auditArtifact', () => {
  it('reports vendored node_modules, source files, and leaked workspace protocol', () => {
    const root = fixture()
    write(root, 'packages/a/package.json', '{"dependencies":{"x":"workspace:^"}}\n')
    write(root, 'packages/a/lib/index.ts', 'export {}\n')
    write(root, 'packages/a/node_modules/dep/index.js', 'module.exports = {}\n')
    write(root, 'stray.txt', 'hello\n')
    const report = auditArtifact(root)
    expect(report.problems).toEqual(expect.arrayContaining([
      'node_modules vendored: packages/a/node_modules/dep/index.js',
      'host source vendored: packages/a/lib/index.ts',
      'unexpected top-level entry: stray.txt',
    ]))
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('workspace: protocol leaked into packages/a/package.json'),
    ]))
    expect(report.problems.some(problem => problem.includes('stray.txt') && problem.includes('protocol'))).toBe(false)
  })

  it('keeps prose and identifiers that merely contain the word out of the blocking set', () => {
    const root = fixture()
    write(root, 'packages/a/lib/service.js', '// materializing it per workspace:\nconst o = { workspace: 1 }\n')
    write(root, 'packages/a/README.md', 'no pnpm workspace protocol\n')
    expect(auditArtifact(root)).toEqual({
      problems: [],
      proseOccurrences: ['packages/a/lib/service.js'],
    })
  })
})

describe('parseOptions', () => {
  it('defaults to building into dist/ and honours --no-build', () => {
    expect(parseOptions([]).build).toBe(true)
    expect(parseOptions([]).out.endsWith(join('dist', 'taskboard-standalone'))).toBe(true)
    expect(parseOptions(['--no-build', '--out', 'somewhere']).build).toBe(false)
    expect(parseOptions(['--no-build', '--out', 'somewhere']).out).toBe(join(process.cwd(), 'somewhere'))
  })
})

describe('emit', () => {
  const sourceManifest = join(process.cwd(), 'packages/taskboard/taskboard/package.json')
  const built = join(process.cwd(), 'packages/taskboard/taskboard/lib/index.js')

  it.skipIf(!existsSync(built))('produces the published tree, packs both tarballs, and is idempotent', () => {
    const first = join(fixture(), 'out')
    const second = join(fixture(), 'out')
    const a = emit({ out: first, build: false, help: false })
    emit({ out: second, build: false, help: false })
    expect(a.audit.problems).toEqual([])
    expect(walk(first).filter(path => path.endsWith('.tgz'))).toHaveLength(2)
    expect(walk(first)).toEqual(walk(second))
    for (const path of walk(first)) {
      expect(readFileSync(join(first, path)).equals(readFileSync(join(second, path))), path).toBe(true)
    }
    const hostManifest = JSON.parse(
      readFileSync(join(first, 'packages/dsh-taskboard/package.json'), 'utf8'),
    ) as { peerDependencies: Record<string, string>; dsh: { bundle: { patch: string } } }
    expect(hostManifest.peerDependencies['@deepseek-ai/dsh-agent']).toMatch(/^\^\d+\.\d+\.\d+/)
    expect(hostManifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(readFileSync(join(first, 'packages/dsh-taskboard/README.md'), 'utf8')).toContain('dsh plugin')
  }, 120_000)

  it('resolves every workspace version the two manifests reference', () => {
    const versions = workspaceVersions()
    const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8')) as Record<string, Record<string, string>>
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!spec.startsWith('workspace:')) continue
        expect(versions.get(name), name).toMatch(/^\d+\.\d+\.\d+/)
      }
    }
  })
})
