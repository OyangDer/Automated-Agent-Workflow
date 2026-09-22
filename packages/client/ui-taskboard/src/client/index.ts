/**
 * Taskboard surface plugin, browser half: one five-column kanban tab in the
 * conversation view ring. The host scopes the board verbs to the calling
 * session's workspace (resolved from the session cwd), so live board state —
 * the active board's snapshot plus the board list — is kept PER SESSION: each
 * session tab owns one observable source fed by fetches carrying that
 * session's id, and the forwarded taskboard/changed event refreshes every
 * live source. Mutations are the generated taskboard Remote verbs, unwrapped
 * from their RemoteResult envelopes. The plugin owns no store beyond each
 * tab's viewing state.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Session and Workspace Controller service merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view ring).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings domain's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { BoardSnapshot } from '@deepseek-ai/dsh-taskboard/client'
import {
  COMPACTION_CEILING_NS, createCompactionCeilingFace,
  type CompactionCeilingFace, type CompactionCeilingSection,
} from './compaction-threshold.ts'
import { createTaskboardStore } from './stores.ts'
import { TaskboardView } from './TaskboardView.tsx'
import type { BoardScope, BoardState, BoardView, CreateBoardRequest, TaskboardInjected } from './contract.ts'
import { en, zh, type TaskboardKey } from './locales.ts'

export type { BoardScope, BoardView, CreateBoardRequest, TaskboardInjected } from './contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The taskboard tab's copy. */
    taskboard: TaskboardKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'taskboard'

/** Required services for the board tab, Remote verbs, and copy. */
export const inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.taskboard', 'locale']

/** Unwrap one Remote result; failures become plain rejections. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Pick the effective active board for a fetch: the requested board when the
 * session can see it, otherwise the first visible board. The requested id
 * only survives as the pre-fetch placeholder when no board exists yet. This
 * keeps the first load alive when the legacy 'default' board was adopted by
 * another workspace and the host denies its snapshot.
 * @param boardId - the board the caller asked to render.
 * @param boards - the board list the host reports as visible to the session.
 * @returns the board id to snapshot: the request when visible, else the first visible board, else the request.
 */
export function pickBoardTarget(boardId: string, boards: readonly BoardView[]): string {
  if (boards.some(board => board.boardId === boardId)) return boardId
  return boards[0]?.boardId ?? boardId
}

/** One session's live board state source (created lazily per session cell). */
interface BoardSource {
  board: HostObservable<BoardState>
  refresh(): Promise<void>
  selectBoard(boardId: string): Promise<void>
  createBoard(name: string, scope?: BoardScope): Promise<BoardView>
  archiveBoard(boardId: string): Promise<BoardView>
}

/**
 * Client plugin body: the conversation.view tab with its verbs and live
 * board-state sources.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)

  // V6-2: one ceiling face per plugin, shared by every session tab. The scope
  // belongs to this fiber, so the control and the Host section it edits share
  // one lifetime. The settings domain stays optional: a composition that mounts
  // no settings client renders exactly the board it always did.
  let ceiling: CompactionCeilingFace | undefined
  ctx.inject(['settingsScope'], (settingsCtx) => {
    const face = createCompactionCeilingFace(
      settingsCtx.settingsScope.bind<CompactionCeilingSection>({ namespace: COMPACTION_CEILING_NS }),
    )
    ceiling = face
    return () => {
      ceiling = undefined
      face.dispose()
    }
  })

  /**
   * Per-session board state sources: the host scopes snapshot/listBoards/
   * createBoard to the calling session's workspace, so every session tab
   * keeps its own board list and active-board snapshot, fetched with that
   * session's id. A source is created on the tab's first inject (the
   * renderer caches inject results per session cell) and stays warm across
   * tab switches, so a returning session shows its own boards immediately.
   */
  const sources = new Map<SessionId, BoardSource>()

  /** Resolve one session's owning workspace id; '' when unowned or unknown. */
  const workspaceOf = (sessionId: SessionId): string => {
    const items = ctx.workspaces.list.getSnapshot().items
    return items.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId ?? ''
  }

  /** Build one session's board state source. */
  const makeSource = (sessionId: SessionId): BoardSource => {
    let current: BoardState = {
      // Pre-fetch placeholder: the effective active board is resolved after
      // the first listBoards lands (the legacy 'default' may be invisible to
      // this session once another workspace adopted it).
      boardId: 'default',
      boards: [],
      snapshot: null,
      workspaceId: workspaceOf(sessionId),
      // The pre-fetch fallback reads as project-shared.
      scope: 'project',
      ownerSessionId: null,
      masterAgentId: null,
      masterClaimedAt: null,
      masterExpiresAt: null,
    }
    const listeners = new Set<() => void>()
    const publish = (): void => {
      for (const listener of listeners) listener()
    }

    /**
     * Fetch the board list and the active board's snapshot. The list is
     * authoritative for visibility: when the requested board is not in it
     * (the legacy 'default' may belong to another workspace under project
     * isolation), the first visible board becomes the effective active
     * board instead of failing the whole first load. A snapshot failure
     * degrades to an empty snapshot while keeping the fetched board list,
     * so the selector never loses the boards it already knows about.
     */
    const fetchBoardState = async (boardId: string): Promise<{ boardId: string; boards: BoardView[]; snapshot: BoardSnapshot }> => {
      const boards = unwrap(await ctx.remote.taskboard.listBoards(sessionId)) as BoardView[]
      const target = pickBoardTarget(boardId, boards)
      let snapshot: BoardSnapshot
      if (boards.length === 0) {
        snapshot = { boardId: target, name: target, tickets: [] }
      } else {
        try {
          snapshot = unwrap(await ctx.remote.taskboard.snapshot(sessionId, target))
        } catch {
          snapshot = { boardId: target, name: target, tickets: [] }
        }
      }
      return { boardId: target, boards, snapshot }
    }

    /** Refetch the active board's state and republish it. */
    const refresh = async (): Promise<void> => {
      const boardId = current.boardId
      try {
        const next = await fetchBoardState(boardId)
        // A selection made while this fetch was in flight wins; drop the stale state.
        if (current.boardId !== boardId) return
        const active = next.boards.find(board => board.boardId === next.boardId)
        current = {
          boardId: next.boardId,
          boards: next.boards,
          snapshot: next.snapshot,
          workspaceId: workspaceOf(sessionId),
          scope: active?.scope ?? 'project',
          ownerSessionId: active?.ownerSessionId ?? null,
          masterAgentId: active?.masterAgentId ?? null,
          masterClaimedAt: active?.masterClaimedAt ?? null,
          masterExpiresAt: active?.masterExpiresAt ?? null,
        }
      } catch {
        // Keep the last good state; a first load whose board list also fails
        // falls back to an empty snapshot so the tab renders something.
        if (current.boardId === boardId && current.snapshot === null) {
          current = {
            ...current,
            snapshot: { boardId, name: boardId, tickets: [] },
          }
        }
      }
      publish()
    }

    /** Switch the active board and refetch both feeds. */
    const selectBoard = (boardId: string): Promise<void> => {
      if (boardId !== current.boardId) current = { ...current, boardId }
      // The refetch stays fire-and-forget: the returned promise settles at once.
      void refresh()
      return Promise.resolve()
    }

    /** Create one board from its display name and scope, then open it. */
    const createBoard = async (name: string, scope: BoardScope = 'session'): Promise<BoardView> => {
      const request: CreateBoardRequest = { name, scope }
      // The request's scope rides the wire to the host; the return row is
      // pinned to the client view the host contract will provide.
      const created = unwrap(await ctx.remote.taskboard.createBoard(sessionId, request))
      await selectBoard(created.boardId)
      return created
    }

    /** Archive one board; archiving the active board falls back to default. */
    const archiveBoard = async (boardId: string): Promise<BoardView> => {
      const archived = unwrap(await ctx.remote.taskboard.archiveBoard(sessionId, { boardId }))
      if (archived.boardId === current.boardId) {
        await selectBoard('default')
      } else {
        void refresh()
      }
      return archived
    }

    return {
      board: {
        getSnapshot: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      refresh,
      selectBoard,
      createBoard,
      archiveBoard,
    }
  }

  // The forwarded change event carries no session identity, so every live
  // source refetches (only the mounted tab's state is observed; the rest
  // stay warm for their next mount).
  ctx.effect(() => ctx.remote.$on('taskboard/changed', () => {
    for (const source of sources.values()) void source.refresh()
  }), 'ui-taskboard: board changes')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'taskboard',
    order: 20,
    locale: NS,
    label: () => t('view.taskboard'),
    store: createTaskboardStore(),
    inject: (sessionId: SessionId): TaskboardInjected => {
      const existing = sources.get(sessionId)
      const source = existing ?? makeSource(sessionId)
      if (existing === undefined) {
        sources.set(sessionId, source)
        void source.refresh()
      }
      return {
        create: async request => unwrap(await ctx.remote.taskboard.create(sessionId, request)),
        move: async request => unwrap(await ctx.remote.taskboard.move(sessionId, request)),
        edit: async request => unwrap(await ctx.remote.taskboard.edit(sessionId, request)),
        remove: async request => unwrap(await ctx.remote.taskboard.delete(sessionId, request)),
        requestReview: async request => unwrap(await ctx.remote.taskboard.requestReview(sessionId, request)),
        refresh: () => { void source.refresh() },
        selectBoard: boardId => source.selectBoard(boardId),
        createBoard: (name, scope) => source.createBoard(name, scope),
        archiveBoard: boardId => source.archiveBoard(boardId),
        hooks: { board: source.board },
        ...(ceiling === undefined ? {} : { compaction: ceiling }),
      }
    },
  }, TaskboardView))
}
