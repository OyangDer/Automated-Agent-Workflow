// @vitest-environment jsdom
/**
 * Presentation-level acceptance of the V6-2 ceiling row: the preset options,
 * the current value readout, the percent input, the reset gate and the
 * invalid-input error path. Props are fed directly — no render machinery and
 * no settings transport — per the component-test convention.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { CompactionCeilingRow, ceilingPercent } from '../src/client/CompactionCeilingRow.tsx'
import type {
  CompactionCeilingFace, CompactionCeilingState,
} from '../src/client/compaction-threshold.ts'
import type { TaskboardT } from '../src/client/TicketCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as unknown as TaskboardT

/** One recorded write. */
type Call = readonly [kind: 'choose' | 'reset', ratio: number | undefined]

/** A stub ceiling face plus its publication hook. */
function harness(initial: Partial<CompactionCeilingState> = {}): {
  face: CompactionCeilingFace
  calls: Call[]
  publish: (next: Partial<CompactionCeilingState>) => void
} {
  let state: CompactionCeilingState = {
    status: 'ready', ratio: 0.3, base: 0.3, overridden: false, writable: true, ...initial,
  }
  const calls: Call[] = []
  const listeners = new Set<() => void>()
  return {
    calls,
    publish: (next) => {
      state = { ...state, ...next }
      for (const listener of [...listeners]) listener()
    },
    face: {
      state: {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      choose: async (ratio) => { calls.push(['choose', ratio]) },
      reset: async () => { calls.push(['reset', undefined]) },
      dispose: () => {},
    },
  }
}

describe('CompactionCeilingRow', () => {
  it('renders the preset options, the value in force and the composition default', () => {
    const { face } = harness()
    render(createElement(CompactionCeilingRow, { ceiling: face, t }))

    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      '30%', '50%', '70%', '85%', '应用', '恢复默认',
    ])
    expect(screen.getByTestId('taskboard-compaction-value').textContent).toContain('当前 30%')
    expect(screen.getByTestId('taskboard-compaction-value').textContent).not.toContain('已自定义')
  })

  it('stores a preset and marks the user override', () => {
    const { face, calls, publish } = harness()
    render(createElement(CompactionCeilingRow, { ceiling: face, t }))

    fireEvent.click(screen.getByRole('button', { name: '70%' }))
    expect(calls).toEqual([['choose', 0.7]])

    act(() => { publish({ ratio: 0.7, overridden: true }) })
    expect(screen.getByTestId('taskboard-compaction-value').textContent).toContain('当前 70% · 已自定义')
  })

  it('stores a typed percent and refuses one outside 1-100', () => {
    const { face, calls } = harness()
    render(createElement(CompactionCeilingRow, { ceiling: face, t }))
    const input = screen.getByLabelText('压缩触发阈值百分比')

    fireEvent.change(input, { target: { value: '62.5' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(calls).toEqual([['choose', 0.625]])

    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(calls).toEqual([['choose', 0.625]])
    expect(screen.getByRole('alert').textContent).toBe('请输入 1–100 之间的百分比')
  })

  it('clears the override only when one exists', () => {
    const { face, calls, publish } = harness({ ratio: 0.85, overridden: true })
    render(createElement(CompactionCeilingRow, { ceiling: face, t }))

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(calls).toEqual([['reset', undefined]])

    act(() => { publish({ ratio: 0.3, overridden: false }) })
    expect(screen.getByRole('button', { name: '恢复默认' })).toHaveProperty('disabled', true)
    expect(screen.getByTestId('taskboard-compaction-value').textContent).toBe('当前 30%')
    expect(screen.getByTestId('taskboard-compaction').textContent).toContain('默认 30%')
  })

  it('disables every control when the Host serves no such section', () => {
    const { face } = harness({ status: 'unavailable', ratio: undefined, writable: false })
    render(createElement(CompactionCeilingRow, { ceiling: face, t }))

    expect(screen.getByTestId('taskboard-compaction-value').textContent).toContain('当前部署未提供该设置')
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveProperty('disabled', true)
    }
  })

  it('formats ratios as trimmed percents', () => {
    expect(ceilingPercent(0.3)).toBe('30')
    expect(ceilingPercent(0.625)).toBe('62.5')
    expect(ceilingPercent(1)).toBe('100')
  })
})
