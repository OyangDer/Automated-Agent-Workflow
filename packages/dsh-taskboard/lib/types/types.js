/**
 * Client-safe vocabulary of the taskboard domain: the five column ids, the
 * wire snapshots the browser renders, the RPC request payloads, and the one
 * forwarded host event. Pure data module — the browser imports this outlet
 * (directly or through the `./client` re-export) without dragging host
 * services into the client program, and the forwarded-event allowlist reads
 * the `taskboard/changed` declaration from here.
 * @module @deepseek-ai/dsh-taskboard
 */
/** The five workflow columns in canonical left-to-right order. */
export const TASKBOARD_COLUMNS = ['backlog', 'not_started', 'in_progress', 'in_testing', 'done'];
/** The three ticket priority levels. */
export const TASKBOARD_PRIORITIES = ['low', 'normal', 'high'];
/** The ticket kind vocabulary, shown as a badge on the card. */
export const TASKBOARD_TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'merge', 'infra', 'chore', 'spike'];
/** The worker lifecycle of one card (v2 dispatch protocol). */
export const TASKBOARD_WORKER_STATUSES = ['ready', 'claimed', 'running', 'blocked', 'paused'];
//# sourceMappingURL=types.js.map