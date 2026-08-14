/**
 * Taskboard surface plugin, browser half: one five-column kanban tab in the
 * conversation view ring. Live board state (the active board's snapshot plus
 * the board list) arrives through the forwarded taskboard/changed host event
 * and is republished through one root-scoped observable source; mutations are
 * the generated taskboard Remote verbs, unwrapped from their RemoteResult
 * envelopes. The plugin owns no store beyond the tab's viewing state.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view ring).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { BoardSnapshot, BoardView } from '@deepseek-ai/dsh-taskboard/client'
import { createTaskboardStore } from './stores.ts'
import { TaskboardView } from './TaskboardView.tsx'
import type { BoardState, TaskboardInjected } from './contract.ts'
import { en, zh, type TaskboardKey } from './locales.ts'

export type { TaskboardInjected } from './contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The taskboard tab's copy. */
    taskboard: TaskboardKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'taskboard'

/** Required services for the board tab, Remote verbs, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.taskboard', 'locale']

/** Unwrap one Remote result; failures become plain rejections. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Client plugin body: the conversation.view tab with its verbs and live
 * board-state source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)

  // One root-scoped board state source shared by every session tab: the
  // forwarded change event triggers a refetch of the active board, and the
  // fresh state is republished through the same source identity so hook
  // bindings stay warm.
  let current: BoardState = { boardId: 'default', boards: [], snapshot: null }
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of listeners) listener()
  }

  /** Fetch the board list and one board's snapshot in one round trip. */
  const fetchBoardState = async (boardId: string): Promise<{ boards: BoardView[]; snapshot: BoardSnapshot }> => {
    const [boards, snapshot] = await Promise.all([
      unwrap(await ctx.remote.taskboard.listBoards()),
      unwrap(await ctx.remote.taskboard.snapshot(boardId)),
    ])
    return { boards, snapshot }
  }

  /** Refetch the active board's state and republish it. */
  const refresh = async (): Promise<void> => {
    const boardId = current.boardId
    try {
      const next = await fetchBoardState(boardId)
      // A selection made while this fetch was in flight wins; drop the stale state.
      if (current.boardId !== boardId) return
      current = { boardId, ...next }
    } catch {
      // Keep the last good state; a first load that fails falls back to an
      // empty snapshot so the tab renders something.
      if (current.boardId === boardId && current.snapshot === null) {
        current = { boardId, boards: current.boards, snapshot: { boardId, name: boardId, tickets: [] } }
      }
    }
    publish()
  }

  /** Switch the active board and refetch both feeds. */
  const selectBoard = async (boardId: string): Promise<void> => {
    if (boardId === current.boardId) {
      void refresh()
      return
    }
    current = { ...current, boardId }
    void refresh()
  }

  /** Create one board from its display name, then open it. */
  const createBoard = async (name: string): Promise<BoardView> => {
    const created = unwrap(await ctx.remote.taskboard.createBoard({ name, workspaceId: '' }))
    await selectBoard(created.boardId)
    return created
  }

  /** Archive one board; archiving the active board falls back to default. */
  const archiveBoard = async (boardId: string): Promise<BoardView> => {
    const archived = unwrap(await ctx.remote.taskboard.archiveBoard({ boardId }))
    if (archived.boardId === current.boardId) {
      await selectBoard('default')
    } else {
      void refresh()
    }
    return archived
  }

  const board: HostObservable<BoardState> = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  void refresh()
  ctx.effect(() => ctx.remote.$on('taskboard/changed', () => { void refresh() }), 'ui-taskboard: board changes')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'taskboard',
    order: 20,
    locale: NS,
    label: () => t('view.taskboard'),
    store: createTaskboardStore(),
    inject: (sessionId: SessionId): TaskboardInjected => ({
      create: async request => unwrap(await ctx.remote.taskboard.create(request)),
      move: async request => unwrap(await ctx.remote.taskboard.move(sessionId, request)),
      edit: async request => unwrap(await ctx.remote.taskboard.edit(request)),
      remove: async request => unwrap(await ctx.remote.taskboard.delete(request)),
      requestReview: async request => unwrap(await ctx.remote.taskboard.requestReview(sessionId, request)),
      refresh: () => { void refresh() },
      selectBoard,
      createBoard,
      archiveBoard,
      hooks: { board },
    }),
  }, TaskboardView))
}
