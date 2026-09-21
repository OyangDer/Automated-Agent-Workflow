import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { TaskboardInjected } from './contract.ts';
import { type DragAutoScrollOptions } from './dragScroll.ts';
import { createTaskboardStore } from './stores.ts';
export type TaskboardViewProps = ConvViewProps & InjectFace<TaskboardInjected> & PropsLocale<'taskboard'> & PropsStore<ReturnType<typeof createTaskboardStore>> & {
    /** Edge auto-scroll tuning while a card drag is active (optional). */
    dragAutoScroll?: Partial<DragAutoScrollOptions>;
};
export declare function TaskboardView({ useBoard, useStore, actions, create, move, edit, remove, requestReview, selectBoard, createBoard, archiveBoard, t, dragAutoScroll, }: TaskboardViewProps): import("react").JSX.Element;
//# sourceMappingURL=TaskboardView.d.ts.map