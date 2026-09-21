/**
 * Pure drag-and-drop helpers for the kanban board: edge auto-scroll math and
 * insertion-slot resolution. Kept dependency-free so the rules are
 * unit-testable without a DOM; the view only measures rects and applies the
 * returned deltas.
 */
/** Tuning knobs for the edge auto-scroll active while a card drag runs. */
export interface DragAutoScrollOptions {
    /** Pointer distance (px) from a scroll container edge that arms auto-scroll. */
    threshold: number;
    /** Pixels scrolled per animation frame when the pointer sits at the very edge. */
    speed: number;
}
/** Defaults; the board view accepts overrides through its dragAutoScroll prop. */
export declare const DRAG_AUTO_SCROLL_DEFAULTS: DragAutoScrollOptions;
/**
 * Signed per-frame scroll delta along one axis for a pointer at `client`
 * over a container spanning [start, start + size]. Negative scrolls up/left,
 * positive scrolls down/right, 0 keeps the position. Speed ramps linearly
 * from 1 to `speed` as the pointer approaches the container edge; a tiny
 * container halves the zone so the two edges never swallow the middle.
 * @param client - the pointer coordinate on this axis (clientX/clientY).
 * @param start - the container's leading edge on this axis.
 * @param size - the container's extent on this axis.
 * @param threshold - the edge zone width that arms auto-scroll.
 * @param speed - the maximum pixels per frame at the very edge.
 * @returns the signed per-frame delta to add to scrollTop/scrollLeft.
 */
export declare function autoScrollDelta(client: number, start: number, size: number, threshold: number, speed: number): number;
/** One card's vertical span, in viewport coordinates, for slot resolution. */
export interface CardSpan {
    top: number;
    bottom: number;
}
/**
 * The card-list slot a pointer at `clientY` lands in: the index of the
 * first card whose vertical midpoint sits below the pointer, else the end of
 * the list. Cards are assumed ordered top-to-bottom as rendered, so the
 * result is the insertion index (0..spans.length).
 * @param clientY - the pointer's vertical coordinate.
 * @param spans - each card's vertical span, in render order.
 * @returns the index to insert before; spans.length appends at the end.
 */
export declare function insertionIndexAt(clientY: number, spans: readonly CardSpan[]): number;
/**
 * Resolve a drop target's beforeTicketId into a card-list slot: the index of
 * the card to insert before, or ids.length to append at the end.
 * @param ticketIds - the column's ticket ids in render order.
 * @param beforeTicketId - the ticket to insert before, or null to append.
 * @returns the insertion slot in [0, ticketIds.length].
 */
export declare function insertionSlot(ticketIds: readonly string[], beforeTicketId: string | null): number;
//# sourceMappingURL=dragScroll.d.ts.map