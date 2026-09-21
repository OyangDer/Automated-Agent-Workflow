import type { CreateTicketRequest, TicketView } from '@deepseek-ai/dsh-taskboard/client';
import type { TaskboardT } from './TicketCard.tsx';
export interface NewTicketFormProps {
    board: TicketView[];
    t: TaskboardT;
    onSubmit: (request: CreateTicketRequest) => Promise<void>;
    onCancel: () => void;
}
export declare function NewTicketForm({ board, t, onSubmit, onCancel }: NewTicketFormProps): import("react").JSX.Element;
//# sourceMappingURL=NewTicketForm.d.ts.map