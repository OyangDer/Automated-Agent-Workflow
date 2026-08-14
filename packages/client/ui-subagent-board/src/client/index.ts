/**
 * Subagent classification surface plugin, browser half: one conversation view
 * tab grouping this session's direct children by their taskboard lifecycle.
 * Child rows arrive through the framework sessions seat (subagentsByParent);
 * badge data is a root-scoped default-board snapshot refetched on every
 * taskboard/changed event, republished through one stable observable source.
 * The plugin owns no store beyond that live source.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view ring).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
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

  // One root-scoped default-board source shared by every session tab: the
  // forwarded change event triggers a refetch, and the fresh snapshot is
  // republished through the same source identity so hook bindings stay warm.
  let current: BoardSnapshot | null = null
  const listeners = new Set<() => void>()
  const refresh = async (): Promise<void> => {
    try {
      current = unwrap(await ctx.remote.taskboard.snapshot('default'))
    } catch {
      // Keep the last good snapshot; failures surface through the next retry.
      current = current === null ? { boardId: 'default', name: '', tickets: [] } : current
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
  ctx.effect(() => ctx.remote.$on('taskboard/changed', () => { void refresh() }), 'ui-subagent-board: board changes')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'taskboard-subagents',
    order: 21,
    locale: NS,
    label: () => t('view.subagents'),
    inject: (): SubagentBoardInjected => ({
      hooks: { board },
    }),
  }, SubagentBoardView))
}
