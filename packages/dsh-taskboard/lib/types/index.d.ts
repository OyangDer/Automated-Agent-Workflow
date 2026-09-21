/**
 * Same-session-independent taskboard domain: durable five-column ticket
 * storage, agent workflow tools, browser Remote surface, and reviewer
 * automation. The pure payload outlet (./types.ts, ONE home of the
 * taskboard/changed declaration) is re-exported onto the package root so
 * aggregate programs consuming the declarations still receive the Events
 * merge.
 * @module @deepseek-ai/dsh-taskboard
 */
export type * from './types.ts';
export { TASKBOARD_COLUMNS, TASKBOARD_PRIORITIES } from './types.ts';
export { TaskboardError } from './domain.ts';
export type { TaskboardErrorCode } from './domain.ts';
import TaskboardService from './service.ts';
export type { ReviewSpawnResult, WorkerSpawnResult, CompleteTicketResult, AssignTicketResult, ReassignTicketResult, HandoverResult, TicketRow, Config, } from './service.ts';
export { default } from './service.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The taskboard domain service. */
        taskboard: TaskboardService;
    }
}
//# sourceMappingURL=index.d.ts.map