import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { TicketView } from '@deepseek-ai/dsh-taskboard/client';
/** The bound taskboard translator, shared by the tab's child components. */
export type TaskboardT = PropsLocale<'taskboard'>['t'];
export interface TicketCardProps {
    ticket: TicketView;
    selected: boolean;
    dragging: boolean;
    t: TaskboardT;
    onSelect: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
}
export declare function TicketCard({ ticket, selected, dragging, t, onSelect, onDragStart, onDragEnd, }: TicketCardProps): import("react").JSX.Element;
//# sourceMappingURL=TicketCard.d.ts.map