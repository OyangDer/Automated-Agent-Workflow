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
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { BoardView } from './contract.ts';
import { type TaskboardKey } from './locales.ts';
export type { BoardScope, BoardView, CreateBoardRequest, TaskboardInjected } from './contract.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The taskboard tab's copy. */
        taskboard: TaskboardKey;
    }
}
/** Required services for the board tab, Remote verbs, and copy. */
export declare const inject: string[];
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
export declare function pickBoardTarget(boardId: string, boards: readonly BoardView[]): string;
/**
 * Client plugin body: the conversation.view tab with its verbs and live
 * board-state sources.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map