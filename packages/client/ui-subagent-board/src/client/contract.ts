/**
 * The subagent classification tab's business face: the board snapshot source
 * consumed from the taskboard domain. The subagent rows themselves arrive
 * through the framework sessions seat — this plugin owns no store; the board
 * observable is the only injected capability.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BoardSnapshot } from '@deepseek-ai/dsh-taskboard/client'

/** The browser face one SubagentBoardView surface may read. */
export interface SubagentBoardInjected {
  /** Live default-board snapshot source; the renderer binds it into useBoard. */
  hooks: { board: HostObservable<BoardSnapshot | null> }
  /**
   * Report whether this tab is consuming live subagent-catalog updates for
   * its session: while open, subagent start/end membership frames trigger a
   * debounced catalog refresh in the sessions runtime.
   */
  setCatalogOpen(open: boolean): void
}
