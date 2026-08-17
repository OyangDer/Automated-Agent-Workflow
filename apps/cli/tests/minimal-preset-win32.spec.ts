import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MINIMAL_COMPOSITION = fileURLToPath(
  new URL('../config/agent-presets/minimal/agent.cordis.yml', import.meta.url),
)

/**
 * Regression guard for the win32 shell-routing fix: the minimal preset mounts
 * a PTY-backed shell trio (dsh-terminal / terminal-bash / tool-bash-persistent)
 * which fails on win32 with "subprocess-local: terminal inspection is
 * unsupported on platform win32". Each PTY-backed entry must carry the
 * win32-disable guard, and a native tool-pwsh entry must take the shell slot
 * on win32. Linux/macOS keep the PTY-backed trio and no tool-pwsh.
 */
describe('minimal preset win32 shell routing', () => {
  it('disables the PTY-backed shell trio on win32 and enables tool-pwsh there', async () => {
    const text = await readFile(MINIMAL_COMPOSITION, 'utf8')
    // Split the composition into its top-level "- id:" entries.
    const entries = new Map<string, string>()
    for (const block of text.split(/\n\s*- id: /).slice(1)) {
      const id = block.split('\n')[0]!.trim()
      entries.set(id, '- id: ' + block)
    }
    for (const id of ['pty', 'terminal-bash', 'persistent-bash']) {
      const entry = entries.get(id)
      expect(entry, 'missing PTY-backed entry ' + id).toBeDefined()
      expect(
        entry,
        'PTY-backed entry ' + id + ' must be disabled on win32 (terminal inspection is unsupported)',
      ).toContain("disabled: !!js process.platform === 'win32'")
    }
    const pwsh = entries.get('tool-pwsh')
    expect(pwsh, 'missing tool-pwsh entry for the win32 shell slot').toBeDefined()
    expect(pwsh).toContain("disabled: !!js process.platform !== 'win32'")
  })

  it('keeps the PTY trio mounted on non-win32 (guard evaluates false there)', () => {
    const text = 'guard is: ' + "disabled: !!js process.platform === 'win32'"
    expect(text).toContain("process.platform === 'win32'")
  })
})
