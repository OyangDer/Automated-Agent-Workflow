/**
 * Role context capsules (V3-19): the minimal, accurate, current context
 * package each role (worker / reviewer) receives for one ticket. The
 * compiler is a pure function of the current board state (the ticket) plus
 * the dispatch-time git facts (the [B] preflight report) — it never caches
 * and never appends to a previous prompt, so every dispatch, redispatch and
 * retry recompiles a fresh capsule from current facts. The card description
 * is decomposed into capsule fields (goal, acceptance, constraints)
 * VERBATIM — no LLM summary ever replaces the original text — and everything
 * not mapped to a field lands once in the additional-details field, so the
 * description content appears exactly once in the prompt. The reviewer
 * capsule carries the worker's compact claims (from devNotes) as CLAIMS to
 * verify, never as facts.
 * @module @deepseek-ai/dsh-taskboard
 */

import type { PreflightReport } from './types.ts'

/** One marker-delimited section of a card description. */
export interface CardSection {
  /** The marker line, e.g. "【目标】"; null for text before the first marker. */
  marker: string | null
  /** The marker title without brackets, e.g. "目标". */
  title: string
  /** The section body verbatim (trimmed) — the text after the marker line. */
  body: string
  /** The whole section verbatim (trimmed) — the marker plus its body in the
   * original layout; equals {@link body} for a preamble section. */
  text: string
}

/**
 * Decompose a card description into its 【...】-delimited sections. Text
 * before the first marker is one preamble section (marker null); when the
 * description has no markers at all, the whole trimmed description is a
 * single preamble section. Empty sections are dropped.
 * @param description - the raw card description.
 * @returns the parsed sections in original order.
 */
export function parseSections(description: string): CardSection[] {
  const sections: CardSection[] = []
  const markerPattern = /【([^】]+)】/g
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null
  while ((match = markerPattern.exec(description)) !== null) matches.push(match)
  if (matches.length === 0) {
    const trimmed = description.trim()
    if (trimmed !== '') sections.push({ marker: null, title: '', body: trimmed, text: trimmed })
    return sections
  }
  const first = matches[0]
  if (first !== undefined) {
    const preamble = description.slice(0, first.index).trim()
    if (preamble !== '') sections.push({ marker: null, title: '', body: preamble, text: preamble })
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]
    if (current === undefined) continue
    const next = matches[index + 1]
    const end = next === undefined ? description.length : next.index
    const text = description.slice(current.index, end).trim()
    if (text === '') continue
    const title = current[1]
    if (title === undefined) continue
    const body = text.slice(current[0].length).trim()
    sections.push({ marker: current[0], title, body, text })
  }
  return sections
}

/** The dispatch-time git facts the worker capsule carries (from the [B]
 * preflight report when computed; available=false otherwise). */
export interface WorkerGitFacts {
  /** Whether the facts were computed at dispatch time (preflight report). */
  available: boolean
  /** The git top-level of the repo ('' when unavailable). */
  repoRoot: string
  /** The authoritative baseline: branch + commit. */
  canonicalBase: { branch: string; commit: string }
  /** The worktree assigned to this dispatch (absolute path). */
  assignedWorktree: string
  /** The branch actually checked out. */
  actualBranch: string
  /** The HEAD commit actually checked out. */
  head: string
  /** Uncommitted changes as porcelain entries (untracked included). */
  dirtyFiles: string[]
  /** HEAD-vs-canonical-base relationship ('equal' | 'ahead' | ...). */
  relationship: string
}

/** The worker capsule: exactly the fields the worker role needs, nothing more. */
export interface WorkerCapsule {
  ticketId: string
  title: string
  /** The task goal, extracted verbatim from the 【目标】 section ('' when absent). */
  goal: string
  /** The acceptance criteria, extracted verbatim from the 【验收】 section ('' when absent). */
  acceptance: string
  /** The dispatch-time git facts (canonical base, worktree, branch/HEAD, dirty state). */
  gitFacts: WorkerGitFacts
  /** The card's declared file scope (verbatim). */
  filesScope: string
  /** Recovery/hard constraints, extracted verbatim from the 【纪律】/【硬约束】 sections ('' when absent). */
  constraints: string
  /** Description content not mapped to a capsule field, verbatim ('' when absent). */
  additionalDetails: string
}

/**
 * Compile the worker capsule for one ticket from the current board state and
 * the dispatch-time preflight facts. Pure: same inputs always yield the same
 * capsule, and the caller gets a fresh capsule on every dispatch/redispatch —
 * retry never carries a previous prompt's appendix.
 * @param ticket - the card (id/title/description/filesScope).
 * @param preflight - the [B] dispatch-time preflight report, when computed.
 * @returns the compiled worker capsule.
 */
export function compileWorkerCapsule(
  ticket: { id: string; title: string; description: string; filesScope: string },
  preflight?: PreflightReport | null,
): WorkerCapsule {
  const sections = parseSections(ticket.description)
  let goal = ''
  let acceptance = ''
  const constraints: string[] = []
  const additional: string[] = []
  for (const section of sections) {
    const text = section.text
    if (section.marker === null) {
      additional.push(text)
    } else if (section.title === '目标') {
      goal = text
    } else if (section.title === '验收') {
      acceptance = text
    } else if (section.title === '硬约束' || section.title === '纪律') {
      constraints.push(text)
    } else {
      additional.push(text)
    }
  }
  const gitFacts: WorkerGitFacts = preflight === null || preflight === undefined
    ? {
      available: false, repoRoot: '', canonicalBase: { branch: '', commit: '' },
      assignedWorktree: '', actualBranch: '', head: '', dirtyFiles: [], relationship: '',
    }
    : {
      available: true,
      repoRoot: preflight.repoRoot,
      canonicalBase: { branch: preflight.canonicalBase.branch, commit: preflight.canonicalBase.commit },
      assignedWorktree: preflight.assignedWorktree,
      actualBranch: preflight.actualBranch,
      head: preflight.head,
      dirtyFiles: preflight.dirtyFiles,
      relationship: preflight.baseCandidateRelationship,
    }
  return {
    ticketId: ticket.id,
    title: ticket.title,
    goal,
    acceptance,
    gitFacts,
    filesScope: ticket.filesScope,
    constraints: constraints.join('\n\n'),
    additionalDetails: additional.join('\n\n'),
  }
}

/** Indent every line of a value by two spaces (empty values stay empty). */
function indent(value: string): string {
  if (value === '') return ''
  return value.split('\n').map(line => '  ' + line).join('\n')
}

/** The built-in output-discipline constraint that rides every role capsule
 * (V3-24): oversized tool output is the dominant avoidable cost of a
 * dispatched run, because every printed byte stays in the context and is
 * re-sent on every later turn. Shared verbatim by both role capsules. */
const RUNTIME_OUTPUT_DISCIPLINE = '  - Keep tool output small: cap long output at the shell (bash: `tail -n 120`; PowerShell: `Select-Object -Last 120`) and read only the lines you need (bash: `sed -n 10,25p`; PowerShell: `Select-Object -Skip 9 -First 16`) instead of printing a whole large file. Every byte you print stays in your context and is re-sent on every later turn, so oversized output is the main avoidable cost of this run.'

/** The built-in "one focused command" constraint, shared by both capsules. */
const RUNTIME_LOCATE_HINT = '  - Prefer one focused command over a broad repository sweep; locate the code with one targeted search before reading anything.'

/** The one-line "not extracted" placeholder for an absent section. */
const NO_GOAL = '(no 【目标】 section in the card description)'
const NO_ACCEPTANCE = '(no 【验收】 section in the card description)'
const NO_CONSTRAINTS = '(no 【纪律】 or 【硬约束】 section in the card description)'
const NO_DETAILS = '(none)'

/**
 * Render the worker capsule as the model-visible markdown block. The git
 * facts field carries the preflight facts when computed; otherwise it names
 * the working directory and tells the worker to verify with git directly.
 * @param capsule - the compiled worker capsule.
 * @param cwd - the spawning session's working directory ('' when unknown).
 * @returns the capsule section text.
 */
export function renderWorkerCapsule(capsule: WorkerCapsule, cwd = ''): string {
  const lines: string[] = [
    '# Worker capsule (compiled from the current board state and git facts)',
    '',
    '- Ticket: ' + capsule.ticketId + ' ("' + capsule.title + '")',
    '',
    '- Goal (verbatim from the card):',
    indent(capsule.goal === '' ? NO_GOAL : capsule.goal),
    '',
    '- Acceptance criteria (verbatim from the card):',
    indent(capsule.acceptance === '' ? NO_ACCEPTANCE : capsule.acceptance),
    '',
  ]
  if (capsule.gitFacts.available) {
    const facts = capsule.gitFacts
    lines.push(
      '- Repository facts (dispatch-time preflight):',
      '  - canonical base: ' + facts.canonicalBase.branch + ' @ ' + facts.canonicalBase.commit,
      '  - assigned worktree: ' + facts.assignedWorktree,
      '  - actual branch: ' + facts.actualBranch,
      '  - HEAD: ' + facts.head,
      '  - dirty files: ' + (facts.dirtyFiles.length === 0 ? '(none)' : facts.dirtyFiles.join('; ')),
      '  - base/candidate relationship: ' + facts.relationship,
      '  - repo root: ' + facts.repoRoot,
      '',
    )
  } else {
    lines.push(
      '- Repository facts (preflight not computed at dispatch — verify with git status / git branch --show-current / git rev-parse HEAD before working):',
      '  - working directory: ' + (cwd === '' ? '(inherited from the spawning session)' : cwd),
      '',
    )
  }
  const scope = capsule.filesScope.trim() === '' ? '(not declared)' : capsule.filesScope
  // The dispatched shell is dialect-specific (pwsh on win32, bash on POSIX),
  // so both dialects are named rather than assuming POSIX utilities exist.
  const locationHint = capsule.gitFacts.available
    ? '  - Prefer one focused command over a broad repository sweep; the repository facts above already locate the code you need.'
    : '  - Prefer one focused command over a broad repository sweep; locate the code with one targeted search before reading anything.'
  lines.push(
    '- Declared file scope: ' + scope,
    '  The card declares which files/directories it affects; stay inside that scope and do not edit files outside it (other parallel workers may own them). An undeclared scope means you are responsible for reporting exactly which paths you touched in devNotes.',
    '',
    '- Runtime constraints (built-in, always apply):',
    RUNTIME_OUTPUT_DISCIPLINE,
    locationHint,
    '',
    '- Reporting contract (built-in, always apply):',
    "  - Make every claim checkable: give the command you ran plus the key output line it produced (devNotes labels 'Tests run:' and 'Key output line:'). The reviewer re-runs the command and compares exactly that line, so a claim without its key output line is unverifiable and is treated as missing.",
    '',
    '- Constraints (verbatim from the card):',
    indent(capsule.constraints === '' ? NO_CONSTRAINTS : capsule.constraints),
    '',
    '- Additional card details (verbatim):',
    indent(capsule.additionalDetails === '' ? NO_DETAILS : capsule.additionalDetails),
  )
  return lines.join('\n')
}

/** The worker's compact claims, structured from devNotes (V3-19). */
export interface WorkerClaims {
  /** Claimed root cause, when devNotes carries a labeled line ('' otherwise). */
  rootCause: string
  /** Claimed files changed, when labeled. */
  filesChanged: string
  /** Claimed tests run (the command), when labeled. */
  testsRun: string
  /** The key output line the claimed command produced (V3-24): the reviewer
   * re-runs the command and compares exactly this line. Empty = the claim
   * arrived without its key line and is treated as missing, never guessed. */
  keyOutputLine: string
  /** Claimed known anomaly / known issue, when labeled. */
  knownAnomaly: string
  /** The developer's notes verbatim — the compact claim source. */
  devNotes: string
}

const CLAIM_LABEL_NAMES = 'Root cause|Files changed|Tests run|Key output line|关键输出行|Known anomaly|Known issue|Anomaly'
const CLAIM_LABEL_PATTERN = new RegExp('^\\s*[-*]?\\s*(' + CLAIM_LABEL_NAMES + ')\\s*[:：]\\s*(.*)$', 'i')

/**
 * Structure the worker's compact claims from its devNotes: labeled lines
 * ("Root cause:", "Files changed:", "Tests run:", "Key output line:",
 * "Known anomaly:") fill their claim slots; the notes stay verbatim as the
 * claim source. Lines without a label are ignored by the extractor — the
 * notes field always carries the full text, so nothing is lost. An absent
 * "Key output line:" leaves the slot empty on purpose (V3-24): the reviewer
 * treats that claim as missing instead of inventing a line to compare.
 * @param devNotes - the developer's completion notes.
 * @returns the structured claims.
 */
export function parseWorkerClaims(devNotes: string): WorkerClaims {
  const claims: WorkerClaims = { rootCause: '', filesChanged: '', testsRun: '', keyOutputLine: '', knownAnomaly: '', devNotes }
  for (const line of devNotes.split(/\r?\n/)) {
    const match = CLAIM_LABEL_PATTERN.exec(line)
    if (match === null) continue
    const value = match[2] === undefined ? '' : match[2].trim()
    const label = match[1] === undefined ? '' : match[1].toLowerCase()
    if (label === 'root cause') claims.rootCause = value
    else if (label === 'files changed') claims.filesChanged = value
    else if (label === 'tests run') claims.testsRun = value
    else if (label === 'key output line' || label === '关键输出行') claims.keyOutputLine = value
    else claims.knownAnomaly = value
  }
  return claims
}

/** The review-time git facts the reviewer capsule carries (base/candidate
 * commits and the touched-file list; available=false when not computed). */
export interface ReviewerGitFacts {
  /** Whether the base/candidate/touched facts were computed at review time. */
  available: boolean
  /** The git top-level of the repo ('' when unavailable). */
  repoRoot: string
  /** The canonical base commit the candidate descends from. */
  baseCommit: string
  /** The candidate commit under review. */
  candidateCommit: string
  /** Files touched by the candidate diff (empty = the reviewer computes the diff). */
  touchedFiles: string[]
}

/**
 * Map a [B] dispatch-time preflight report onto the reviewer git facts: the
 * canonical base commit is the base, the reported HEAD is the candidate. The
 * touched-file list is not derivable from the preflight ('' — the reviewer
 * computes the diff itself).
 * @param report - the preflight report.
 * @returns the reviewer git facts.
 */
export function reviewerFactsFromPreflight(report: PreflightReport): ReviewerGitFacts {
  return {
    available: true,
    repoRoot: report.repoRoot,
    baseCommit: report.canonicalBase.commit,
    candidateCommit: report.head,
    touchedFiles: [],
  }
}

/** The reviewer verification depth (V3-24): 'standard' is the default and
 * 'deep' is opt-in from the card — the card's 【审核】 section must read
 * exactly "deep" to upgrade the reviewer. */
export type ReviewerDepth = 'standard' | 'deep'

/** The card section whose body switches the reviewer depth. */
const REVIEW_DEPTH_MARKER = '审核'

/**
 * Derive the reviewer verification depth from the card description (V3-24).
 * The default is 'standard': run the card's acceptance command once, derive
 * the change set from the workspace, check the scope, probe the named
 * boundary inputs — and read outside the change set only when a claim
 * conflicts with the evidence. The card upgrades the reviewer to 'deep' only
 * when its description carries a 【审核】 section whose body is exactly
 * "deep" (case-insensitive); any other 【审核】 body is ordinary card content
 * and leaves the default.
 * @param description - the raw card description.
 * @returns the reviewer depth.
 */
export function reviewerDepthFromDescription(description: string): ReviewerDepth {
  for (const section of parseSections(description)) {
    if (section.marker === null || section.title !== REVIEW_DEPTH_MARKER) continue
    if (section.body.trim().toLowerCase() === 'deep') return 'deep'
  }
  return 'standard'
}

/** The reviewer capsule: exactly the fields the reviewer role needs. */
export interface ReviewerCapsule {
  ticketId: string
  title: string
  /** The acceptance criteria, extracted verbatim from the 【验收】 section ('' when absent). */
  acceptance: string
  /** The verification depth (V3-24), derived from the card description. */
  depth: ReviewerDepth
  /** The card's declared file scope (verbatim). */
  filesScope: string
  /** The base/candidate commits and touched files under review. */
  git: ReviewerGitFacts
  /** The worker's compact claims (claims, never facts). */
  claims: WorkerClaims
  /** Description content not mapped to a capsule field, verbatim ('' when absent). */
  additionalDetails: string
}

/**
 * Compile the reviewer capsule for one ticket from the current board state.
 * The worker's devNotes are structured into compact claims — the worker's
 * long exploration process is never part of the capsule.
 * @param ticket - the card under review (id/title/description/filesScope/devNotes).
 * @param facts - the review-time git facts, when computed.
 * @returns the compiled reviewer capsule.
 */
export function compileReviewerCapsule(
  ticket: { id: string; title: string; description: string; filesScope: string; devNotes: string },
  facts?: ReviewerGitFacts | null,
): ReviewerCapsule {
  const sections = parseSections(ticket.description)
  let acceptance = ''
  const additional: string[] = []
  for (const section of sections) {
    const text = section.text
    if (section.marker !== null && section.title === '验收') {
      acceptance = text
    } else {
      additional.push(text)
    }
  }
  return {
    ticketId: ticket.id,
    title: ticket.title,
    acceptance,
    depth: reviewerDepthFromDescription(ticket.description),
    filesScope: ticket.filesScope,
    git: facts === null || facts === undefined
      ? { available: false, repoRoot: '', baseCommit: '', candidateCommit: '', touchedFiles: [] }
      : facts,
    claims: parseWorkerClaims(ticket.devNotes),
    additionalDetails: additional.join('\n\n'),
  }
}

/**
 * Render the reviewer capsule as the model-visible markdown block: the
 * acceptance criteria, base/candidate commits, declared scope, touched files,
 * the worker's compact claims, the built-in runtime output discipline, the
 * ≤10-step budget with its no-evidence-no-approval failure posture, and the
 * independent diff-first (not diff-only) verification path at the capsule's
 * depth — standard reads outside the change set only on a claim/evidence
 * conflict, deep may follow the acceptance call paths out of it.
 * @param capsule - the compiled reviewer capsule.
 * @returns the capsule section text.
 */
export function renderReviewerCapsule(capsule: ReviewerCapsule): string {
  const deep = capsule.depth === 'deep'
  const lines: string[] = [
    '# Reviewer capsule (compiled from the current board state)',
    '',
    '- Ticket: ' + capsule.ticketId + ' ("' + capsule.title + '")',
    '- Review depth: ' + (deep
      ? 'deep (the card\'s 【审核】 section reads "deep" — open-ended reading along the acceptance call paths is allowed)'
      : 'standard (default — the card does not mark 【审核】 as deep; read outside the change set only when a claim conflicts with the evidence you gathered)'),
    '',
    '- Acceptance criteria (verbatim from the card):',
    indent(capsule.acceptance === '' ? NO_ACCEPTANCE : capsule.acceptance),
    '',
    '- Base commit: ' + (capsule.git.available && capsule.git.baseCommit !== ''
      ? capsule.git.baseCommit
      : 'to be determined by the reviewer (compute the base from git status / git log)'),
    '- Candidate commit: ' + (capsule.git.available && capsule.git.candidateCommit !== ''
      ? capsule.git.candidateCommit
      : 'to be determined by the reviewer (the reviewed HEAD)'),
    '- Declared file scope: ' + (capsule.filesScope.trim() === '' ? '(not declared)' : capsule.filesScope),
    '- Touched files / diff:',
  ]
  if (capsule.git.available && capsule.git.touchedFiles.length > 0) {
    lines.push(...capsule.git.touchedFiles.map(file => '  - ' + file))
  } else {
    lines.push('  (to be determined — compute the diff between the base and candidate commits and list the files)')
  }
  const claims = capsule.claims
  lines.push(
    '',
    "- Worker's claims (compiled from devNotes — CLAIMS to verify independently, never facts):",
    '  - Root cause: ' + (claims.rootCause === '' ? '(not claimed)' : claims.rootCause),
    '  - Files changed: ' + (claims.filesChanged === '' ? '(not claimed)' : claims.filesChanged),
    '  - Tests run: ' + (claims.testsRun === '' ? '(not claimed)' : claims.testsRun),
    '  - Key output line: ' + (claims.keyOutputLine === ''
      ? '(missing — the claim arrived without the key output line it produced; treat it as missing, never guess or substitute a line of your own)'
      : claims.keyOutputLine),
    '  - Known anomaly: ' + (claims.knownAnomaly === '' ? '(not claimed)' : claims.knownAnomaly),
    '  - devNotes: ' + (claims.devNotes.trim() === '' ? '(none)' : claims.devNotes.trim()),
    '  Each claim must carry the command that was run plus the key output line it produced: re-run the command and compare exactly that line. A claim without its key output line is missing evidence — treat it as missing, never guess.',
    '',
    '- Additional card details (verbatim):',
    indent(capsule.additionalDetails === '' ? NO_DETAILS : capsule.additionalDetails),
    '',
    '- Runtime constraints (built-in, always apply):',
    RUNTIME_OUTPUT_DISCIPLINE,
    RUNTIME_LOCATE_HINT,
    '',
    '- Review budget and failure posture (default target ≤10 steps):',
    '  - Budget the review at ≤10 steps: one git diff / git status to derive the change set, each acceptance command run once, and stop as soon as every acceptance point has independent evidence.',
    '  - 若在预算内无法独立验证，就用具体阻塞点打回，绝不在缺乏证据时通过。',
    '  - If you cannot verify a point independently within that budget, reject with the concrete blocking point — never approve without evidence.',
  )
  const verification: string[] = [
    '',
    'Independent verification (diff-first, not diff-only) — depth: ' + capsule.depth + ':',
  ]
  let step = 1
  verification.push(
    String(step) + '. Derive the change set yourself from the workspace (git diff / git status against the base commit); the claimed file list is a claim, not the change set.',
  )
  step += 1
  verification.push(
    String(step) + '. Acceptance → diff: map every acceptance criterion onto the base/candidate diff — each acceptance point must be covered by a concrete change, or an explicit reason it needs none.',
  )
  step += 1
  verification.push(
    String(step) + (deep
      ? ". Run the acceptance-relevant commands and builds independently, with falsification probes on the boundary inputs the card names and on the failure paths those inputs imply; do not rely on the worker's word."
      : ". Run the card's acceptance command once (standard depth does not repeat runs) and add a small number of falsification probes on the boundary inputs the card names; do not rely on the worker's word."),
  )
  step += 1
  verification.push(
    String(step) + (deep
      ? '. Call paths: read the files on the acceptance-relevant call paths, including files beyond the changed set when they sit directly on such a path (diff-first does not forbid reading context).'
      : '. Call paths: read the files on the acceptance-relevant call paths; read files beyond the changed set only when a claim conflicts with the evidence you gathered (standard depth does not read outside the change set otherwise).'),
  )
  step += 1
  if (capsule.filesScope.trim() !== '') {
    verification.push(String(step) + '. Check the change stays inside the declared file scope: flag any edit outside "' + capsule.filesScope + '".')
    step += 1
  }
  verification.push(
    String(step) + ". Check the worker's claims (files changed, tests run, root cause) against the evidence you gathered — a claim is never a fact; re-run each claimed command and compare the claimed key output line, and when devNotes gives no key output line, treat that claim as missing rather than guessing.",
    String(step + 1) + '. Verdict: approve only when every acceptance point is independently verified; otherwise reject with concrete, actionable problems.',
  )
  lines.push(...verification)
  return lines.join('\n')
}
