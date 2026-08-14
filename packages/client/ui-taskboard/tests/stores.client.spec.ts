// @vitest-environment jsdom
/**
 * The taskboard viewing store: selection is the tab's only shared state.
 */
import { describe, expect, it } from 'vitest'
import { createTaskboardStore } from '../src/client/stores.ts'

describe('createTaskboardStore', () => {
  it('starts with nothing selected and follows the declared action', () => {
    const handle = createTaskboardStore()
    const store = handle.create()
    expect(store.getSnapshot().selectedId).toBeNull()
    store.actions.select('ticket-1')
    expect(store.getSnapshot().selectedId).toBe('ticket-1')
    store.actions.select(null)
    expect(store.getSnapshot().selectedId).toBeNull()
  })
})
