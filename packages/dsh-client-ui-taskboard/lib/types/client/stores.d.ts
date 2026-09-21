/**
 * The taskboard tab's viewing store: which card's detail panel is open.
 * Module level exports the factory only (a module-level handle would pin the
 * store identity across plugin reloads); register() receives the factory and
 * the component derives its PropsStore share from the return type.
 */
import { type EngineStoreHandle } from '@deepseek-ai/dsh-client-store';
/** Tab-local viewing state. */
type TaskboardViewState = {
    /** Ticket id whose detail panel is open; null shows none. */
    selectedId: string | null;
};
/** Annotation twin of the actions literal below. */
type TaskboardViewActions = {
    select: (draft: TaskboardViewState, id: string | null) => void;
};
/**
 * Create the taskboard viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export declare function createTaskboardStore(): EngineStoreHandle<TaskboardViewState, TaskboardViewActions>;
export {};
//# sourceMappingURL=stores.d.ts.map