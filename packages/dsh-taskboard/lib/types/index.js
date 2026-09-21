/**
 * Same-session-independent taskboard domain: durable five-column ticket
 * storage, agent workflow tools, browser Remote surface, and reviewer
 * automation. The pure payload outlet (./types.ts, ONE home of the
 * taskboard/changed declaration) is re-exported onto the package root so
 * aggregate programs consuming the declarations still receive the Events
 * merge.
 * @module @deepseek-ai/dsh-taskboard
 */
export { TASKBOARD_COLUMNS, TASKBOARD_PRIORITIES } from "./types.js";
export { TaskboardError } from "./domain.js";
export { default } from "./service.js";
//# sourceMappingURL=index.js.map