/**
 * The taskboard tab's business face: the injected verbs, the board snapshot
 * source, and the derived component prop aliases. Everything is plain data
 * and callbacks over the JSON wire vocabulary.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BoardSnapshot, CreateTicketRequest, EditTicketRequest, MoveTicketRequest,
  RemoveTicketRequest, RemoveTicketResult, RequestReviewRequest, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'

/** The browser actions one TaskboardView surface may take. */
export interface TaskboardInjected {
  create(request: CreateTicketRequest): Promise<TicketView>
  move(request: MoveTicketRequest): Promise<TicketView>
  edit(request: EditTicketRequest): Promise<TicketView>
  remove(request: RemoveTicketRequest): Promise<RemoveTicketResult>
  requestReview(request: RequestReviewRequest): Promise<TicketView>
  /** Force a snapshot refresh (errors surface in the panel, not here). */
  refresh(): void
  /** Live board snapshot source; the renderer binds it into useBoard. */
  hooks: { board: HostObservable<BoardSnapshot | null> }
}
