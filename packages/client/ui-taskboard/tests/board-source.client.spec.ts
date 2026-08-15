import { describe, expect, it } from 'vitest'
import type { BoardView } from '../src/client/contract.ts'
import { pickBoardTarget } from '../src/client/index.ts'

/** Minimal wire row for the selection logic; full host fields ride the cast. */
const board = (boardId: string): BoardView => ({ boardId } as BoardView)

describe('pickBoardTarget (initial board selection resilience)', () => {
  it('keeps the requested board when it is visible', () => {
    expect(pickBoardTarget('b2', [board('b1'), board('b2')])).toBe('b2')
  })

  it('falls back to the first visible board when the requested one is denied', () => {
    // Regression: the legacy 'default' was adopted by another workspace, so
    // the host rejects snapshot(sessionId, 'default') as invisible. The tab
    // must switch to the first visible board instead of rendering an empty
    // selector with an empty board.
    expect(pickBoardTarget('default', [board('board-a'), board('board-b')])).toBe('board-a')
  })

  it('keeps the requested placeholder when no board exists yet', () => {
    expect(pickBoardTarget('default', [])).toBe('default')
  })
})
