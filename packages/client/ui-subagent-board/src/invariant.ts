/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-subagent-board`.
 * @module @deepseek-ai/dsh-client-ui-subagent-board/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-subagent-board'

/** Cordis companion plugin name. */
export const name = 'client-ui-subagent-board-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the conversation tab is a pure reader — subagent rows
 * arrive through the sessions snapshot and the board observable, mutations go
 * through the taskboard Remote verbs, and the plugin owns no store, emits no
 * cordis events, and holds no cross-plugin mutable state beyond the board
 * source proven by the HMR-safety spec.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
