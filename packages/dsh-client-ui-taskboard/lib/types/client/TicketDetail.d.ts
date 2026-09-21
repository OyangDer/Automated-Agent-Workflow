import type { ColumnId, EditTicketRequest, RemoveTicketRequest, RemoveTicketResult, RequestReviewRequest, TicketView } from '@deepseek-ai/dsh-taskboard/client';
import type { TaskboardT } from './TicketCard.tsx';
export interface TicketDetailProps {
    ticket: TicketView;
    /** All board tickets, for the dependsOn picker. */
    board: TicketView[];
    t: TaskboardT;
    onClose: () => void;
    onEdit: (request: EditTicketRequest) => Promise<TicketView>;
    onRemove: (request: RemoveTicketRequest) => Promise<RemoveTicketResult>;
    onRequestReview: (request: RequestReviewRequest) => Promise<TicketView>;
    onMove: (column: ColumnId) => void;
    onError: (message: string) => void;
}
export declare function TicketDetail({ ticket, board, t, onClose, onEdit, onRemove, onRequestReview, onMove, onError, }: TicketDetailProps): import("react").JSX.Element;
//# sourceMappingURL=TicketDetail.d.ts.map