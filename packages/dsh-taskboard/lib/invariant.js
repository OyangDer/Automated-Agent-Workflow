//#region lib/types/types.js
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
const TASKBOARD_COLUMNS = [
	"backlog",
	"not_started",
	"in_progress",
	"in_testing",
	"done"
];
//#endregion
//#region lib/types/invariant.js
/**
* Package-owned durable taskboard invariants: every forwarded
* taskboard/changed notification must be consistent with the operation that
* produced it, so a UI or agent never observes a half-applied workflow step.
* @module @deepseek-ai/dsh-taskboard/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-taskboard";
/** Cordis companion plugin name. */
const name = "taskboard-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** Report one inconsistent notification. */
function report(reportFailure, change, detail) {
	reportFailure("taskboard change " + change.operation + " on \"" + change.ticketId + "\" violates the workflow: " + detail);
}
/**
* Install one listener over the forwarded change stream and check the
* operation/state consistency rules the workflow promises.
*/
const install = (ctx, reportFailure) => {
	ctx.on("taskboard/changed", (change) => {
		const ticket = change.ticket;
		if (ticket === null) {
			if (change.operation !== "remove") report(reportFailure, change, "a null ticket is only valid for removal");
			return;
		}
		if (!TASKBOARD_COLUMNS.includes(ticket.column)) report(reportFailure, change, "unknown column \"" + String(ticket.column) + "\"");
		if (change.operation === "claim" && (ticket.column !== "in_progress" || ticket.assignee === null)) report(reportFailure, change, "claim must land In progress with an assignee");
		if (change.operation === "complete" && (ticket.column !== "in_testing" || ticket.devNotes.trim() === "")) report(reportFailure, change, "complete must land In testing with non-empty devNotes");
		if (change.operation === "approve" && (ticket.column !== "done" || ticket.lastReview?.outcome !== "approved")) report(reportFailure, change, "approve must land Done with an approved review");
		if (change.operation === "reject" && (ticket.column !== "in_progress" || ticket.lastReview?.outcome !== "rejected")) report(reportFailure, change, "reject must return In progress with a rejected review");
		if (change.operation === "review-claim" && ticket.reviewer === null) report(reportFailure, change, "review-claim must assign a reviewer");
	}, { global: true });
};
/** Register the taskboard-workflow invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
