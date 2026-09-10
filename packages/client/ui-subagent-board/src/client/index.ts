/**
 * Subagent classification surface plugin, browser half: one conversation view
 * tab grouping this session's direct children by their taskboard lifecycle.
 * Child rows arrive through the framework sessions seat (subagentsByParent);
 * badge data is a root-scoped default-board snapshot refetched on every
 * taskboard/changed event, republished through one stable observable source.
 * The plugin owns no store beyond that live source.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Session Controller service merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view ring).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { BoardSnapshot } from '@deepseek-ai/dsh-taskboard/client'
import { SubagentBoardView } from './SubagentBoardView.tsx'
import type { SubagentBoardInjected } from './contract.ts'
import { en, zh, type TaskboardBoardKey } from './locales.ts'

export type { SubagentBoardInjected } from './contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The subagent classification tab's copy. */
    taskboardBoard: TaskboardBoardKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'taskboardBoard'

/** Required services for the classification tab, its Remote verbs, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.taskboard', 'locale']

/** Unwrap one Remote result; failures become plain rejections. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Client plugin body: the conversation.view tab reading the sessions seat
 * plus its own default-board snapshot source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-subagent-board: dictionaries')
  const t = ctx.locale.bind(NS)

  // The taskboard snapshot verb now carries the calling session (the host
  // resolves the session's workspace default board), so each session cell
  // keeps its own default-board source, fetched with that session's id.
  const sources = new Map<SessionId, { board: HostObservable<BoardSnapshot | null>; refresh(): Promise<void> }>()

  /** Build one session's default-board source. */
  const makeSource = (sessionId: SessionId): { board: HostObservable<BoardSnapshot | null>; refresh(): Promise<void> } => {
    let current: BoardSnapshot | null = null
    const listeners = new Set<() => void>()
    const refresh = async (): Promise<void> => {
      try {
        current = unwrap(await ctx.remote.taskboard.snapshot(sessionId))
      } catch {
        // Keep the last good snapshot; failures surface through the next retry.
        current = current === null ? { boardId: 'default', name: '', tickets: [] } : current
      }
      for (const listener of listeners) listener()
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
    }
  }

  // The forwarded change event carries no session identity, so every live
  // source refetches (only the mounted tab's state is observed).
  ctx.effect(() => ctx.remote.$on('taskboard/changed', () => {
    for (const source of sources.values()) void source.refresh()
  }), 'ui-subagent-board: board changes')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'taskboard-subagents',
    order: 21,
    locale: NS,
    label: () => t('view.subagents'),
    inject: (sessionId: SessionId): SubagentBoardInjected => {
      let source = sources.get(sessionId)
      if (source === undefined) {
        source = makeSource(sessionId)
        sources.set(sessionId, source)
        void source.refresh()
      }
      return {
        hooks: { board: source.board },
        // While this tab is mounted, the parent session's direct-child
        // catalog consumes live membership updates: subagent start/end
        // frames refresh it, so the directory stays current.
        setCatalogOpen: (open: boolean) => ctx.sessions.setSubagentCatalogOpen(sessionId, open),
      }
    },
  }, SubagentBoardView))
}
