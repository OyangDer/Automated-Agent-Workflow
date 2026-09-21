/**
 * Package-owned durable taskboard invariants: every forwarded
 * taskboard/changed notification must be consistent with the operation that
 * produced it, so a UI or agent never observes a half-applied workflow step.
 * @module @deepseek-ai/dsh-taskboard/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "taskboard-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/** Register the taskboard-workflow invariant companion. */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map