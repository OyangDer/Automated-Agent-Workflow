/**
 * The V6-1 fixed-headcount roster: pure helpers for member identity, fixed
 * pairing, module matching and short work summaries. Nothing here touches
 * storage or the agent seams — the service owns persistence and dispatch, this
 * module owns the deterministic vocabulary so the same rules are used by the
 * dispatch matcher, the wire view and the tests.
 *
 * The design contract (user-decided): a member is NOT a session. The member
 * keeps its number, its module履历 and its short summary across session
 * rotation, and the roster headcount never grows past the configured cap —
 * a lost session is woken first and, when that fails, the card is parked as
 * 待处理 instead of silently adding a member.
 * @module @deepseek-ai/dsh-taskboard/src/roster
 */

import type { MemberRecord, MemberRole, TicketView } from './types.ts'

/** Hard cap on one member's stored work summary (characters). */
export const MEMBER_SUMMARY_LIMIT = 200
/** How many module keywords one member remembers. */
export const MEMBER_MODULE_LIMIT = 12
/** How many recently finished cards one member remembers. */
export const MEMBER_RECENT_TICKET_LIMIT = 5
/** How many module keywords the rendered summary names. */
const SUMMARY_MODULE_SHOWN = 4

/**
 * The worker member id of one pair index (0-based): "W1", "W2", ...
 * @param index - the 0-based pair index.
 * @returns the worker member id, e.g. "W1".
 */
export function workerMemberId(index: number): string {
  return 'W' + String(index + 1)
}

/**
 * The reviewer member id of one pair index (0-based): "R1", "R2", ...
 * @param index - the 0-based pair index.
 * @returns the reviewer member id, e.g. "R1".
 */
export function reviewerMemberId(index: number): string {
  return 'R' + String(index + 1)
}

/**
 * The pair index encoded in one member id; 0 when the id carries none.
 * @param id - the member id, e.g. "W2".
 * @returns the 0-based pair index.
 */
export function memberIndex(id: string): number {
  const match = /^[WR](\d+)$/.exec(id)
  if (match === null) return 0
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed - 1 : 0
}

/**
 * The fixed partner of one member id: W<n> pairs with R<n> and vice versa.
 * The pairing is structural (same index), so it can never drift.
 * @param id - the member id.
 * @returns the partner member id.
 */
export function partnerMemberId(id: string): string {
  const index = memberIndex(id)
  return id.startsWith('R') ? workerMemberId(index) : reviewerMemberId(index)
}

/**
 * The display tag of one member: "W1 (worker)" / "R2 (reviewer)".
 * @param id - the member id.
 * @returns the display tag.
 */
export function memberTag(id: string): string {
  return id + (id.startsWith('R') ? ' (reviewer)' : ' (worker)')
}

/**
 * Harvest the module keywords of one declared filesScope: lower-cased path
 * segments (drop-dirs/drive letters/empties). Deliberately dumb — the first
 * version matches paths by keyword overlap instead of any scoring model.
 * @param filesScope - the card's declared scope ('' when undeclared).
 * @returns the distinct keyword list, in first-seen order.
 */
export function moduleKeywords(filesScope: string): string[] {
  const keywords: string[] = []
  const seen = new Set<string>()
  for (const entry of filesScope.split(/[;,\n]+/)) {
    const normalized = entry.trim().replace(/\\/g, '/')
    if (normalized === '') continue
    for (const segment of normalized.split('/')) {
      const slug = segment.trim().toLowerCase()
      if (slug === '' || slug === '.' || slug === '..' || slug === '~') continue
      // A drive letter ("c:") names no module.
      if (/^[a-z]:$/.test(slug)) continue
      if (seen.has(slug)) continue
      seen.add(slug)
      keywords.push(slug)
    }
  }
  return keywords
}

/**
 * How many of a card's module keywords the member already knows. This is the
 * whole "context matching" of the first version (user decision A): path /
 * keyword overlap, no vectors, no model calls.
 * @param modules - the member's known keywords.
 * @param filesScope - the candidate card's declared scope.
 * @returns the overlap count (0 when nothing matches).
 */
export function moduleOverlap(modules: readonly string[], filesScope: string): number {
  if (modules.length === 0 || filesScope.trim() === '') return 0
  const known = new Set(modules)
  let score = 0
  for (const keyword of moduleKeywords(filesScope)) if (known.has(keyword)) score += 1
  return score
}

/** Truncate one summary at the limit on a character boundary. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/**
 * Fold one finished card into a member's module履历: the card's scope keywords
 * are added (most recent first, capped) and the card id joins the recent list.
 * @param member - the member record being updated.
 * @param ticket - the card the member just worked on.
 * @param now - the update timestamp.
 * @returns the updated record (summary is refreshed by {@link renderMemberSummary}).
 */
export function foldMemberHistory(member: MemberRecord, ticket: TicketView, now: number): MemberRecord {
  const harvested = moduleKeywords(ticket.filesScope)
  const modules: string[] = []
  for (const keyword of harvested) {
    if (!modules.includes(keyword)) modules.push(keyword)
  }
  for (const keyword of member.modules) {
    if (modules.length >= MEMBER_MODULE_LIMIT) break
    if (!modules.includes(keyword)) modules.push(keyword)
  }
  const recentTickets = [ticket.id, ...member.recentTickets.filter(id => id !== ticket.id)]
    .slice(0, MEMBER_RECENT_TICKET_LIMIT)
  return {
    ...member,
    modules: modules.slice(0, MEMBER_MODULE_LIMIT),
    recentTickets,
    updatedAt: now,
  }
}

/**
 * Render one member's short work summary — the single thing the master reads
 * when matching (the master never reads a member's full context). Kept short
 * and concrete: familiar modules, the last finished card, current load.
 * @param modules - the member's known module keywords.
 * @param recentTitles - titles (or ids) of recently finished cards, newest first.
 * @param currentTicket - the card the member holds now, or null when idle.
 * @returns the summary text, at most {@link MEMBER_SUMMARY_LIMIT} characters.
 */
export function renderMemberSummary(
  modules: readonly string[],
  recentTitles: readonly string[],
  currentTicket: string | null,
): string {
  const known = modules.slice(0, SUMMARY_MODULE_SHOWN)
  const bits = [
    known.length === 0 ? '暂无模块履历' : '熟悉 ' + known.join('、'),
    recentTitles.length === 0 ? '尚无完成记录' : '刚完成 ' + recentTitles.join('、'),
    currentTicket === null ? '目前空闲' : '正在处理 ' + currentTicket,
  ]
  return truncate(bits.join('；'), MEMBER_SUMMARY_LIMIT)
}

/**
 * Resolve the roster matching order for one card (user decision A): a card the
 * member already owns on a rework always wins (同一张卡的返修 → 原人); then the
 * member familiar with the card's modules (相关模块 → 熟悉的人); finally the
 * least-loaded member — with ties broken by roster index so the choice is
 * deterministic and every member is used before any member takes a second
 * card (first-come-first-served, no starvation).
 * @param candidates - the idle members that could take the card.
 * @param ticket - the card being matched.
 * @param ownerMemberId - the member that already owns this card, when any.
 * @returns the chosen member, or null when no candidate fits.
 */
export function matchMember(
  candidates: readonly MemberRecord[],
  ticket: TicketView,
  ownerMemberId: string | undefined,
): MemberRecord | null {
  if (candidates.length === 0) return null
  const ordered = [...candidates].sort((a, b) => memberIndex(a.id) - memberIndex(b.id))
  if (ownerMemberId !== undefined) {
    const owner = ordered.find(member => member.id === ownerMemberId)
    if (owner !== undefined) return owner
  }
  const [first, ...rest] = ordered
  if (first === undefined) return null
  let best = first
  let bestScore = moduleOverlap(best.modules, ticket.filesScope)
  for (const candidate of rest) {
    const score = moduleOverlap(candidate.modules, ticket.filesScope)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * The readable queue reason one waiting card carries. Names the busy members
 * and the cap so the wait is never a mystery (the V3-30 gate was deleted for
 * exactly this reason: an unexplained stall).
 * @param role - which roster ran out ("worker" | "reviewer").
 * @param capacity - the configured headcount cap for that role.
 * @param busy - the members currently holding another card, "W1=tk-1" style.
 * @param position - the card's 1-based FIFO position.
 * @returns the reason text.
 */
export function queueReason(role: MemberRole, capacity: number, busy: readonly string[], position: number): string {
  const held = busy.length === 0 ? '（无）' : busy.join('、')
  return '等待空闲 ' + role + '：编制上限 ' + String(capacity) + ' 已满且全部在忙（' + held
    + '）；按先来先服务排队，当前第 ' + String(position) + ' 位'
}
