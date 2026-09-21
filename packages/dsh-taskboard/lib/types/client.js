/**
 * Client-namespace projection of the taskboard domain: a pure re-export of
 * the package's types outlet. Client code imports ONLY the client namespace
 * (repo discipline), so `./client` projects the same single-source content
 * `./types` serves to host consumers — zero duplication.
 * @module @deepseek-ai/dsh-taskboard
 */
export { TASKBOARD_COLUMNS, TASKBOARD_PRIORITIES } from "./types.js";
//# sourceMappingURL=client.js.map