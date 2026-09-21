/**
 * Package-owned durable taskboard invariants: every forwarded
 * taskboard/changed notification must be consistent with the operation that
 * produced it, so a UI or agent never observes a half-applied workflow step.
 * @module @deepseek-ai/dsh-taskboard/invariant
 */
import { TASKBOARD_COLUMNS } from "./types.js";
const PACKAGE_NAME = '@deepseek-ai/dsh-taskboard';
/** Cordis companion plugin name. */
export const name = 'taskboard-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** Report one inconsistent notification. */
function report(reportFailure, change, detail) {
    reportFailure('taskboard change ' + change.operation + ' on "' + change.ticketId + '" violates the workflow: ' + detail);
}
/**
 * Install one listener over the forwarded change stream and check the
 * operation/state consistency rules the workflow promises.
 */
const install = (ctx, reportFailure) => {
    ctx.on('taskboard/changed', (change) => {
        const ticket = change.ticket;
        if (ticket === null) {
            if (change.operation !== 'remove') {
                report(reportFailure, change, 'a null ticket is only valid for removal');
            }
            return;
        }
        if (!TASKBOARD_COLUMNS.includes(ticket.column)) {
            report(reportFailure, change, 'unknown column "' + String(ticket.column) + '"');
        }
        if (change.operation === 'claim' && (ticket.column !== 'in_progress' || ticket.assignee === null)) {
            report(reportFailure, change, 'claim must land In progress with an assignee');
        }
        if (change.operation === 'complete' && (ticket.column !== 'in_testing' || ticket.devNotes.trim() === '')) {
            report(reportFailure, change, 'complete must land In testing with non-empty devNotes');
        }
        if (change.operation === 'approve' && (ticket.column !== 'done' || ticket.lastReview?.outcome !== 'approved')) {
            report(reportFailure, change, 'approve must land Done with an approved review');
        }
        if (change.operation === 'reject' && (ticket.column !== 'in_progress' || ticket.lastReview?.outcome !== 'rejected')) {
            report(reportFailure, change, 'reject must return In progress with a rejected review');
        }
        if (change.operation === 'review-claim' && ticket.reviewer === null) {
            report(reportFailure, change, 'review-claim must assign a reviewer');
        }
    }, { global: true });
};
/** Register the taskboard-workflow invariant companion. */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map