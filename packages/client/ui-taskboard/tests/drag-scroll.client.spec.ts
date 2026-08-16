/**
 * Unit tests for the drag auto-scroll and insertion-slot helpers. These are
 * pure geometry rules — no DOM — so every branch is pinned here.
 */
import { describe, expect, it } from 'vitest'
import {
  DRAG_AUTO_SCROLL_DEFAULTS, autoScrollDelta, insertionIndexAt, insertionSlot,
} from '../src/client/dragScroll.ts'

describe('autoScrollDelta', () => {
  it('returns 0 in the middle of the container', () => {
    expect(autoScrollDelta(100, 0, 200, 40, 8)).toBe(0)
  })

  it('scrolls up inside the top edge zone', () => {
    // Pointer 5px inside a 40px zone over a 200px container: depth 0.875 → ~7.
    const delta = autoScrollDelta(5, 0, 200, 40, 8)
    expect(delta).toBeLessThan(0)
    expect(delta).toBeGreaterThanOrEqual(-8)
  })

  it('scrolls down inside the bottom edge zone', () => {
    const delta = autoScrollDelta(195, 0, 200, 40, 8)
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(8)
  })

  it('ramps speed with depth toward the edge', () => {
    const atEdge = Math.abs(autoScrollDelta(0, 0, 200, 40, 8))
    const nearEdge = Math.abs(autoScrollDelta(39, 0, 200, 40, 8))
    const center = Math.abs(autoScrollDelta(100, 0, 200, 40, 8))
    expect(atEdge).toBeGreaterThanOrEqual(nearEdge)
    expect(nearEdge).toBeGreaterThan(center)
    expect(center).toBe(0)
  })

  it('caps the delta at the configured speed', () => {
    expect(Math.abs(autoScrollDelta(0, 0, 200, 40, 8))).toBeLessThanOrEqual(8)
    expect(Math.abs(autoScrollDelta(200, 0, 200, 40, 8))).toBeLessThanOrEqual(8)
  })

  it('returns 0 for degenerate containers', () => {
    expect(autoScrollDelta(50, 0, 0, 40, 8)).toBe(0)
    expect(autoScrollDelta(50, 100, -10, 40, 8)).toBe(0)
  })

  it('halves the zone for tiny containers so the middle stays idle', () => {
    // A 20px container with a 40px threshold: both zones collapse to 10px,
    // the exact middle is idle, and the extremes still scroll.
    expect(autoScrollDelta(10, 0, 20, 40, 8)).toBe(0)
    expect(autoScrollDelta(0, 0, 20, 40, 8)).toBeLessThan(0)
    expect(autoScrollDelta(20, 0, 20, 40, 8)).toBeGreaterThan(0)
  })

  it('honors a caller-supplied threshold and speed', () => {
    const wide = autoScrollDelta(5, 0, 200, 80, 20)
    expect(wide).toBeLessThanOrEqual(-1)
    // Same pointer position, narrower zone and slower speed: still scrolls,
    // but with a smaller magnitude than the wide-and-fast configuration.
    const narrow = autoScrollDelta(5, 0, 200, 10, 2)
    expect(Math.abs(narrow)).toBeLessThan(Math.abs(wide))
  })
})

describe('insertionIndexAt', () => {
  const spans = [
    { top: 0, bottom: 40 },
    { top: 48, bottom: 88 },
    { top: 96, bottom: 136 },
  ]

  it('inserts before the first card above its midpoint', () => {
    expect(insertionIndexAt(10, spans)).toBe(0)
  })

  it('inserts before the second card past the first midpoint', () => {
    expect(insertionIndexAt(30, spans)).toBe(1)
  })

  it('appends below the last card', () => {
    expect(insertionIndexAt(140, spans)).toBe(3)
  })

  it('appends into an empty column', () => {
    expect(insertionIndexAt(50, [])).toBe(0)
  })
})

describe('insertionSlot', () => {
  const ids = ['a', 'b', 'c']

  it('appends when no before id is chosen', () => {
    expect(insertionSlot(ids, null)).toBe(3)
  })

  it('resolves a chosen before id to its slot', () => {
    expect(insertionSlot(ids, 'b')).toBe(1)
  })

  it('appends for an unknown before id', () => {
    expect(insertionSlot(ids, 'zzz')).toBe(3)
  })

  it('handles the empty list', () => {
    expect(insertionSlot([], null)).toBe(0)
    expect(insertionSlot([], 'x')).toBe(0)
  })
})

describe('DRAG_AUTO_SCROLL_DEFAULTS', () => {
  it('exports positive, sane defaults', () => {
    expect(DRAG_AUTO_SCROLL_DEFAULTS.threshold).toBeGreaterThan(0)
    expect(DRAG_AUTO_SCROLL_DEFAULTS.speed).toBeGreaterThan(0)
  })
})
