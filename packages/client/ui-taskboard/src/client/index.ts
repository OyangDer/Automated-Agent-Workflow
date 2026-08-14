/**
 * Taskboard surface plugin, browser half: one five-column kanban tab in the
 * conversation view ring. Live board state arrives through the forwarded
 * taskboard/changed host event (refetched snapshot published through one
 * root-scoped observable source); mutations are the generated taskboard
 * Remote verbs, unwrapped from their RemoteResult envelopes. The plugin owns
 * no store beyond the tab's viewing state.
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
import type { BoardSnapshot } from '@deepseek-ai/dsh-taskboard/client'
import { createTaskboardStore } from './stores.ts'
import { TaskboardView } from './TaskboardView.tsx'
import type { TaskboardInjected } from './contract.ts'
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
 * snapshot source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)

  // One root-scoped board snapshot source shared by every session tab: the
  // forwarded change event triggers a refetch, and the fresh snapshot is
  // republished through the same source identity so hook bindings stay warm.
  let current: BoardSnapshot | null = null
  const listeners = new Set<() => void>()
  const refresh = async (): Promise<void> => {
    try {
      current = unwrap(await ctx.remote.taskboard.snapshot())
    } catch {
      // Keep the last good snapshot; failures surface through the next retry.
      current = current === null ? { tickets: [] } : current
    }
    for (const listener of listeners) listener()
  }
  const board: HostObservable<BoardSnapshot | null> = {
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
      hooks: { board },
    }),
  }, TaskboardView))
}
