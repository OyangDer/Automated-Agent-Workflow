import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { DomainError, defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawnSync } from "node:child_process";
//#region lib/types/types.js
/**
* Client-safe vocabulary of the taskboard domain: the five column ids, the
* wire snapshots the browser renders, the RPC request payloads, and the one
* forwarded host event. Pure data module — the browser imports this outlet
* (directly or through the `./client` re-export) without dragging host
* services into the client program, and the forwarded-event allowlist reads
* the `taskboard/changed` declaration from here.
* @module @deepseek-ai/dsh-taskboard
*/
/** The five workflow columns in canonical left-to-right order. */
const TASKBOARD_COLUMNS = [
	"backlog",
	"not_started",
	"in_progress",
	"in_testing",
	"done"
];
/** The three ticket priority levels. */
const TASKBOARD_PRIORITIES = [
	"low",
	"normal",
	"high"
];
/** The ticket kind vocabulary, shown as a badge on the card. */
const TASKBOARD_TYPES = [
	"feature",
	"bugfix",
	"refactor",
	"docs",
	"test",
	"merge",
	"infra",
	"chore",
	"spike"
];
/** The worker lifecycle of one card (v2 dispatch protocol). */
const TASKBOARD_WORKER_STATUSES = [
	"ready",
	"claimed",
	"running",
	"blocked",
	"paused"
];
//#endregion
//#region lib/types/capsule.js
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
/**
* Decompose a card description into its 【...】-delimited sections. Text
* before the first marker is one preamble section (marker null); when the
* description has no markers at all, the whole trimmed description is a
* single preamble section. Empty sections are dropped.
* @param description - the raw card description.
* @returns the parsed sections in original order.
*/
function parseSections(description) {
	const sections = [];
	const markerPattern = /【([^】]+)】/g;
	const matches = [];
	let match;
	while ((match = markerPattern.exec(description)) !== null) matches.push(match);
	if (matches.length === 0) {
		const trimmed = description.trim();
		if (trimmed !== "") sections.push({
			marker: null,
			title: "",
			body: trimmed,
			text: trimmed
		});
		return sections;
	}
	const first = matches[0];
	if (first !== void 0) {
		const preamble = description.slice(0, first.index).trim();
		if (preamble !== "") sections.push({
			marker: null,
			title: "",
			body: preamble,
			text: preamble
		});
	}
	for (let index = 0; index < matches.length; index += 1) {
		const current = matches[index];
		if (current === void 0) continue;
		const next = matches[index + 1];
		const end = next === void 0 ? description.length : next.index;
		const text = description.slice(current.index, end).trim();
		if (text === "") continue;
		const title = current[1];
		if (title === void 0) continue;
		const body = text.slice(current[0].length).trim();
		sections.push({
			marker: current[0],
			title,
			body,
			text
		});
	}
	return sections;
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
function compileWorkerCapsule(ticket, preflight) {
	const sections = parseSections(ticket.description);
	let goal = "";
	let acceptance = "";
	const constraints = [];
	const additional = [];
	for (const section of sections) {
		const text = section.text;
		if (section.marker === null) additional.push(text);
		else if (section.title === "目标") goal = text;
		else if (section.title === "验收") acceptance = text;
		else if (section.title === "硬约束" || section.title === "纪律") constraints.push(text);
		else additional.push(text);
	}
	const gitFacts = preflight === null || preflight === void 0 ? {
		available: false,
		repoRoot: "",
		canonicalBase: {
			branch: "",
			commit: ""
		},
		assignedWorktree: "",
		actualBranch: "",
		head: "",
		dirtyFiles: [],
		relationship: ""
	} : {
		available: true,
		repoRoot: preflight.repoRoot,
		canonicalBase: {
			branch: preflight.canonicalBase.branch,
			commit: preflight.canonicalBase.commit
		},
		assignedWorktree: preflight.assignedWorktree,
		actualBranch: preflight.actualBranch,
		head: preflight.head,
		dirtyFiles: preflight.dirtyFiles,
		relationship: preflight.baseCandidateRelationship
	};
	return {
		ticketId: ticket.id,
		title: ticket.title,
		goal,
		acceptance,
		gitFacts,
		filesScope: ticket.filesScope,
		constraints: constraints.join("\n\n"),
		additionalDetails: additional.join("\n\n")
	};
}
/** Indent every line of a value by two spaces (empty values stay empty). */
function indent(value) {
	if (value === "") return "";
	return value.split("\n").map((line) => "  " + line).join("\n");
}
/** The built-in output-discipline constraint that rides every role capsule
* (V3-24): oversized tool output is the dominant avoidable cost of a
* dispatched run, because every printed byte stays in the context and is
* re-sent on every later turn. Shared verbatim by both role capsules. */
const RUNTIME_OUTPUT_DISCIPLINE = "  - Keep tool output small: cap long output at the shell (bash: `tail -n 120`; PowerShell: `Select-Object -Last 120`) and read only the lines you need (bash: `sed -n 10,25p`; PowerShell: `Select-Object -Skip 9 -First 16`) instead of printing a whole large file. Every byte you print stays in your context and is re-sent on every later turn, so oversized output is the main avoidable cost of this run.";
/** The built-in "one focused command" constraint, shared by both capsules. */
const RUNTIME_LOCATE_HINT = "  - Prefer one focused command over a broad repository sweep; locate the code with one targeted search before reading anything.";
/** The one-line "not extracted" placeholder for an absent section. */
const NO_GOAL = "(no 【目标】 section in the card description)";
const NO_ACCEPTANCE = "(no 【验收】 section in the card description)";
const NO_CONSTRAINTS = "(no 【纪律】 or 【硬约束】 section in the card description)";
const NO_DETAILS = "(none)";
/**
* Render the worker capsule as the model-visible markdown block. The git
* facts field carries the preflight facts when computed; otherwise it names
* the working directory and tells the worker to verify with git directly.
* @param capsule - the compiled worker capsule.
* @param cwd - the spawning session's working directory ('' when unknown).
* @returns the capsule section text.
*/
function renderWorkerCapsule(capsule, cwd = "") {
	const lines = [
		"# Worker capsule (compiled from the current board state and git facts)",
		"",
		"- Ticket: " + capsule.ticketId + " (\"" + capsule.title + "\")",
		"",
		"- Goal (verbatim from the card):",
		indent(capsule.goal === "" ? NO_GOAL : capsule.goal),
		"",
		"- Acceptance criteria (verbatim from the card):",
		indent(capsule.acceptance === "" ? NO_ACCEPTANCE : capsule.acceptance),
		""
	];
	if (capsule.gitFacts.available) {
		const facts = capsule.gitFacts;
		lines.push("- Repository facts (dispatch-time preflight):", "  - canonical base: " + facts.canonicalBase.branch + " @ " + facts.canonicalBase.commit, "  - assigned worktree: " + facts.assignedWorktree, "  - actual branch: " + facts.actualBranch, "  - HEAD: " + facts.head, "  - dirty files: " + (facts.dirtyFiles.length === 0 ? "(none)" : facts.dirtyFiles.join("; ")), "  - base/candidate relationship: " + facts.relationship, "  - repo root: " + facts.repoRoot, "");
	} else lines.push("- Repository facts (preflight not computed at dispatch — verify with git status / git branch --show-current / git rev-parse HEAD before working):", "  - working directory: " + (cwd === "" ? "(inherited from the spawning session)" : cwd), "");
	const scope = capsule.filesScope.trim() === "" ? "(not declared)" : capsule.filesScope;
	const locationHint = capsule.gitFacts.available ? "  - Prefer one focused command over a broad repository sweep; the repository facts above already locate the code you need." : "  - Prefer one focused command over a broad repository sweep; locate the code with one targeted search before reading anything.";
	lines.push("- Declared file scope: " + scope, "  The card declares which files/directories it affects; stay inside that scope and do not edit files outside it (other parallel workers may own them). An undeclared scope means you are responsible for reporting exactly which paths you touched in devNotes.", "", "- Runtime constraints (built-in, always apply):", RUNTIME_OUTPUT_DISCIPLINE, locationHint, "", "- Reporting contract (built-in, always apply):", "  - Make every claim checkable: give the command you ran plus the key output line it produced (devNotes labels 'Tests run:' and 'Key output line:'). The reviewer re-runs the command and compares exactly that line, so a claim without its key output line is unverifiable and is treated as missing.", "", "- Constraints (verbatim from the card):", indent(capsule.constraints === "" ? NO_CONSTRAINTS : capsule.constraints), "", "- Additional card details (verbatim):", indent(capsule.additionalDetails === "" ? NO_DETAILS : capsule.additionalDetails));
	return lines.join("\n");
}
const CLAIM_LABEL_PATTERN = /* @__PURE__ */ new RegExp("^\\s*[-*]?\\s*(Root cause|Files changed|Tests run|Key output line|关键输出行|Known anomaly|Known issue|Anomaly)\\s*[:：]\\s*(.*)$", "i");
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
function parseWorkerClaims(devNotes) {
	const claims = {
		rootCause: "",
		filesChanged: "",
		testsRun: "",
		keyOutputLine: "",
		knownAnomaly: "",
		devNotes
	};
	for (const line of devNotes.split(/\r?\n/)) {
		const match = CLAIM_LABEL_PATTERN.exec(line);
		if (match === null) continue;
		const value = match[2] === void 0 ? "" : match[2].trim();
		const label = match[1] === void 0 ? "" : match[1].toLowerCase();
		if (label === "root cause") claims.rootCause = value;
		else if (label === "files changed") claims.filesChanged = value;
		else if (label === "tests run") claims.testsRun = value;
		else if (label === "key output line" || label === "关键输出行") claims.keyOutputLine = value;
		else claims.knownAnomaly = value;
	}
	return claims;
}
/** The card section whose body switches the reviewer depth. */
const REVIEW_DEPTH_MARKER = "审核";
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
function reviewerDepthFromDescription(description) {
	for (const section of parseSections(description)) {
		if (section.marker === null || section.title !== REVIEW_DEPTH_MARKER) continue;
		if (section.body.trim().toLowerCase() === "deep") return "deep";
	}
	return "standard";
}
/**
* Compile the reviewer capsule for one ticket from the current board state.
* The worker's devNotes are structured into compact claims — the worker's
* long exploration process is never part of the capsule.
* @param ticket - the card under review (id/title/description/filesScope/devNotes).
* @param facts - the review-time git facts, when computed.
* @returns the compiled reviewer capsule.
*/
function compileReviewerCapsule(ticket, facts) {
	const sections = parseSections(ticket.description);
	let acceptance = "";
	const additional = [];
	for (const section of sections) {
		const text = section.text;
		if (section.marker !== null && section.title === "验收") acceptance = text;
		else additional.push(text);
	}
	return {
		ticketId: ticket.id,
		title: ticket.title,
		acceptance,
		depth: reviewerDepthFromDescription(ticket.description),
		filesScope: ticket.filesScope,
		git: facts === null || facts === void 0 ? {
			available: false,
			repoRoot: "",
			baseCommit: "",
			candidateCommit: "",
			touchedFiles: []
		} : facts,
		claims: parseWorkerClaims(ticket.devNotes),
		additionalDetails: additional.join("\n\n")
	};
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
function renderReviewerCapsule(capsule) {
	const deep = capsule.depth === "deep";
	const lines = [
		"# Reviewer capsule (compiled from the current board state)",
		"",
		"- Ticket: " + capsule.ticketId + " (\"" + capsule.title + "\")",
		"- Review depth: " + (deep ? "deep (the card's 【审核】 section reads \"deep\" — open-ended reading along the acceptance call paths is allowed)" : "standard (default — the card does not mark 【审核】 as deep; read outside the change set only when a claim conflicts with the evidence you gathered)"),
		"",
		"- Acceptance criteria (verbatim from the card):",
		indent(capsule.acceptance === "" ? NO_ACCEPTANCE : capsule.acceptance),
		"",
		"- Base commit: " + (capsule.git.available && capsule.git.baseCommit !== "" ? capsule.git.baseCommit : "to be determined by the reviewer (compute the base from git status / git log)"),
		"- Candidate commit: " + (capsule.git.available && capsule.git.candidateCommit !== "" ? capsule.git.candidateCommit : "to be determined by the reviewer (the reviewed HEAD)"),
		"- Declared file scope: " + (capsule.filesScope.trim() === "" ? "(not declared)" : capsule.filesScope),
		"- Touched files / diff:"
	];
	if (capsule.git.available && capsule.git.touchedFiles.length > 0) lines.push(...capsule.git.touchedFiles.map((file) => "  - " + file));
	else lines.push("  (to be determined — compute the diff between the base and candidate commits and list the files)");
	const claims = capsule.claims;
	lines.push("", "- Worker's claims (compiled from devNotes — CLAIMS to verify independently, never facts):", "  - Root cause: " + (claims.rootCause === "" ? "(not claimed)" : claims.rootCause), "  - Files changed: " + (claims.filesChanged === "" ? "(not claimed)" : claims.filesChanged), "  - Tests run: " + (claims.testsRun === "" ? "(not claimed)" : claims.testsRun), "  - Key output line: " + (claims.keyOutputLine === "" ? "(missing — the claim arrived without the key output line it produced; treat it as missing, never guess or substitute a line of your own)" : claims.keyOutputLine), "  - Known anomaly: " + (claims.knownAnomaly === "" ? "(not claimed)" : claims.knownAnomaly), "  - devNotes: " + (claims.devNotes.trim() === "" ? "(none)" : claims.devNotes.trim()), "  Each claim must carry the command that was run plus the key output line it produced: re-run the command and compare exactly that line. A claim without its key output line is missing evidence — treat it as missing, never guess.", "", "- Additional card details (verbatim):", indent(capsule.additionalDetails === "" ? NO_DETAILS : capsule.additionalDetails), "", "- Runtime constraints (built-in, always apply):", RUNTIME_OUTPUT_DISCIPLINE, RUNTIME_LOCATE_HINT, "", "- Review budget and failure posture (default target ≤10 steps):", "  - Budget the review at ≤10 steps: one git diff / git status to derive the change set, each acceptance command run once, and stop as soon as every acceptance point has independent evidence.", "  - 若在预算内无法独立验证，就用具体阻塞点打回，绝不在缺乏证据时通过。", "  - If you cannot verify a point independently within that budget, reject with the concrete blocking point — never approve without evidence.");
	const verification = ["", "Independent verification (diff-first, not diff-only) — depth: " + capsule.depth + ":"];
	let step = 1;
	verification.push(String(step) + ". Derive the change set yourself from the workspace (git diff / git status against the base commit); the claimed file list is a claim, not the change set.");
	step += 1;
	verification.push(String(step) + ". Acceptance → diff: map every acceptance criterion onto the base/candidate diff — each acceptance point must be covered by a concrete change, or an explicit reason it needs none.");
	step += 1;
	verification.push(String(step) + (deep ? ". Run the acceptance-relevant commands and builds independently, with falsification probes on the boundary inputs the card names and on the failure paths those inputs imply; do not rely on the worker's word." : ". Run the card's acceptance command once (standard depth does not repeat runs) and add a small number of falsification probes on the boundary inputs the card names; do not rely on the worker's word."));
	step += 1;
	verification.push(String(step) + (deep ? ". Call paths: read the files on the acceptance-relevant call paths, including files beyond the changed set when they sit directly on such a path (diff-first does not forbid reading context)." : ". Call paths: read the files on the acceptance-relevant call paths; read files beyond the changed set only when a claim conflicts with the evidence you gathered (standard depth does not read outside the change set otherwise)."));
	step += 1;
	if (capsule.filesScope.trim() !== "") {
		verification.push(String(step) + ". Check the change stays inside the declared file scope: flag any edit outside \"" + capsule.filesScope + "\".");
		step += 1;
	}
	verification.push(String(step) + ". Check the worker's claims (files changed, tests run, root cause) against the evidence you gathered — a claim is never a fact; re-run each claimed command and compare the claimed key output line, and when devNotes gives no key output line, treat that claim as missing rather than guessing.", String(step + 1) + ". Verdict: approve only when every acceptance point is independently verified; otherwise reject with concrete, actionable problems.");
	lines.push(...verification);
	return lines.join("\n");
}
//#endregion
//#region lib/types/domain.js
/**
* Host-side helpers of the taskboard domain: the typed error, bounded
* history rows, agent display labels, and the reviewer/worker prompts. Kept
* separate from ./types.ts (the pure client-safe outlet) because these
* declarations pull dsh-agent and dsh-subagent types into the program.
* @module @deepseek-ai/dsh-taskboard
*/
/** Rejected domain mutation with a stable machine-readable code. */
var TaskboardError = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.code = code;
		this.name = "TaskboardError";
	}
};
/** Append one bounded master notice to a board record under construction.
* @param board - the board record to extend.
* @param notice - the durable notice row to append.
* @returns the board with the bounded notices extended. */
function appendNotice(board, notice) {
	const notices = (board.notices ?? []).length >= 100 ? [...(board.notices ?? []).slice(-99), notice] : [...board.notices ?? [], notice];
	return {
		...board,
		notices
	};
}
/** Append one bounded history row to a record under construction.
* @param record - the record to append the row to.
* @param kind - the stable event kind (e.g. "create", "claim", "approve").
* @param detail - human-readable detail in the board language.
* @param at - Unix epoch milliseconds of the row; defaults to now.
* @returns the record with the bounded history extended. */
function appendHistory(record, kind, detail, at = Date.now()) {
	const row = {
		at,
		kind,
		detail
	};
	const history = record.history.length >= 50 ? [...record.history.slice(-49), row] : [...record.history, row];
	return {
		...record,
		history
	};
}
/** Display label for one agent: the session id is the durable handle, shortened for display.
* @param agent - the agent to label.
* @returns the short display label. */
function agentLabel(agent) {
	return ["agent", agent.id.slice(0, 8)].join(" ");
}
/** Display label for a spawned reviewer child.
* @param childAgentId - the reviewer child's agent id.
* @returns the short display label. */
function reviewerLabel(childAgentId) {
	return ["reviewer", childAgentId.slice(0, 8)].join(" ");
}
/** The prefix every harness-minted session id carries. */
const SESSION_ID_PREFIX = "session-";
/**
* The session segment of a shared-workspace branch: the random uuid part of
* the master session id, not its fixed `session-` prefix, so every session's
* cards land on their own branch namespace.
* @param sessionId - the master session id.
* @returns the uuid part's first eight characters, or the whole id's when the
* id carries no uuid part to shorten.
*/
function sessionSegment(sessionId) {
	const bare = sessionId.startsWith(SESSION_ID_PREFIX) ? sessionId.slice(8) : sessionId;
	return (bare === "" ? sessionId : bare).slice(0, 8);
}
/**
* The independent git branch one session's worker works on for one ticket,
* following the shared-workspace conflict convention: every session stays on
* its own branch (taskboard/<session-short-id>/<ticket-id>) so parallel
* workers in the same working directory never stage/commit over each other;
* the master aggregates the branches when the work lands.
* @param sessionId - the master session id (its uuid part names the branch).
* @param ticketId - the ticket the worker implements.
* @returns the branch name, e.g. "taskboard/abc12345/ticket-xyz".
*/
function branchNameFor(sessionId, ticketId) {
	return "taskboard/" + sessionSegment(sessionId) + "/" + ticketId;
}
/**
* The prompt a freshly spawned reviewer runs with. Self-contained: the child
* has no shared conversation with the developer, so everything it needs —
* the reviewer capsule (acceptance verbatim, base/candidate commits, declared
* scope, touched files, the worker's compact claims) and the exact finishing
* contract — is inlined here. The capsule is compiled fresh per review from
* the current board state; the worker's long exploration process is never
* part of it.
* @param ticket - the ticket under review.
* @param facts - the review-time git facts (base/candidate commits and
* touched files), when computed; otherwise the reviewer determines them
* itself during verification.
* @returns the child's user prompt text.
*/
function buildReviewPrompt(ticket, facts) {
	const capsule = compileReviewerCapsule(ticket, facts);
	return [
		[
			"You are the reviewer for taskboard ticket",
			ticket.id,
			"(\"" + ticket.title + "\"), currently In testing."
		].join(" "),
		"",
		renderReviewerCapsule(capsule),
		...ticket.type === "merge" ? [
			"",
			"Merge ticket specifics — also verify:",
			"- The branch merges cleanly: check for merge conflicts and unresolved conflict markers in the working tree.",
			"- CI results for the change (build and test runs) are green.",
			"- The diff size is proportionate to the description: no unrelated, oversized, or missing changes.",
			"- The target branch was confirmed by the master (the confirmed branch is recorded in the ticket's targetBranch field or devNotes); flag any mismatch."
		] : [],
		"",
		"Finish with EXACTLY ONE tool call, nothing else:",
		"- taskboard_approve with ticketId \"" + ticket.id + "\" and a short summary of what you verified, or",
		"- taskboard_reject with ticketId \"" + ticket.id + "\" and concrete, actionable feedback listing what must change.",
		"",
		"Do not fix the code yourself and do not move the card; your only authority is the approve/reject decision."
	].join("\n");
}
/**
* The prompt a report-mode reviewer runs with. Self-contained like
* {@link buildReviewPrompt}, but the child never touches the card: it
* inspects the workspace and the tests, then returns its conclusion through
* the structured-output tool (the driver's structured_output capture) as
* { verdict, summary, problems }. The master reads that conclusion and acts
* on it with taskboard_resolve_review.
* @param ticket - the ticket under review.
* @param facts - the review-time git facts, when computed (see
* {@link buildReviewPrompt}).
* @param verdictViaTool - V3-28: when the reviewer runs as a durable
*   continuable child it cannot carry an outputSchema (structured output is a
*   one-shot-only subagent capability), so it returns the same
*   { verdict, summary, problems } report through taskboard_review_verdict
*   instead of the structured-output tool.
* @returns the child's user prompt text.
*/
function buildReviewReportPrompt(ticket, facts, verdictViaTool = false) {
	const capsule = compileReviewerCapsule(ticket, facts);
	return [
		[
			"You are the reviewer for taskboard ticket",
			ticket.id,
			"(\"" + ticket.title + "\"), currently In testing."
		].join(" "),
		"",
		renderReviewerCapsule(capsule),
		...ticket.type === "merge" ? [
			"",
			"Merge ticket specifics — also verify:",
			"- The branch merges cleanly: check for merge conflicts and unresolved conflict markers in the working tree.",
			"- CI results for the change (build and test runs) are green.",
			"- The diff size is proportionate to the description: no unrelated, oversized, or missing changes.",
			"- The target branch was confirmed by the master (the confirmed branch is recorded in the ticket's targetBranch field or devNotes); flag any mismatch."
		] : [],
		"",
		...verdictViaTool ? [
			"You are a reporting reviewer: you do NOT move cards; the master resolves the card from your verdict.",
			"Finish with EXACTLY ONE call to taskboard_review_verdict, nothing else:",
			"  - ticketId: \"" + ticket.id + "\",",
			"  - verdict: \"approve\" when the work passes, \"reject\" when it must be reworked,",
			"  - summary: what you inspected and why it passes or fails,",
			"  - problems: concrete, actionable rework items (empty when approving)."
		] : [
			"You are a reporting reviewer: you do NOT move cards and you do NOT call any taskboard tool; the master resolves the card from your verdict.",
			"Finish by calling the structured_output tool exactly once with:",
			"  - verdict: \"approve\" when the work passes, \"reject\" when it must be reworked,",
			"  - summary: what you inspected and why it passes or fails,",
			"  - problems: concrete, actionable rework items (empty when approving)."
		]
	].join("\n");
}
/**
* The prompt a freshly spawned worker runs with. Self-contained: the spawned
* child has no shared conversation with the master, so the worker capsule
* (goal, acceptance verbatim, dispatch-time git facts, declared scope,
* constraints), the shared-workspace branch convention, and the exact
* finishing contract are all inlined. The capsule is compiled fresh on every
* dispatch — retry/recovery recompiles from the current board state and git
* facts instead of appending supplementary notes to a previous prompt. Tool
* permissions are runtime rules (the spawn tool filter plus the workflow
* section), never repeated here per card.
* @param ticket - the ticket to implement.
* @param cwd - the master session's working directory, when known.
* @param sessionId - the master session id; its short form names the worker branch.
* @param preflight - the dispatch-time preflight report ([B] V3-20), when
* computed; its raw git facts fill the capsule's repository-facts field.
* @returns the child's user prompt text.
*/
function buildWorkerPrompt(ticket, cwd, sessionId, preflight) {
	const capsule = compileWorkerCapsule(ticket, preflight);
	const branch = sessionId === void 0 ? void 0 : branchNameFor(sessionId, ticket.id);
	return [
		[
			"You are the worker assigned to taskboard ticket",
			ticket.id,
			"(\"" + ticket.title + "\")."
		].join(" "),
		"",
		renderWorkerCapsule(capsule, cwd),
		...branch === void 0 ? [] : [
			"",
			"Shared-workspace branch convention (parallel sessions must not clash):",
			"  - Before starting, check the git status and the current branch in the working directory.",
			"  - Work on the session branch \"" + branch + "\": create it if missing (git switch -c " + branch + " from the current base) and keep every change of this ticket on it.",
			"  - Do not merge, push, or rebase: the master aggregates the branches when the work is done.",
			"  - If the working tree is not clean or another branch is checked out, switch to the session branch without touching the other session's changes."
		],
		"",
		"Implement the ticket end to end against the goal, acceptance criteria and constraints in the capsule above:",
		"1. Inspect the workspace (git status / diff / log) and read the relevant files.",
		"2. Make the changes and run the relevant tests and builds where the ticket concerns code.",
		"3. Verify edge cases and error paths named in the card, not just the happy path.",
		"",
		"When the work is done and verified, finish with EXACTLY ONE call to taskboard_report with ticketId \"" + ticket.id + "\" and devNotes summarizing what changed, which files were touched, and how it was verified.",
		"",
		"If you cannot complete the work (blocked, missing access, irrecoverable error), finish with EXACTLY ONE call to taskboard_fail with ticketId \"" + ticket.id + "\" and a concrete reason."
	].join("\n");
}
/**
* The wake-up prompt for a worker session that is already dispatched to a
* ticket (V3-28). Unlike {@link buildWorkerPrompt} this message is delivered
* into the existing child session, so it never re-briefs the ticket from
* scratch: it restates the identity, the acceptance criteria (compiled fresh
* from the current card), the recorded progress, why the session was woken and
* the standing instruction not to roll back the preserved working tree — then
* points back at the unchanged finishing contract.
* @param ticket - the card the woken session already owns.
* @param reason - why the board judged the session lost and woke it.
* @returns the continuation message text.
*/
function buildContinuationPrompt(ticket, reason) {
	const capsule = compileWorkerCapsule(ticket);
	const recent = ticket.history.slice(-6);
	return [
		[
			"Wake-up: you are ALREADY the worker for taskboard ticket",
			ticket.id,
			"(\"" + ticket.title + "\"), and this message continues YOUR existing session."
		].join(" "),
		"You keep the full context of your earlier exploration; the shared working tree is preserved — 续做勿回滚：勿回滚工作树，不要丢弃未提交的改动，从你停下的地方继续。",
		"Do NOT roll back the working tree, do NOT discard uncommitted changes, and do NOT restart the work from scratch — resume from where you stopped.",
		"",
		renderWorkerCapsule(capsule),
		"",
		"Why you were woken: " + reason,
		...recent.length === 0 ? [] : [
			"",
			"Your recorded progress on this card (most recent last):",
			...recent.map((row) => "  - [" + row.kind + "] " + row.detail)
		],
		"",
		"Continue the pending work against the goal, acceptance criteria and constraints above, then finish with EXACTLY ONE call to taskboard_report with ticketId \"" + ticket.id + "\" and devNotes summarizing what changed, which files were touched, and how it was verified.",
		"If you are genuinely blocked, finish with EXACTLY ONE call to taskboard_fail with ticketId \"" + ticket.id + "\" and a concrete reason."
	].join("\n");
}
/** One card's handover line detail, scoped to its column. */
function handoverCardDetail(ticket) {
	const bits = [];
	if (ticket.column === "in_progress") {
		bits.push("status " + ticket.status);
		if (ticket.workerAgentId !== void 0) bits.push("worker " + ticket.workerAgentId + " (session " + String(ticket.workerSessionId ?? "") + ")");
		if (ticket.failure !== null) bits.push("failure: " + ticket.failure.reason);
	} else if (ticket.column === "in_testing") {
		bits.push("review attempt " + String(ticket.reviewAttempts + 1));
		bits.push(ticket.reviewer === null ? "review seat vacant" : "reviewer " + ticket.reviewer.agentId);
		if (ticket.reviewOutcome !== null) bits.push("verdict " + ticket.reviewOutcome.verdict + " awaiting resolve");
	} else if (ticket.column === "not_started" || ticket.column === "backlog") {
		if (ticket.dependsOn.length > 0) bits.push("depends on " + ticket.dependsOn.join(", "));
	}
	return bits.length === 0 ? "" : " — " + bits.join("; ");
}
/**
* The structured handover notes taskboard_handover writes onto the board for
* the next master: one section per column with each card's status, the
* in-flight worker identities, the In testing review seats, the backlog
* summary, and the durable master-seat history.
* @param board - the board being handed over.
* @param tickets - every ticket on the board (any order; grouped by column here).
* @returns the notes text, formatted for the next master to read.
*/
function buildHandoverNotes(board, tickets) {
	const sections = [
		["backlog", "Backlog"],
		["not_started", "Not started"],
		["in_progress", "In progress"],
		["in_testing", "In testing"],
		["done", "Done"]
	];
	const lines = [
		"# Taskboard handover — board " + JSON.stringify(board.boardId) + " (\"" + board.name + "\")",
		"",
		"Generated " + new Date(Date.now()).toISOString() + "; the seat has been released.",
		"Claim the seat with taskboard_claim_master (boardId \"" + board.boardId + "\") — the claim",
		"result carries these notes — then continue dispatching (taskboard_assign) and",
		"adjudicating reviews (taskboard_resolve_review) from the state below.",
		""
	];
	for (const [column, name] of sections) {
		const rows = tickets.filter((ticket) => ticket.column === column);
		lines.push("## " + name + " (" + String(rows.length) + ")");
		if (rows.length === 0) lines.push("- (none)");
		else for (const ticket of rows) lines.push("- " + ticket.id + " \"" + ticket.title + "\" [" + ticket.type + ", " + ticket.priority + "]" + handoverCardDetail(ticket));
		lines.push("");
	}
	lines.push("## Master history");
	const history = board.masterHistory ?? [];
	if (history.length === 0) lines.push("- (no seat transitions yet)");
	else for (const entry of history) {
		const target = entry.toAgentId === "" ? "(seat released)" : entry.toAgentId;
		lines.push("- " + new Date(entry.at).toISOString() + " " + String(entry.fromAgentId) + " -> " + target + (entry.notes === "" ? "" : " — " + entry.notes));
	}
	return lines.join("\n");
}
/**
* Build the claim-time handover snapshot from the board row and its tickets.
* @param board - the board being claimed.
* @param tickets - every ticket of this board (any order).
* @returns the structured snapshot (read-only view of the current state).
*/
function buildHandoverSnapshot(board, tickets) {
	const order = [
		"backlog",
		"not_started",
		"in_progress",
		"in_testing",
		"done"
	];
	const cards = tickets.filter((ticket) => ticket.column !== "done").sort((a, b) => {
		const col = order.indexOf(a.column) - order.indexOf(b.column);
		return col !== 0 ? col : a.position - b.position;
	}).map((ticket) => ({
		ticketId: ticket.id,
		title: ticket.title,
		column: ticket.column,
		status: ticket.status,
		type: ticket.type,
		priority: ticket.priority,
		workerAgentId: ticket.workerAgentId ?? null,
		reviewer: ticket.reviewer,
		dependsOn: ticket.dependsOn,
		lastReviewOutcome: ticket.lastReview?.outcome ?? null,
		reviewOutcome: ticket.reviewOutcome === null || ticket.reviewOutcome === void 0 ? null : {
			verdict: ticket.reviewOutcome.verdict,
			summary: ticket.reviewOutcome.summary,
			problems: ticket.reviewOutcome.problems
		},
		failure: ticket.failure
	}));
	const counts = {
		backlog: 0,
		not_started: 0,
		in_progress: 0,
		in_testing: 0,
		done: 0
	};
	for (const ticket of tickets) counts[ticket.column] += 1;
	const pendingAdjudications = tickets.filter((ticket) => ticket.column === "in_testing" && ticket.reviewOutcome !== null && ticket.reviewOutcome !== void 0).map((ticket) => ticket.id);
	return {
		boardId: board.boardId,
		name: board.name,
		masterAgentId: board.masterAgentId,
		handoverNotes: board.handoverNotes,
		cards,
		backlogSummary: "Backlog " + counts.backlog + " · Not started " + counts.not_started + " · In progress " + counts.in_progress + " · In testing " + counts.in_testing + " · Done " + counts.done,
		pendingAdjudications
	};
}
/**
* One-line model-visible rendering of a ticket row: the concrete facts
* (ticketId, title, column, status, worker/reviewer identity, dependencies,
* review state, failure) a successor master needs to act without guessing.
* The tool layer renders this text into the model-visible result.
* @param ticket - the row (TicketRow or HandoverCardRow) to render.
* @returns the compact line.
*/
function formatTicketRowLine(ticket) {
	const bits = [
		ticket.id,
		JSON.stringify(ticket.title),
		"column=" + ticket.column,
		"status=" + ticket.status
	];
	if (ticket.type !== void 0) bits.push("type=" + ticket.type);
	if (ticket.priority !== void 0) bits.push("priority=" + ticket.priority);
	if (ticket.workerAgentId) bits.push("worker=" + ticket.workerAgentId);
	if (ticket.reviewer) bits.push("reviewer=" + ticket.reviewer.agentId);
	if (ticket.dependsOn !== void 0 && ticket.dependsOn.length > 0) bits.push("dependsOn=" + ticket.dependsOn.join(","));
	if (ticket.lastReviewOutcome) bits.push("lastReview=" + ticket.lastReviewOutcome);
	if (ticket.failure) bits.push("failure=" + ticket.failure.reason);
	return "- " + bits.join(" ");
}
/**
* Render the claim-time handover snapshot as the model-visible text: the
* per-column summary, every active card's concrete line, the pending
* adjudications, the stored handover notes body, and every durable notice.
* This is the successor's single entry point — it must carry the facts, not
* just counts.
* @param snapshot - the structured snapshot from buildHandoverSnapshot.
* @param notices - the board's durable notices (newest last).
* @returns the full model-visible snapshot text.
*/
function formatHandoverSnapshotText(snapshot, notices) {
	const lines = ["Handover snapshot for board " + JSON.stringify(snapshot.boardId) + " (\"" + snapshot.name + "\")", snapshot.backlogSummary];
	if (snapshot.cards.length === 0) lines.push("Active cards: (none)");
	else {
		lines.push("Active cards:");
		for (const card of snapshot.cards) lines.push(formatTicketRowLine({
			...card,
			id: card.ticketId
		}));
	}
	lines.push("Pending adjudications: " + (snapshot.pendingAdjudications.length === 0 ? "(none)" : snapshot.pendingAdjudications.join(", ")));
	if (snapshot.handoverNotes !== "") {
		lines.push("Handover notes:");
		lines.push(snapshot.handoverNotes);
	}
	if (notices.length === 0) lines.push("Notices: (none)");
	else {
		lines.push("Notices:");
		for (const notice of notices) lines.push("- [" + notice.kind + "] " + notice.ticketId + ": " + notice.text);
	}
	return lines.join("\n");
}
/**
* Render one compact master-event line from its fields.
* @param kind - stable event-kind prefix shown to the master.
* @param fields - compact ticket facts appended to the prefix.
* @returns one single-line event summary.
*/
function formatCompactEvent(kind, fields) {
	const bits = [
		kind + " ticket=" + fields.ticket,
		"title=" + JSON.stringify(fields.title),
		"state=" + fields.state,
		"scope=" + (fields.scope === "" ? "(none)" : fields.scope)
	];
	if (fields.commit !== void 0 && fields.commit !== "") bits.push("commit=" + fields.commit);
	if (fields.verdict !== void 0 && fields.verdict !== "") bits.push("verdict=" + fields.verdict);
	if (fields.blocker !== void 0 && fields.blocker !== "") bits.push("blocker=" + JSON.stringify(fields.blocker));
	if (fields.anomaly !== void 0 && fields.anomaly !== "") bits.push("anomaly=" + JSON.stringify(fields.anomaly));
	return bits.join(" ");
}
/** The compact card state of one ticket: column, plus status when it refines it.
* @param ticket - the ticket (column + status).
* @returns e.g. "in_testing" for a claimed In testing card, "in_progress/blocked" for a blocked one. */
function compactCardState(ticket) {
	return ticket.status === "claimed" || ticket.status === "ready" ? ticket.column : ticket.column + "/" + ticket.status;
}
/** The model-facing workflow section injected into every session's system prompt. */
const WORKFLOW_SECTION = [
	"# Taskboard workflow",
	"",
	"A kanban ticket board (the \"Taskboard\" tab in the web UI) tracks tickets across five columns: Backlog, Not started, In progress, In testing, Done. The USER manages the board from the web UI; you drive the agent side with the taskboard_* tools.",
	"",
	"- When asked to work on the board — or when you are otherwise free and tickets are waiting — call taskboard_list with column \"not_started\". Tickets are ordered by implementation order; dependsOn lists hard ordering constraints.",
	"- Claiming a ticket is the master's scheduling action: only the board's current master may call taskboard_claim, and only for Not started tickets whose dependsOn are all in Done. One ticket at a time per caller. Workers and reviewers never claim — they receive cards through taskboard_assign (dispatch) or taskboard_reassign (re-dispatch).",
	"- Parallelize: when several ready Not started tickets exist, dispatch each to a fresh worker with taskboard_assign — the assign spawns the worker subagent with the ticket content, the worker implements it, and finishes with taskboard_report (done) or taskboard_fail (blocked).",
	"- When the implementation is done and verified, the owning agent calls taskboard_complete with devNotes summarizing what changed and how it was verified. The board moves the ticket to In testing and automatically spawns a fresh reviewer agent. Never review your own ticket.",
	"- If you are spawned as a reviewer: inspect the workspace changes and run the relevant tests, then finish with exactly one call — taskboard_approve(ticketId, summary) or taskboard_reject(ticketId, feedback). Rejections must list concrete, actionable problems. If no reviewer is assigned to an In testing ticket, taskboard_claim_review takes the seat.",
	"- If a ticket you own returns to In progress with a rejected review, rework it per the feedback (delegate to a fresh subagent with the feedback in its prompt) and call taskboard_complete again.",
	"- v2 master dispatch: before assigning work, claim the board's master seat with taskboard_claim_master (boardId defaults to \"default\"). Only the current master may call taskboard_assign and taskboard_reassign.",
	"- Dispatch a Backlog or Not started ticket with taskboard_assign: the card moves to In progress and a fresh worker subagent (the configured worker model and reasoning effort; see taskboard_board_config for per-board overrides) is spawned with the ticket content; the card records the worker identity. Not started is the scheduling display for the next queue — a card needs no move before dispatch. Workers finish with taskboard_report (done) or taskboard_fail (blocked).",
	"- Pause a running card with taskboard_pause (master only): the in-flight worker run is aborted, the card is marked paused (column unchanged) with one history row naming the pauser and the reason, and the master is notified. A paused card is never auto-blocked by the settlement callback or the liveness reconciliation. Resume with taskboard_reassign action \"retry\", which clears the paused status and spawns a fresh worker.",
	"- When a worker fails or its session terminates without reporting, the card stays In progress with status \"blocked\" and a failure record. Use taskboard_reassign with action \"retry\" to spawn a new worker, or action \"backlog\" to return the card to Not started.",
	"- Seat self-healing is automatic: a lost worker session is auto-redispatched (up to the configured per-card cap) with the working tree preserved — the card description carries a \"续做勿回滚\" annotation and the master receives a \"worker-redispatched\" notice. A reviewer seat is released only when its holder session is gone for good (the master seat's liveness rule, V3-43) or a registered reviewer sits idle past the staleness timeout; re-review is capped per card, and a spent cap blocks the card. The master receives a \"reviewer-released\" notice. The master seat follows the same liveness rule and records a \"master-released\" notice. Only when the automatic budget is exhausted is the card blocked for manual taskboard_reassign.",
	"- v2 report-mode review (config.reviewMode \"report\"): the spawned reviewer returns a structured verdict only and never touches the card. Read the ticket's reviewOutcome, then resolve the review with taskboard_resolve_review: approve lands the card in Done (and archives the worker session); reject returns the card for rework. When the result says the original worker could not be followed up, re-dispatch with taskboard_reassign action \"retry\". After the third consecutive reject the card is marked blocked, awaiting the user's decision.",
	"- Master notifications are durable: worker done/failed/lost events and review verdicts land a notice on the board (readable via taskboard_notices, and carried by the taskboard_claim_master result) and are injected into the master's inbox live, or queued into the master's persisted inbox when the master session is not live so the next run receives them.",
	"- Moving cards between columns is the board's master's job, executed only after the master and the user agree on the phase scope; non-master agents never move cards. Not started is the scheduling display for the next queue: the master may dispatch directly from Backlog or Not started with taskboard_assign — no move is needed before dispatch. The user's drag-and-drop keeps its visual feedback, but intent is expressed in the conversation. See the master section's workflow discipline for the plan → phase → schedule → execute order."
].join("\n");
/**
* The master-role section injected into every session's system prompt ahead
* of the workflow section (order 149). Teaches the master seat: dispatch and
* review adjudication belong to the master, context pressure is solved by
* compaction rather than handoff, a real handover first records handover
* notes (board state and per-card worker identities) on the board so the
* successor can continue after taskboard_claim_master, and dispatched
* workers finish their current card without cross-session followup, and
* parallel sessions in a shared workspace keep apart through the per-session
* branch convention plus each card's declared file scope. Also teaches the
* phased workflow discipline: plan requirements into Backlog, agree the
* phase scope and its stopping point with the user, dispatch the phase's
* cards straight from Backlog or Not started (assign accepts both; a move
* is never required before dispatch), stop when the phase is done, and
* number every card at creation time.
*/
const MASTER_SECTION = [
	"# Taskboard master",
	"",
	"You are the board's master: you dispatch tickets to workers, adjudicate review results, and discuss the plan with the user. The master seat is per board — claim it with taskboard_claim_master (boardId defaults to \"default\") before assigning or resolving work.",
	"",
	"- Solve context pressure with compaction first: when the conversation is long or context is running low, compact instead of handing off.",
	"- When a handover is genuinely needed, run taskboard_handover (boardId): it writes structured notes onto the board — every card's status, each in-flight worker's identity (workerAgentId/workerSessionId), the In testing review seats, the backlog summary, and the master history — then releases the seat. The successor claims the seat with taskboard_claim_master; the claim result carries those notes, and the successor continues dispatching from them.",
	"- Already-dispatched workers finish their current card on their own; do not follow them up across sessions.",
	"- Master notices are durable: every worker done/failed/lost event and review verdict lands a {kind, text, at, ticketId} row on the board synchronously, and is injected into your inbox when your session is live (or queued into your persisted inbox when it is not, so the next run replays it). Read them with taskboard_notices, or with taskboard_claim_master whose result carries them — do not rely on polling the board in a loop.",
	"- Read cards in layers (V3-21): default compact — taskboard_list returns one line per card (ticket/title/state/scope/worker/reviewer/dependsOn), enough to dispatch and adjudicate; taskboard_view is the on-demand full read (description, devNotes, history); use the full read only when a compact line leaves an anomaly unresolved.",
	"- Seat self-healing keeps cards moving without you: a lost worker is auto-redispatched (working tree preserved, card description annotated \"续做勿回滚\") up to the per-card cap, and a reviewer seat is released only when its session is gone for good or a registered reviewer sits idle past the staleness timeout, capped per card. A \"worker-redispatched\" or \"reviewer-released\" notice tells you it happened; only when the automatic budget is exhausted does the card land blocked for manual taskboard_reassign.",
	"- The master seat follows the session, not a clock (V3-25, revised by V3-32/V3-34): it is released only when the holder session is gone for good — absent from the registry and with no stored session record — so a restart or idle unload keeps the seat, silence never releases it, and ending your turn after a dispatch is safe — with a \"master-released\" notice and one master-history row; re-claim it with taskboard_claim_master (the result carries the structured snapshot). A release changes ownership only: in-flight cards keep their workers and reviewers.",
	"- Pause a running card with taskboard_pause (master only): the worker run is aborted, the card is marked paused (column unchanged; history records the pauser and reason) and the master is notified. Paused cards are exempt from settlement reclamation and the liveness reconciliation; resume with taskboard_reassign action \"retry\" (spawns a fresh worker) or return them to Not started with action \"backlog\".",
	"- Record the plan you agree with the user on the board: taskboard_create adds a card to a board's Backlog, taskboard_move schedules a card between columns, and taskboard_plan adjusts dependencies, priority, and ordering. These are master-only tools.",
	"- Claiming a Not started ticket (taskboard_claim) is your scheduling action, not the worker's: only the current master may claim.",
	"- Merge tickets (type \"merge\") are only approved after the master confirms the target branch; record it in the ticket's targetBranch field (or devNotes) before resolving the review.",
	"- User-scheduled Not started cards wake you: when the user moves a card into Not started, a \"user-scheduled\" notice (card id, title, priority, type, dependsOn with all-Done status, filesScope) lands in your inbox and on the board. Adjudicate whether to start it: when every dependency is Done, dispatch with taskboard_assign — the card moves to In progress and the workflow starts. When the card cannot start, tell the user the refusal reason in the conversation (name the unfinished dependency cards) and record the reason in the card's history or devNotes so the decision leaves a durable trace.",
	"",
	"# Workflow discipline (plan → phase → schedule → execute)",
	"",
	"Run the board in phases; the user decides the scope, the master executes the schedule:",
	"- Requirement planning: discuss with the user which requirements to take on, and write every agreed requirement to the board's Backlog as a card (taskboard_create).",
	"- Phase scope: agree with the user which cards this phase covers and where it stops — record the phase's explicit stopping point before scheduling.",
	"- Phase scheduling: once the phase scope is confirmed, the phase's cards can be dispatched straight from Backlog — taskboard_assign accepts Backlog and Not started, so no move is ever required before dispatch (the old rule that the master must move cards from Backlog to Not started first is gone). Not started is kept as the scheduling display for the \"next queue\": move a card there (taskboard_move) when you want to show the user what is next without starting it, and the user's own drag into Not started still wakes you with a \"user-scheduled\" notice. The user's drag-and-drop keeps its visual feedback, but intent is expressed in the conversation.",
	"- Execution discipline: dispatch from Backlog or Not started — never touch In progress / In testing / Done cards (those already have a worker or a review in flight). When the phase's cards are all Done the phase is over: stop and wait for the user to confirm the next phase's scope.",
	"- Card numbering: every card carries a number (e.g. V3-1, V3-7) agreed at creation/discussion time, so the plan and the board stay easy to manage.",
	"",
	"# Shared-workspace branch convention (parallel sessions)",
	"",
	"Parallel sessions may share one working directory; to keep them from stepping on each other's files and git state:",
	"- Before starting work on the repo — and again before dispatching — check the git status and the current branch (git status / git branch --show-current). A dirty tree or an unexpected branch changes what workers may touch safely.",
	"- Each session works on its own independent branch: taskboard/<session-short-id>/<ticket-id> (e.g. taskboard/abc12345/ticket-xyz). When you dispatch a card, the worker prompt carries that branch; spawned workers create/switch to it and keep their changes there.",
	"- Workers do not merge or push: when the work is done the master aggregates the session branches (review the diff, merge into the shared base), then reports completion. Never let two sessions commit to the same branch.",
	"",
	"# File-scope declarations (filesScope)",
	"",
	"- Every card carries a filesScope field ('' by default): the ABSOLUTE paths (files or directories, e.g. \"C:/repo/packages/x/src\") the card affects. Declare it when creating or editing a card — during planning you and the user agree on which files the work touches.",
	"- When dispatching with taskboard_assign, read the filesScope of every In-flight and Not started card before starting new workers: two workers whose scopes overlap must not run in parallel (serialize them or tighten the scopes), and a card whose scope depends on another card's output is a soft dependency — order it after that card even without a dependsOn edge.",
	"- When a card has no filesScope declared, ask the user or record one before dispatching so parallel safety is judged on facts, not guesses.",
	"",
	"# Handover data contract (fail closed)",
	"",
	"The claim-time handover snapshot is the successor's single entry point into the board state:",
	"- taskboard_claim_master returns the fresh structured snapshot (every active card's ticketId, title, column, status, worker/reviewer identity, dependencies, latest review, plus the per-column summary and the pending adjudications). Read it before anything else.",
	"- If the claim result's cards snapshot is missing or unreadable, or taskboard_list returns no rows while the snapshot promises active cards: fail closed — stop dispatching, report \"handover data unavailable\" to the user, and wait for instructions.",
	"- Never guess ticket ids, never create probe cards, and never use write operations (move/pause/reassign) to reverse-engineer board state. Read only via the claim snapshot, taskboard_list, and taskboard_view."
].join("\n");
/**
* The informational model-suggestion note appended to the master section
* (V3-5): the session's own model and effort are authoritative, so this is a
* recommended preset for NEW sessions only, plus a pointer to the board-level
* modelConfig override path.
* @param model - the configured masterModel suggestion.
* @param effort - the configured masterEffort suggestion, if any.
* @returns the markdown note block, ready to append after MASTER_SECTION.
*/
function masterModelNote(model, effort) {
	return [
		"",
		"# Model preset suggestion (new sessions)",
		"",
		"This deployment suggests running a new master session with model \"" + model + "\"" + (effort === void 0 ? "" : " and reasoning effort \"" + effort + "\"") + ". The current session's own model and effort are authoritative — treat this only as the recommended preset for a fresh session.",
		"Per-board worker/reviewer model+effort overrides live in the board's modelConfig; read or change them with taskboard_board_config (master only)."
	].join("\n");
}
//#endregion
//#region lib/types/preflight.js
/**
* Deterministic repo/worktree preflight (V3-20): before a worker is spawned,
* the service computes the live git facts of the repo a card dispatches
* against and judges them against the configured canonical base — the repo's
* authoritative baseline (branch + commit), the assigned worktree, the
* reserved integration worktrees, and the cross-card file-scope conflicts.
* The pure core (evaluatePreflight) turns facts into a PreflightReport with
* concrete violations; the git seam (collectGitFacts) gathers those facts
* fresh on every dispatch (never cached). Any invariant violation fails the
* dispatch closed (card blocked, no worker spawned) — a worker never has to
* guess the branch, switch worktrees, or archaeology the repository.
* @module @deepseek-ai/dsh-taskboard/preflight
*/
/**
* Normalize a path for comparison: resolve against the process cwd when
* relative, forward slashes, trimmed trailing separator, and lowercase on
* Windows so "C:\\Repo" and "c:/repo/" compare equal.
* @param path - the path to normalize.
* @returns the normalized absolute path.
*/
function normalizePath(path) {
	const absolute = isAbsolute(path) ? path : resolve(path);
	return (process.platform === "win32" ? absolute.toLowerCase() : absolute).replace(/\\/g, "/").replace(/\/+$/, "");
}
/**
* True when one path is inside (or equals) another, at a path-separator
* boundary — a parent directory check, not a string-prefix check.
* @param parent - the containing path.
* @param candidate - the path to test.
* @returns true when candidate is parent or nested under it.
*/
function isInsidePath(parent, candidate) {
	const p = normalizePath(parent);
	const c = normalizePath(candidate);
	return c === p || c.startsWith(p + "/");
}
/**
* Resolve one configured worktree entry (absolute or repo-root-relative) to
* an absolute path.
* @param repoRoot - the repo root the entry is relative to.
* @param entry - the configured entry.
* @returns the absolute path.
*/
function resolveRepoPath(repoRoot, entry) {
	return isAbsolute(entry) ? entry : resolve(repoRoot, entry);
}
/**
* Run one git command against the repo. Never throws for a nonzero exit —
* the status and output are facts the preflight judges.
* @param repoRoot - the working directory to run git in.
* @param args - the git arguments.
* @returns the status, stdout and stderr.
*/
function git(repoRoot, args) {
	let result;
	try {
		result = spawnSync("git", args, {
			cwd: repoRoot,
			encoding: "utf8",
			windowsHide: true
		});
	} catch {
		return {
			status: -1,
			stdout: "",
			stderr: "git executable unavailable"
		};
	}
	if (result.error !== void 0) return {
		status: -1,
		stdout: "",
		stderr: result.error.message
	};
	/* v8 ignore start -- defensive: every git call passes encoding 'utf8' and runs to
	exit, so status is a number and stdout/stderr are strings; a signal-killed
	child (status null) or a decode failure is never exercised by the harnessed lanes. */
	return {
		status: result.status ?? -1,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : ""
	};
	/* v8 ignore stop */
}
/**
* Parse `git worktree list --porcelain` into entries: the absolute worktree
* path and the checked-out branch ('' when detached). The main working tree
* is the first entry.
* @param porcelain - the porcelain command result.
* @returns the parsed worktree entries.
*/
function parseWorktrees(porcelain) {
	if (porcelain.status !== 0) return [];
	const entries = [];
	let path = "";
	let branch = "";
	for (const line of porcelain.stdout.split(/\r?\n/)) if (line.startsWith("worktree ")) {
		if (path !== "") entries.push({
			path,
			branch
		});
		path = line.slice(9).trim();
		branch = "";
	} else if (line.startsWith("branch ")) branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
	else if (line.trim() === "" && path !== "") {
		entries.push({
			path,
			branch
		});
		path = "";
		branch = "";
	}
	if (path !== "") entries.push({
		path,
		branch
	});
	return entries;
}
/**
* Compute the HEAD-vs-canonical-base relationship through the commit graph.
* @param repoRoot - the repo to ask.
* @param head - the HEAD commit.
* @param canonical - the canonical base commit.
* @returns the relationship.
*/
function relationshipOf(repoRoot, head, canonical) {
	if (head === canonical) return "equal";
	const ahead = git(repoRoot, [
		"merge-base",
		"--is-ancestor",
		canonical,
		head
	]).status === 0;
	const behind = git(repoRoot, [
		"merge-base",
		"--is-ancestor",
		head,
		canonical
	]).status === 0;
	if (ahead) return "ahead";
	if (behind) return "behind";
	return "diverged";
}
/**
* Gather the live git facts of one repo fresh (never cached): canonical
* top-level, actual branch, HEAD, dirty-file list, registered worktrees, and
* the canonical base resolution plus the HEAD-vs-base relationship.
* @param repoRoot - the working directory to inspect (main tree or worktree).
* @param canonicalBranch - the canonical base branch to resolve.
* @param canonicalCommit - an optional pinned canonical commit (overrides the branch tip).
* @returns the gathered facts; ok=false when the directory is not a usable git repo.
*/
function collectGitFacts(repoRoot, canonicalBranch, canonicalCommit) {
	const topLevel = git(repoRoot, ["rev-parse", "--show-toplevel"]);
	if (topLevel.status !== 0) return {
		repoRoot,
		actualBranch: "",
		head: "",
		dirtyFiles: [],
		worktrees: [],
		mainWorktree: repoRoot,
		canonicalCommit: null,
		canonicalBranchExists: false,
		relationship: null,
		ok: false,
		/* v8 ignore next -- git failures always write a fatal message to stderr; the empty-stderr fallback is defensive. */
		error: topLevel.stderr.trim() === "" ? "not a git repository" : topLevel.stderr.trim()
	};
	const root = topLevel.stdout.trim();
	const branchOut = git(root, ["branch", "--show-current"]);
	/* v8 ignore next -- 'git branch --show-current' cannot fail in a work tree after --show-toplevel succeeded. */
	const branch = branchOut.status === 0 ? branchOut.stdout.trim() : "";
	const headOut = git(root, ["rev-parse", "HEAD"]);
	const head = headOut.status === 0 ? headOut.stdout.trim() : "";
	const status = git(root, [
		"status",
		"--porcelain",
		"--untracked-files=all"
	]);
	/* v8 ignore next -- a porcelain status failure needs a corrupt index; the empty-list fallback is defensive. */
	const dirtyFiles = status.status === 0 ? status.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "") : [];
	const worktrees = parseWorktrees(git(root, [
		"worktree",
		"list",
		"--porcelain"
	]));
	/* v8 ignore next -- a valid work tree always lists its main worktree; the root fallback is defensive. */
	const mainWorktree = worktrees.length > 0 ? worktrees[0]?.path ?? root : root;
	const branchTip = git(root, [
		"rev-parse",
		"--verify",
		"--quiet",
		"refs/heads/" + canonicalBranch
	]);
	const canonicalBranchExists = branchTip.status === 0;
	const resolvedCommit = canonicalCommit !== void 0 && canonicalCommit.trim() !== "" ? canonicalCommit.trim() : canonicalBranchExists ? branchTip.stdout.trim() : null;
	const relationship = resolvedCommit === null ? null : relationshipOf(root, head, resolvedCommit);
	return {
		repoRoot: root,
		/* v8 ignore next -- '(none)' needs an empty branch output AND an empty HEAD
		together (unborn detached HEAD), which the harnessed lanes never combine;
		'(detached)' and the named branch are exercised. */
		actualBranch: branch === "" ? head === "" ? "(none)" : "(detached)" : branch,
		head,
		dirtyFiles,
		worktrees,
		mainWorktree,
		canonicalCommit: resolvedCommit,
		canonicalBranchExists,
		relationship,
		ok: true
	};
}
/**
* Parse a declared filesScope into normalized path entries: split on ';' or
* ',', strip parenthesized annotations like "(新增)", normalize separators,
* and dedupe.
* @param scope - the raw declared scope.
* @returns the normalized entries (empty when the scope is empty/unparseable).
*/
function parseFilesScope(scope) {
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of scope.split(/[;,]/)) {
		const entry = raw.trim().replace(/\s*\([^)]*\)\s*$/, "").replace(/\\/g, "/").replace(/\/+$/, "");
		if (entry === "" || seen.has(entry)) continue;
		seen.add(entry);
		entries.push(entry);
	}
	return entries;
}
/** True when two normalized scope-entry lists share any path (equal or nested). */
function scopesOverlap(a, b) {
	for (const x of a) for (const y of b) if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
	return false;
}
/**
* The cross-card file-scope conflicts of one card against other in-flight
* cards: two scopes overlap when any entry is equal to or nested under an
* entry of the other. A card with no parseable scope conflicts with nothing.
* @param filesScope - the dispatched card's declared scope.
* @param inFlightScopes - other in-flight cards (id + declared scope).
* @returns one message per conflicting card.
*/
function scopeConflicts(filesScope, inFlightScopes) {
	const mine = parseFilesScope(filesScope);
	if (mine.length === 0) return [];
	const conflicts = [];
	for (const other of inFlightScopes) {
		if (other.ticketId === "") continue;
		const theirs = parseFilesScope(other.filesScope);
		if (theirs.length === 0) continue;
		if (scopesOverlap(mine, theirs)) conflicts.push("file-scope conflict with in-flight card \"" + other.ticketId + "\": its scope \"" + other.filesScope + "\" overlaps \"" + filesScope + "\"");
	}
	return conflicts;
}
/**
* The pure preflight judgment: given the live facts and the dispatch
* context, decide every invariant and produce the report with concrete
* violations. Deterministic — the same input always yields the same report.
* @param input - the live facts plus the dispatch context.
* @returns the preflight report (safe=false carries the violations).
*/
function evaluatePreflight(input) {
	const violations = [];
	if (!input.canonicalBranchExists) violations.push("canonical base branch \"" + input.canonicalBase.branch + "\" does not exist in \"" + input.repoRoot + "\"");
	if (input.actualBranch !== input.canonicalBase.branch) violations.push("actual branch \"" + input.actualBranch + "\" is not the canonical base branch \"" + input.canonicalBase.branch + "\"");
	if (input.relationship !== "equal" && input.relationship !== "unknown") violations.push("HEAD " + input.head + " is " + input.relationship + " the canonical base " + input.canonicalBase.branch + " @ " + input.canonicalBase.commit + " (dispatch requires HEAD exactly on the canonical base)");
	if (input.dirtyFiles.length > 0) violations.push("working tree of \"" + input.repoRoot + "\" has uncommitted change(s): " + input.dirtyFiles.join("; "));
	for (const reservedPath of input.reservedWorktrees) {
		if (isInsidePath(reservedPath, input.assignedWorktree)) violations.push("assigned worktree \"" + input.assignedWorktree + "\" is a reserved worktree (\"" + reservedPath + "\"); workers must never occupy it");
		if (isInsidePath(reservedPath, input.repoRoot)) violations.push("dispatch source \"" + input.repoRoot + "\" is inside reserved worktree \"" + reservedPath + "\" (occupied); dispatch from the main working tree");
	}
	const conflicts = scopeConflicts(input.filesScope, input.inFlightScopes);
	for (const conflict of conflicts) violations.push(conflict);
	return {
		safe: violations.length === 0,
		violations,
		repoRoot: input.repoRoot,
		canonicalBase: input.canonicalBase,
		assignedWorktree: input.assignedWorktree,
		actualBranch: input.actualBranch,
		head: input.head,
		dirtyFiles: input.dirtyFiles,
		baseCandidateRelationship: input.relationship,
		filesScope: input.filesScope,
		conflicts,
		checkedAt: input.checkedAt
	};
}
/**
* Run the full preflight for one dispatch: gather the live git facts (never
* cached) and judge them against the configured canonical base. A gather
* failure fails closed with a concrete violation.
* @param repoRoot - the working directory to inspect (main tree or worktree).
* @param config - the repo's preflight contract.
* @param filesScope - the card's declared file scope.
* @param inFlightScopes - other in-flight cards of the same board.
* @returns the preflight report.
*/
function runPreflight(repoRoot, config, filesScope, inFlightScopes = []) {
	const facts = collectGitFacts(repoRoot, config.canonicalBranch, config.canonicalCommit);
	const baseRoot = facts.mainWorktree;
	const assignedWorktree = config.worktree === void 0 ? facts.repoRoot : resolveRepoPath(baseRoot, config.worktree);
	const canonicalCommit = facts.canonicalCommit;
	const canonicalBase = {
		branch: config.canonicalBranch,
		commit: canonicalCommit ?? ""
	};
	const checkedAt = Date.now();
	if (!facts.ok) return {
		safe: false,
		/* v8 ignore next -- collectGitFacts always sets error on ok=false; the fallback is defensive. */
		violations: ["cannot gather git facts for \"" + repoRoot + "\": " + String(facts.error ?? "git unavailable")],
		repoRoot: facts.repoRoot,
		canonicalBase,
		assignedWorktree,
		actualBranch: facts.actualBranch,
		head: facts.head,
		dirtyFiles: facts.dirtyFiles,
		baseCandidateRelationship: "unknown",
		filesScope,
		conflicts: [],
		checkedAt
	};
	const reservedWorktrees = (config.reservedWorktrees ?? []).map((entry) => resolveRepoPath(baseRoot, entry));
	return evaluatePreflight({
		repoRoot: facts.repoRoot,
		canonicalBase,
		canonicalBranchExists: facts.canonicalBranchExists,
		assignedWorktree,
		actualBranch: facts.actualBranch,
		head: facts.head,
		dirtyFiles: facts.dirtyFiles,
		worktrees: facts.worktrees,
		relationship: facts.relationship ?? "unknown",
		filesScope,
		inFlightScopes,
		reservedWorktrees,
		checkedAt
	});
}
/**
* The model-visible preflight section inlined into the worker prompt: the
* raw facts (canonical base, assigned worktree, actual branch, HEAD, dirty
* list, base/candidate relationship, declared scope) — not just a SAFE flag —
* so the worker starts from deterministic facts it can re-check.
* @param report - the dispatch-time preflight report.
* @returns the prompt section text (leading blank line, ready to append).
*/
function preflightPromptSection(report) {
	return [
		"",
		"Deterministic repo preflight (computed at dispatch time):",
		"  canonical base: " + report.canonicalBase.branch + " @ " + report.canonicalBase.commit,
		"  assigned worktree: " + report.assignedWorktree,
		"  actual branch: " + report.actualBranch,
		"  HEAD: " + report.head,
		"  dirty files: " + (report.dirtyFiles.length === 0 ? "(none)" : report.dirtyFiles.join("; ")),
		"  base/candidate relationship: " + report.baseCandidateRelationship,
		"  declared file scope: " + (report.filesScope.trim() === "" ? "(not declared)" : report.filesScope),
		"  invariants: " + (report.safe ? "SAFE (all invariants satisfied)" : "VIOLATED: " + report.violations.join(" | "))
	].join("\n");
}
//#endregion
//#region lib/types/service.js
/**
* The taskboard domain service: durable five-column ticket storage across
* multiple boards, the master seat, the agent-facing workflow tools
* (list/claim/assign/report/fail/reassign/complete/approve/reject), the
* browser Remote API, automatic worker/reviewer spawning with a fixed worker
* model, and failure reclamation when a worker session ends without
* reporting. Tickets persist through the storage-domain seam; every
* committed mutation emits the forwarded taskboard/changed event.
* @module @deepseek-ai/dsh-taskboard
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** The single stored ticket shape; validated at the durable boundary. */
const ticketSchema = z$1.object({
	id: z$1.string().min(1),
	title: z$1.string().min(1),
	description: z$1.string(),
	column: z$1.enum(TASKBOARD_COLUMNS),
	priority: z$1.enum(TASKBOARD_PRIORITIES),
	boardId: z$1.string().default("default"),
	type: z$1.enum(TASKBOARD_TYPES).default("feature"),
	status: z$1.enum(TASKBOARD_WORKER_STATUSES).default("claimed"),
	workerAgentId: z$1.string().optional(),
	workerSessionId: z$1.string().optional(),
	failure: z$1.object({
		reason: z$1.string(),
		at: z$1.number()
	}).nullable().default(null),
	autoRetries: z$1.number().int().min(0).default(0),
	reviewerRetries: z$1.number().int().min(0).default(0),
	createdAt: z$1.number(),
	updatedAt: z$1.number(),
	position: z$1.number(),
	assignee: z$1.union([z$1.object({
		agentId: z$1.string().min(1),
		label: z$1.string()
	}), z$1.null()]),
	reviewer: z$1.union([z$1.object({
		agentId: z$1.string().min(1),
		label: z$1.string()
	}), z$1.null()]),
	reviewAttempts: z$1.number().int().min(0),
	lastReview: z$1.union([z$1.object({
		outcome: z$1.enum(["approved", "rejected"]),
		feedback: z$1.string(),
		reviewer: z$1.object({
			agentId: z$1.string().min(1),
			label: z$1.string()
		}),
		attempt: z$1.number().int().min(1),
		at: z$1.number()
	}), z$1.null()]),
	reviewOutcome: z$1.union([z$1.object({
		verdict: z$1.enum(["approve", "reject"]),
		summary: z$1.string(),
		problems: z$1.array(z$1.string()),
		at: z$1.number()
	}), z$1.null()]).default(null),
	devNotes: z$1.string(),
	targetBranch: z$1.string().default(""),
	filesScope: z$1.string().default(""),
	dependsOn: z$1.array(z$1.string()),
	history: z$1.array(z$1.object({
		at: z$1.number(),
		kind: z$1.string(),
		detail: z$1.string()
	}))
});
/** The stored board record shape; validated at the durable boundary. */
const boardSchema = z$1.object({
	boardId: z$1.string().min(1),
	name: z$1.string(),
	workspaceId: z$1.string(),
	scope: z$1.enum(["session", "project"]).default("session"),
	ownerSessionId: z$1.string().nullable().default(null),
	masterAgentId: z$1.string().nullable().default(null),
	masterClaimedAt: z$1.number().nullable().default(null),
	masterExpiresAt: z$1.number().nullable().default(null),
	handoverNotes: z$1.string().default(""),
	masterHistory: z$1.array(z$1.object({
		fromAgentId: z$1.string().nullable(),
		toAgentId: z$1.string(),
		at: z$1.number(),
		notes: z$1.string()
	})).default([]),
	notices: z$1.array(z$1.object({
		kind: z$1.string(),
		text: z$1.string(),
		at: z$1.number(),
		ticketId: z$1.string()
	})).default([]),
	modelConfig: z$1.object({
		workerModel: z$1.string().optional(),
		workerEffort: z$1.string().optional(),
		reviewerModel: z$1.string().optional(),
		reviewerEffort: z$1.string().optional()
	}).default({}),
	archivedAt: z$1.number().nullable().default(null)
});
/**
* The structured report a report-mode reviewer must return through the
* structured-output tool: { verdict, summary, problems }. Within
* assertObjectJsonSchema's enforced subset (object root, required as an array
* of property names, no per-property required flag).
*/
const REVIEW_OUTCOME_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		verdict: {
			type: "string",
			enum: ["approve", "reject"]
		},
		summary: { type: "string" },
		problems: {
			type: "array",
			items: { type: "string" }
		}
	},
	required: [
		"verdict",
		"summary",
		"problems"
	]
};
/** True when a settled run's structured value matches the review-report shape. */
function isReviewOutcome(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	if (record.verdict !== "approve" && record.verdict !== "reject") return false;
	if (typeof record.summary !== "string") return false;
	return Array.isArray(record.problems) && record.problems.every((problem) => typeof problem === "string");
}
/** Stable master-notice event kinds (the dedupe key part alongside ticketId). */
/** Reviewer verdicts a report-mode reviewer may report (validated at the tool boundary). */
const REVIEW_VERDICTS = ["approve", "reject"];
const NOTICE_KIND = {
	reviewVerdict: "review-verdict",
	workerDone: "worker-done",
	workerFailed: "worker-failed",
	workerTerminated: "worker-terminated",
	workerLost: "worker-lost",
	workerRedispatched: "worker-redispatched",
	workerContinued: "worker-continued",
	reviewerReleased: "reviewer-released",
	userScheduled: "user-scheduled",
	workerPaused: "worker-paused",
	preflightBlocked: "preflight-blocked",
	masterReleased: "master-released"
};
/**
* Fold a stored session log's 'agent/inbox/spliced' events into the pending
* message count per inbox target, mirroring the agent-loop Inbox projection
* (Inbox.apply replays the same events on session load). Used to compute the
* append coordinate of a cold master's inbox so a delivered notice lands at
* the end of the pending queue and never clobbers already-pending input.
*/
function pendingInboxLengths(events) {
	let nextTurn = 0;
	let nextStep = 0;
	for (const event of events) {
		if (event.type !== "agent/inbox/spliced") continue;
		const splice = event.data;
		if (splice.target !== "next-turn" && splice.target !== "next-step") continue;
		const start = typeof splice.start === "number" && splice.start >= 0 ? splice.start : 0;
		const removed = typeof splice.removedCount === "number" ? splice.removedCount : 0;
		const inserted = Array.isArray(splice.inserted) ? splice.inserted.length : 0;
		const current = splice.target === "next-turn" ? nextTurn : nextStep;
		const removedFromTail = Math.min(removed, Math.max(current - start, 0));
		const updated = Math.max(current - removedFromTail, 0) + inserted;
		if (splice.target === "next-turn") nextTurn = updated;
		else nextStep = updated;
	}
	return {
		nextTurn,
		nextStep
	};
}
/** The taskboard storage domain declaration: tickets plus boards tables. */
const TASKBOARD_DOMAIN = defineDomain({
	name: "taskboard",
	version: 1,
	tables: {
		tickets: domainTable(ticketSchema),
		boards: domainTable(boardSchema)
	}
});
/** Schemastery configuration for the taskboard consumer. */
const Config = z.object({
	reviewProvider: z.string().default("spawn"),
	masterModel: z.string().default("deepseek-v4-pro-max"),
	masterEffort: z.string(),
	workerModel: z.string().default("deepseek-v4-flash"),
	workerEffort: z.string(),
	reviewerModel: z.string(),
	reviewerEffort: z.string(),
	workerProvider: z.string().default("spawn"),
	reviewMode: z.union(["report", "direct"]).default("report"),
	reconcileIntervalMs: z.number().default(6e4),
	noticeDedupeWindowMs: z.number().default(1e4),
	lostWorkerTimeoutMs: z.number().default(6e5),
	workerAutoRetryLimit: z.number().default(2),
	reviewerStaleTimeoutMs: z.number().default(9e5),
	reviewerAutoRetryLimit: z.number().default(2),
	preflightRepos: z.dict(z.object({
		canonicalBranch: z.string(),
		canonicalCommit: z.string(),
		worktree: z.string(),
		reservedWorktrees: z.array(z.string()),
		enforce: z.boolean()
	}))
});
/** The reasoning-effort vocabulary the deepseek family of models accepts (see llm-deepseek). */
const EFFORT_LEVELS = [
	"off",
	"high",
	"max"
];
/**
* Resolve one reasoning-effort knob. Absent means unset (the child model's
* adapter default applies, e.g. deepseek "high"); a value outside the
* deepseek vocabulary is an invalid config and falls back to unset (V3-5
* "非法值回退默认") rather than failing the whole plugin load.
* @param value - the configured effort value, if any.
* @returns the accepted level, or undefined for absent/invalid values.
*/
function resolveEffort(value) {
	if (value === void 0) return void 0;
	return EFFORT_LEVELS.includes(value) ? value : void 0;
}
/** Validate one explicit worker-liveness reconciliation interval (0 disables the periodic scan). */
function resolveReconcileInterval(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("taskboard: reconcileIntervalMs must be a non-negative safe integer");
	return value;
}
/** Validate one explicit master-notice dedupe window (0 disables dedupe). */
function resolveNoticeDedupeWindow(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("taskboard: noticeDedupeWindowMs must be a non-negative safe integer");
	return value;
}
/** Validate one explicit idle-staleness timeout (0 disables the idle-staleness arm). */
function resolveLostWorkerTimeout(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("taskboard: lostWorkerTimeoutMs must be a non-negative safe integer");
	return value;
}
/** Validate one explicit per-card auto-redispatch cap (0 disables auto-redispatch). */
function resolveWorkerAutoRetryLimit(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("taskboard: workerAutoRetryLimit must be a non-negative safe integer");
	return value;
}
/** Validate one explicit reviewer-staleness timeout (0 disables reviewer staleness). */
function resolveReviewerStaleTimeout(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("taskboard: reviewerStaleTimeoutMs must be a non-negative safe integer");
	return value;
}
/** Validate one explicit per-card reviewer re-review cap (0 disables auto-redispatch). */
function resolveReviewerAutoRetryLimit(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("taskboard: reviewerAutoRetryLimit must be a non-negative safe integer");
	return value;
}
/** Column ids as a runtime set for cheap membership checks. */
const COLUMN_SET = new Set(TASKBOARD_COLUMNS);
/** True when a value is a known column id. */
function isColumn(value) {
	return COLUMN_SET.has(value);
}
/** Normalize a user-supplied title at the domain boundary. */
function resolveTitle(value) {
	const title = typeof value === "string" ? value.trim() : "";
	if (title.length === 0) throw new TaskboardError("ticket title must be a non-empty string", "TASKBOARD_INVALID_INPUT");
	return title;
}
/** Normalize a user-supplied board name at the domain boundary. */
function resolveBoardName(value) {
	const name = typeof value === "string" ? value.trim() : "";
	if (name.length === 0) throw new TaskboardError("board name must be a non-empty string", "TASKBOARD_INVALID_INPUT");
	return name;
}
/** Normalize a required free-text input at the domain boundary. */
function resolveRequiredText(value, subject) {
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length === 0) throw new TaskboardError(subject + " must be a non-empty string", "TASKBOARD_INVALID_INPUT");
	return text;
}
/** Longest field value echoed verbatim into a metadata-correction history row. */
const HISTORY_VALUE_LIMIT = 160;
/** Collapse one field value to a single bounded line for a history summary. */
function historyFieldValue(value) {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= HISTORY_VALUE_LIMIT ? flat : flat.slice(0, HISTORY_VALUE_LIMIT) + "...";
}
/**
* Render one field's old -> new history summary (V3-40): the field name plus
* both JSON-quoted, single-line, length-bounded values, so a correction is
* auditable without a long description flooding the bounded history.
*/
function historyFieldChange(field, before, after) {
	return field + " " + JSON.stringify(historyFieldValue(before)) + " -> " + JSON.stringify(historyFieldValue(after));
}
/**
* The taskboard service (ctx.taskboard): storage-backed tickets and boards,
* the master seat, workflow transitions, the browser Remote surface, and the
* model-facing tools.
*/
let TaskboardService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _listBoards_decorators;
	let _createBoardRemote_decorators;
	let _archiveBoardRemote_decorators;
	let _createRemote_decorators;
	let _moveRemote_decorators;
	let _editRemote_decorators;
	let _removeRemote_decorators;
	let _requestReviewRemote_decorators;
	return class TaskboardService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_listBoards_decorators = [Remote("listBoards")];
			_createBoardRemote_decorators = [Remote("createBoard")];
			_archiveBoardRemote_decorators = [Remote("archiveBoard")];
			_createRemote_decorators = [Remote("create")];
			_moveRemote_decorators = [Remote("move")];
			_editRemote_decorators = [Remote("edit")];
			_removeRemote_decorators = [Remote("delete")];
			_requestReviewRemote_decorators = [Remote("requestReview")];
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listBoards_decorators, {
				kind: "method",
				name: "listBoards",
				static: false,
				private: false,
				access: {
					has: (obj) => "listBoards" in obj,
					get: (obj) => obj.listBoards
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createBoardRemote_decorators, {
				kind: "method",
				name: "createBoardRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "createBoardRemote" in obj,
					get: (obj) => obj.createBoardRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _archiveBoardRemote_decorators, {
				kind: "method",
				name: "archiveBoardRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "archiveBoardRemote" in obj,
					get: (obj) => obj.archiveBoardRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createRemote_decorators, {
				kind: "method",
				name: "createRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "createRemote" in obj,
					get: (obj) => obj.createRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _moveRemote_decorators, {
				kind: "method",
				name: "moveRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "moveRemote" in obj,
					get: (obj) => obj.moveRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _editRemote_decorators, {
				kind: "method",
				name: "editRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "editRemote" in obj,
					get: (obj) => obj.editRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _removeRemote_decorators, {
				kind: "method",
				name: "removeRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "removeRemote" in obj,
					get: (obj) => obj.removeRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _requestReviewRemote_decorators, {
				kind: "method",
				name: "requestReviewRemote",
				static: false,
				private: false,
				access: {
					has: (obj) => "requestReviewRemote" in obj,
					get: (obj) => obj.requestReviewRemote
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"storageDomain",
			"systemPrompt",
			"tools",
			"agents"
		];
		static Config = Config;
		resolved = __runInitializers(this, _instanceExtraInitializers);
		domain;
		/**
		* One in-flight spawned run plus the abort controller owning its request
		* signal, keyed by ticket id (V3-16): the board-level pause verb aborts the
		* current worker's run through this handle, and every settle/close path
		* clears the entry so a settled or removed card never leaks a handle.
		*/
		runHandles = /* @__PURE__ */ new Map();
		constructor(ctx, config = {}) {
			super(ctx, "taskboard");
			const workerEffort = resolveEffort(config.workerEffort);
			const workerModel = config.workerModel ?? "deepseek-v4-flash";
			const preflightRepos = {};
			for (const [root, repo] of Object.entries(config.preflightRepos ?? {})) {
				if (repo === void 0 || repo === null || typeof repo !== "object") {
					ctx.logger.warn("taskboard: preflight repo \"" + root + "\" has an invalid config; ignoring it");
					continue;
				}
				if (typeof repo.canonicalBranch !== "string" || repo.canonicalBranch.trim() === "") {
					ctx.logger.warn("taskboard: preflight repo \"" + root + "\" has no canonicalBranch; ignoring it");
					continue;
				}
				preflightRepos[root] = {
					canonicalBranch: repo.canonicalBranch.trim(),
					...typeof repo.canonicalCommit === "string" && repo.canonicalCommit.trim() !== "" ? { canonicalCommit: repo.canonicalCommit.trim() } : {},
					...typeof repo.worktree === "string" && repo.worktree.trim() !== "" ? { worktree: repo.worktree.trim() } : {},
					...Array.isArray(repo.reservedWorktrees) ? { reservedWorktrees: repo.reservedWorktrees.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) } : {},
					...repo.enforce === false ? { enforce: false } : {}
				};
			}
			this.resolved = {
				reviewProvider: config.reviewProvider ?? "spawn",
				masterModel: config.masterModel ?? "deepseek-v4-pro-max",
				masterEffort: resolveEffort(config.masterEffort),
				workerModel,
				workerEffort,
				reviewerModel: config.reviewerModel ?? workerModel,
				reviewerEffort: resolveEffort(config.reviewerEffort) ?? workerEffort,
				workerProvider: config.workerProvider ?? "spawn",
				reviewMode: config.reviewMode === "direct" ? "direct" : "report",
				reconcileIntervalMs: resolveReconcileInterval(config.reconcileIntervalMs ?? 6e4),
				noticeDedupeWindowMs: resolveNoticeDedupeWindow(config.noticeDedupeWindowMs ?? 1e4),
				lostWorkerTimeoutMs: resolveLostWorkerTimeout(config.lostWorkerTimeoutMs ?? 6e5),
				workerAutoRetryLimit: resolveWorkerAutoRetryLimit(config.workerAutoRetryLimit ?? 2),
				reviewerStaleTimeoutMs: resolveReviewerStaleTimeout(config.reviewerStaleTimeoutMs ?? 9e5),
				reviewerAutoRetryLimit: resolveReviewerAutoRetryLimit(config.reviewerAutoRetryLimit ?? 2),
				preflightRepos
			};
			if (config.workerEffort !== void 0 && this.resolved.workerEffort === void 0) ctx.logger.warn("taskboard: workerEffort \"" + config.workerEffort + "\" is not a supported effort level (off|high|max); falling back to the adapter default");
			if (config.reviewerEffort !== void 0 && this.resolved.reviewerEffort === void 0) ctx.logger.warn("taskboard: reviewerEffort \"" + config.reviewerEffort + "\" is not a supported effort level (off|high|max); falling back to the worker effort / adapter default");
			if (config.masterEffort !== void 0 && this.resolved.masterEffort === void 0) ctx.logger.warn("taskboard: masterEffort \"" + config.masterEffort + "\" is not a supported effort level (off|high|max); leaving the suggestion unset");
			this.domain = ctx.storageDomain.open(TASKBOARD_DOMAIN);
			this.domain.catch(() => {});
			ctx.effect(() => {
				const pending = this.domain;
				return () => {
					pending.then((domain) => {
						domain.close();
					}).catch(() => {});
				};
			}, "taskboard: domain lifetime");
			ctx.effect(() => {
				let inFlight = false;
				const run = () => {
					if (inFlight) return;
					inFlight = true;
					(async () => {
						try {
							await this.reconcileLostWorkers();
							await this.reconcileStaleReviewers();
							await this.reconcileMasterSeats();
						} catch {} finally {
							inFlight = false;
						}
					})();
				};
				this.domain.then(() => {
					setTimeout(run, 0);
				}).catch(() => {});
				const timer = this.resolved.reconcileIntervalMs > 0 ? setInterval(run, this.resolved.reconcileIntervalMs) : void 0;
				return () => {
					if (timer !== void 0) clearInterval(timer);
				};
			}, "taskboard: seat self-healing reconciliation");
			ctx.systemPrompt.section({
				name: "taskboard:master",
				order: 149,
				text: MASTER_SECTION + masterModelNote(this.resolved.masterModel, this.resolved.masterEffort)
			});
			ctx.systemPrompt.section({
				name: "taskboard:workflow",
				order: 150,
				text: WORKFLOW_SECTION
			});
			this.registerTools();
		}
		/** Resolve the opened tickets table. */
		async tickets() {
			return (await this.domain).table("tickets");
		}
		/**
		* Drop one card's run handle when its recorded run settles or the card
		* leaves the in-flight state. Identity-checked: a handle replaced by a
		* newer run for the same card (e.g. an auto-redispatched worker) survives
		* the older run's settlement.
		*/
		clearRunHandle(ticketId, sessionId) {
			const handle = this.runHandles.get(ticketId);
			if (handle !== void 0 && handle.sessionId === sessionId) this.runHandles.delete(ticketId);
		}
		/** Resolve the opened boards table. */
		async boards() {
			return (await this.domain).table("boards");
		}
		/**
		* The effective worker/reviewer model+effort for one board: the board's
		* modelConfig overrides the host config field by field, and a stored
		* effort outside the deepseek vocabulary falls back to the host config
		* (then to the adapter default). Board-level effort values are validated
		* here so a corrupted/out-of-band record degrades instead of failing.
		* @param boardId - the board whose spawns are being resolved.
		*/
		async effectiveModelConfig(boardId) {
			const override = (await this.boards()).get(boardId)?.modelConfig;
			return {
				workerModel: override?.workerModel ?? this.resolved.workerModel,
				workerEffort: resolveEffort(override?.workerEffort) ?? this.resolved.workerEffort,
				reviewerModel: override?.reviewerModel ?? this.resolved.reviewerModel,
				reviewerEffort: resolveEffort(override?.reviewerEffort) ?? this.resolved.reviewerEffort
			};
		}
		/**
		* Build the agentOptions for one spawned child: the model plus the
		* reasoning effort when one is configured. Callers only include this value
		* when the provider advertises the unified agentOptions capability (V3-5).
		* @param model - the effective model id.
		* @param effort - the effective effort level, or undefined for adapter default.
		*/
		static agentOptionsFor(model, effort) {
			return {
				model,
				...effort !== void 0 ? { reasoningEffort: ReasoningEffortId(effort) } : {}
			};
		}
		/**
		* Record one effort capability downgrade on the card's history: a
		* configured reasoning effort was omitted because the spawn provider does
		* not advertise the effort capability, so the child keeps its adapter
		* default (the V3-12 "downgrade, never fail" pattern).
		* @param ticketId - the card whose spawn downgraded.
		* @param role - "worker" or "reviewer".
		* @param effort - the configured effort that was dropped.
		* @param providerName - the provider that cannot honor it.
		*/
		async recordEffortDowngrade(ticketId, role, effort, providerName) {
			await this.mutate(ticketId, "edit", (current) => appendHistory(current, "model-effort-downgrade", role + " reasoning effort \"" + effort + "\" omitted: provider \"" + providerName + "\" does not advertise the effort capability; the child keeps its adapter default"));
		}
		/** Translate storage-layer failures into domain errors. */
		static translate(error, ticketId) {
			if (error instanceof TaskboardError) throw error;
			if (error instanceof DomainError && error.code === "missing-key") throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			throw error;
		}
		/**
		* Run one validated record transform on the domain write chain, then emit
		* the forwarded change event with the committed post-state.
		*/
		async mutate(ticketId, operation, fn) {
			const table = await this.tickets();
			try {
				const next = await table.update(ticketId, fn);
				const change = {
					operation,
					ticketId,
					boardId: next.boardId,
					ticket: next
				};
				this.ctx.emit("taskboard/changed", change);
				return next;
			} catch (error) {
				TaskboardService.translate(error, ticketId);
				/* v8 ignore next -- translate always throws */
				throw error;
			}
		}
		/** Atomically transform one board record; a missing board fails loudly. */
		async mutateBoard(boardId, fn) {
			const table = await this.boards();
			try {
				return await table.update(boardId, fn);
			} catch (error) {
				if (error instanceof DomainError && error.code === "missing-key") throw new TaskboardError("board \"" + boardId + "\" does not exist", "TASKBOARD_BOARD_NOT_FOUND");
				throw error;
			}
		}
		/**
		* Read one board record, lazily materializing the implicit record when the
		* board is absent (the "default" board always exists implicitly). An
		* unseeded materialization lands as a project-shaped unowned board: shared
		* among unowned sessions until the legacy default board is adopted by a
		* real workspace.
		*/
		async ensureBoard(boardId, seed) {
			const table = await this.boards();
			const existing = table.get(boardId);
			if (existing !== void 0) return existing;
			const record = {
				boardId,
				name: seed?.name ?? boardId,
				workspaceId: seed?.workspaceId ?? "",
				scope: seed?.scope ?? "project",
				ownerSessionId: null,
				masterAgentId: null,
				masterClaimedAt: null,
				masterExpiresAt: null,
				handoverNotes: "",
				archivedAt: null,
				masterHistory: [],
				notices: []
			};
			await table.put(boardId, record);
			return record;
		}
		/**
		* Ensure the caller's session-private default board exists, materializing
		* it idempotently under the deterministic id "session-<sessionId>" on the
		* session's first board-surface access. The board is visible only to its
		* owner session; its name is the workspace directory basename when the
		* session resolves one, "session board" otherwise.
		* @param agent - the calling session agent.
		* @param workspace - the caller's resolved workspace, or undefined when unowned.
		* @returns the session's private default board.
		*/
		async ensureSessionDefaultBoard(agent, workspace) {
			const table = await this.boards();
			const boardId = "session-" + agent.id;
			const existing = table.get(boardId);
			if (existing !== void 0) return existing;
			const record = {
				boardId,
				name: workspace === void 0 ? "session board" : basename(workspace.path),
				workspaceId: workspace === void 0 ? "" : workspace.id,
				scope: "session",
				ownerSessionId: agent.id,
				masterAgentId: null,
				masterClaimedAt: null,
				masterExpiresAt: null,
				handoverNotes: "",
				archivedAt: null,
				masterHistory: [],
				notices: []
			};
			await table.put(boardId, record);
			return record;
		}
		/**
		* Resolve the calling session's workspace from its header cwd through the
		* host workspace registry (resolveByPath). A missing registry, a missing
		* cwd, an unresolvable path, or any registry failure falls back to unowned
		* (undefined).
		* @param agent - the calling session agent.
		* @returns the resolved workspace id and canonical path, or undefined when unowned.
		*/
		async workspaceOf(agent) {
			const cwd = agent.session.header.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return void 0;
			const registry = this.ctx.get("workspaceRegistry");
			if (registry === void 0 || typeof registry.resolveByPath !== "function") return void 0;
			try {
				const workspace = await registry.resolveByPath(cwd);
				return workspace === void 0 ? void 0 : {
					id: workspace.id,
					path: workspace.path
				};
			} catch {
				return;
			}
		}
		/**
		* Ensure the caller's default board exists, materializing it per workspace:
		* the first real-workspace access lazily adopts the legacy unowned "default"
		* board (renamed to the workspace directory basename); every later workspace
		* gets a deterministic "default-<workspaceId>" board with the same naming.
		* An unowned caller keeps the legacy implicit "default" board while it stays
		* unowned, and has no default board of its own once a real workspace adopted
		* it (undefined).
		* @param workspaceId - the caller's workspace id, or '' when unowned.
		* @param name - the directory basename to use for a materialized default board.
		* @returns the caller's default board, or undefined when the caller has none.
		*/
		async ensureDefaultBoard(workspaceId, name) {
			const table = await this.boards();
			if (workspaceId === "") {
				const legacy = table.get("default");
				if (legacy === void 0) return this.ensureBoard("default");
				return legacy.workspaceId === "" ? legacy : void 0;
			}
			const legacy = table.get("default");
			if (legacy === void 0 || legacy.workspaceId === "") {
				await this.ensureBoard("default");
				return this.mutateBoard("default", (current) => ({
					...current,
					workspaceId,
					scope: "project",
					ownerSessionId: null,
					...name === void 0 ? {} : { name }
				}));
			}
			if (legacy.workspaceId === workspaceId) return legacy;
			return this.ensureBoard("default-" + workspaceId, {
				workspaceId,
				scope: "project",
				...name === void 0 ? {} : { name }
			});
		}
		/**
		* Materialize one board for a master verb, seeding the implicit "default"
		* board with the caller's workspace when the record is absent. An unseeded
		* materialization would land as a project-shaped ''-workspace board that a
		* workspace session cannot see (TASKBOARD_BOARD_NOT_FOUND), breaking the
		* very next master verb after a fresh-store claim. An existing record is
		* returned untouched, so an adopted or v1 legacy default is never
		* re-stamped.
		* @param boardId - the board to ensure.
		* @param agent - the calling session agent; its workspace seeds a materialized 'default'.
		* @returns the ensured board record.
		*/
		async ensureMasterBoard(boardId, agent) {
			if (boardId !== "default") return this.ensureBoard(boardId);
			const workspace = await this.workspaceOf(agent);
			return this.ensureBoard("default", workspace === void 0 ? void 0 : {
				workspaceId: workspace.id,
				scope: "project",
				name: basename(workspace.path)
			});
		}
		/**
		* True when one board row is visible to a caller. Session-scoped boards are
		* private to their owner session; a session-scoped row WITHOUT an owner is
		* a v1-shaped legacy record and follows the v1 workspace rule (the unowned
		* legacy default is shared everywhere, workspace-tagged rows share within
		* that workspace). A stray ''-workspace legacy row that is NOT the default
		* board is visible to unowned callers only, so it never leaks into any real
		* workspace. Project-scoped boards are shared within their owning workspace
		* ('' matches unowned callers only, so a new unowned project board never
		* leaks into every workspace).
		* @param board - the board row to check.
		* @param sessionId - the caller's session id.
		* @param workspaceId - the caller's workspace id, or '' when unowned.
		*/
		isBoardVisible(board, sessionId, workspaceId) {
			if (board.scope === "session") {
				if (board.ownerSessionId === null) {
					if (board.workspaceId === "" && board.boardId !== "default") return workspaceId === "";
					return board.workspaceId === "" || board.workspaceId === workspaceId;
				}
				return board.ownerSessionId === sessionId;
			}
			return board.workspaceId === workspaceId;
		}
		/**
		* Require one board to be visible to a caller: a record-less board (the
		* implicit default or a legacy implicit board) is unowned and shared, and a
		* recorded board must be visible under the dual-scope rule (session boards
		* only to their owner, project boards only within their workspace). A board
		* outside the caller's scope is denied as not found so its existence is not
		* leaked.
		* @param boardId - the board to check.
		* @param agent - the calling session agent.
		*/
		async assertBoardAccessible(boardId, agent) {
			const board = (await this.boards()).get(boardId);
			if (board === void 0) return;
			const workspace = await this.workspaceOf(agent);
			const workspaceId = workspace === void 0 ? "" : workspace.id;
			if (this.isBoardVisible(board, agent.id, workspaceId)) return;
			throw new TaskboardError("board \"" + boardId + "\" does not exist", "TASKBOARD_BOARD_NOT_FOUND");
		}
		/**
		* Validate the board context of one ticket operation: the requested board
		* must be the ticket's own board. An omitted request falls back to the
		* ticket's own board (v1 callers omit boardId and mean "the ticket's
		* board"), so a client that forgets the field never trips on a ticket
		* living on a non-default board; an explicit wrong board is still rejected.
		*/
		static boardContextOf(requestBoardId, ticket) {
			const requested = requestBoardId ?? ticket.boardId;
			if (ticket.boardId !== requested) throw new TaskboardError("ticket \"" + ticket.id + "\" is on board \"" + ticket.boardId + "\", not \"" + requested + "\"", "TASKBOARD_INVALID_INPUT");
			return ticket.boardId;
		}
		/** Whether the caller currently holds the master seat of the ticket's board. */
		async isMasterOfTicket(ticket, agent) {
			const board = (await this.boards()).get(ticket.boardId);
			return board !== void 0 && board.masterAgentId === agent.id;
		}
		/** Require the caller to be the current master of the ticket's board. */
		async assertMasterOfTicket(ticket, agent) {
			if (!await this.isMasterOfTicket(ticket, agent)) throw new TaskboardError("only the master of board \"" + ticket.boardId + "\" may perform this action", "TASKBOARD_NOT_MASTER");
		}
		/** Require the caller to be the current master of one board (by id). */
		async assertMasterOfBoard(boardId, agent) {
			await this.ensureMasterBoard(boardId, agent);
			const board = (await this.boards()).get(boardId);
			if (board === void 0 || board.masterAgentId !== agent.id) throw new TaskboardError("only the master of board \"" + boardId + "\" may perform this action", "TASKBOARD_NOT_MASTER");
		}
		/**
		* Compute the position of an index inside a column following the same
		* halving semantics as {@link positionBetween}: the target slot sits
		* between the (index-1)-th and the index-th neighbors of the column.
		*/
		positionAtIndex(table, column, selfId, index) {
			const rows = [...table.entries()].map(([, ticket]) => ticket).filter((ticket) => ticket.column === column && ticket.id !== selfId).sort((a, b) => a.position - b.position);
			const target = Math.min(index, rows.length);
			const before = target > 0 ? rows[target - 1] : void 0;
			const after = target < rows.length ? rows[target] : void 0;
			if (before !== void 0 && after !== void 0) return (before.position + after.position) / 2;
			if (before !== void 0) return before.position + 1;
			if (after !== void 0) return after.position - 1;
			return 0;
		}
		/** Compute the position between two anchors inside a column. */
		positionBetween(table, column, beforeTicketId, afterTicketId) {
			const rows = [...table.entries()].map(([, ticket]) => ticket).filter((ticket) => ticket.column === column).sort((a, b) => a.position - b.position);
			const before = beforeTicketId === null ? void 0 : table.get(beforeTicketId);
			const after = afterTicketId === null ? void 0 : table.get(afterTicketId);
			if (before !== void 0 && before.column !== column) throw new TaskboardError("anchor ticket \"" + before.id + "\" is not in column \"" + column + "\"", "TASKBOARD_INVALID_INPUT");
			if (after !== void 0 && after.column !== column) throw new TaskboardError("anchor ticket \"" + after.id + "\" is not in column \"" + column + "\"", "TASKBOARD_INVALID_INPUT");
			if (before !== void 0) {
				const index = rows.findIndex((ticket) => ticket.id === before.id);
				const previous = index > 0 ? rows[index - 1] : void 0;
				return ((previous === void 0 ? before.position - 2 : previous.position) + before.position) / 2;
			}
			if (after !== void 0) {
				const index = rows.findIndex((ticket) => ticket.id === after.id);
				const next = index >= 0 && index + 1 < rows.length ? rows[index + 1] : void 0;
				const nextPosition = next === void 0 ? after.position + 2 : next.position;
				return (after.position + nextPosition) / 2;
			}
			const last = rows[rows.length - 1];
			return last === void 0 ? 0 : last.position + 1;
		}
		/** Validate the dependency edge set of one request against the live board. */
		validateDependencies(table, selfId, dependsOn) {
			const seen = new Set(dependsOn);
			if (seen.size !== dependsOn.length) throw new TaskboardError("dependsOn lists a ticket more than once", "TASKBOARD_INVALID_INPUT");
			if (seen.has(selfId)) throw new TaskboardError("a ticket cannot depend on itself", "TASKBOARD_DEPENDENCY_CYCLE");
			for (const dependencyId of dependsOn) if (table.get(dependencyId) === void 0) throw new TaskboardError("unknown dependency ticket \"" + dependencyId + "\"", "TASKBOARD_DEPENDENCY_UNKNOWN");
			const queue = [...dependsOn];
			const visited = /* @__PURE__ */ new Set();
			while (queue.length > 0) {
				const current = queue.pop();
				if (current === selfId) throw new TaskboardError("dependsOn would create a dependency cycle", "TASKBOARD_DEPENDENCY_CYCLE");
				if (visited.has(current)) continue;
				visited.add(current);
				const ticket = table.get(current);
				if (ticket === void 0) continue;
				for (const transitive of ticket.dependsOn) queue.push(transitive);
			}
		}
		/**
		* Whether the seam and the configured provider can establish a durable
		* continuable child (V3-28). The seam method is the service capability and
		* the provider's `prepareContinuable` (method presence) is the provider
		* capability — the same signal the service itself uses to admit a
		* continuable start. An unadvertised provider keeps the historic permissive
		* stance: an unregistered provider fails either start path.
		*/
		static supportsContinuable(subagents, providerName) {
			if (typeof subagents.startContinuable !== "function") return false;
			const provider = typeof subagents.getProvider === "function" ? subagents.getProvider(providerName) : void 0;
			return provider === void 0 || typeof provider.prepareContinuable === "function";
		}
		/**
		* Start one child through the subagent seam, preferring the continuable path
		* (V3-28): startContinuable establishes a durable child session that can be
		* woken after a disconnect or restart instead of being re-spawned with an
		* empty context. Providers that cannot establish continuable children keep
		* the historic one-shot start().
		*
		* The continuable spec deliberately omits label/signal/outputSchema: the
		* manager persists the label from the spec, owns the child's own signal, and
		* structured output is a one-shot-only capability (subagent descriptor.ts),
		* so a single request object can never carry both contracts.
		* @param subagents - the resolved subagent seam.
		* @param providerName - the provider for this child.
		* @param request - the one-shot-shaped delegation request.
		* @returns the child session id, the one-shot run handle when there is one,
		*   and whether the child is continuable.
		*/
		async startChild(subagents, providerName, request) {
			if (!TaskboardService.supportsContinuable(subagents, providerName)) {
				const run = await subagents.start(providerName, request);
				return {
					sessionId: run.id,
					run,
					continuable: false
				};
			}
			const spec = {
				provider: providerName,
				label: request.label ?? "",
				request: {
					prompt: request.prompt,
					parent: request.parent,
					...request.agentOptions === void 0 ? {} : { agentOptions: request.agentOptions },
					...request.maxDepth === void 0 ? {} : { maxDepth: request.maxDepth },
					...request.toolFilter === void 0 ? {} : { toolFilter: request.toolFilter },
					...request.persona === void 0 ? {} : { persona: request.persona }
				},
				signal: request.signal
			};
			return {
				sessionId: (await subagents.startContinuable(spec)).childId,
				run: void 0,
				continuable: true
			};
		}
		/**
		* Spawn the reviewer child for one ticket through the subagent seam. In
		* "report" mode the child only inspects and returns a structured verdict
		* ({ verdict, summary, problems }) — it is denied the card-mutating review
		* tools and the master resolves the review with taskboard_resolve_review.
		* In "direct" mode the v1 contract holds: the reviewer itself calls
		* taskboard_approve / taskboard_reject.
		*/
		async spawnReviewer(parent, ticket) {
			const subagents = this.ctx.get("subagents");
			if (subagents === void 0) return {
				spawned: false,
				reason: "unavailable"
			};
			try {
				const reportMode = this.resolved.reviewMode === "report";
				const capabilities = (typeof subagents.getProvider === "function" ? subagents.getProvider(this.resolved.reviewProvider) : void 0)?.capabilities;
				const supportsOutputSchema = capabilities === void 0 || capabilities.outputSchema;
				const supportsToolFilter = capabilities === void 0 || capabilities.toolFilter;
				const supportsAgentOptions = capabilities === void 0 || capabilities.agentOptions;
				const continuable = TaskboardService.supportsContinuable(subagents, this.resolved.reviewProvider);
				const verdictViaTool = reportMode && continuable;
				const basePrompt = reportMode ? buildReviewReportPrompt(ticket, void 0, verdictViaTool) : buildReviewPrompt(ticket);
				const prompt = [{
					type: "text",
					text: reportMode && !verdictViaTool && !supportsOutputSchema ? basePrompt + "\n\n[Note: the configured provider does not support structured output; return your verdict (approve or reject) with a summary and problems as plain text in your final message.]" : basePrompt
				}];
				const controller = new AbortController();
				const modelCfg = await this.effectiveModelConfig(ticket.boardId);
				const droppedReviewerEffort = modelCfg.reviewerEffort;
				const effortDowngraded = droppedReviewerEffort !== void 0 && !supportsAgentOptions;
				const request = {
					label: "review " + ticket.id,
					prompt,
					parent,
					signal: controller.signal,
					...supportsAgentOptions ? { agentOptions: TaskboardService.agentOptionsFor(modelCfg.reviewerModel, modelCfg.reviewerEffort) } : {},
					...reportMode && !verdictViaTool && supportsOutputSchema ? { outputSchema: REVIEW_OUTCOME_SCHEMA } : {},
					...reportMode && supportsToolFilter ? { toolFilter: { deny: REVIEWER_DENIED_TOOLS } } : {}
				};
				const started = await this.startChild(subagents, this.resolved.reviewProvider, request);
				if (effortDowngraded) {
					await this.recordEffortDowngrade(ticket.id, "reviewer", droppedReviewerEffort, this.resolved.reviewProvider).catch(() => {});
					this.ctx.logger.info("taskboard: reviewer effort \"" + droppedReviewerEffort + "\" downgraded for ticket " + ticket.id + ": provider \"" + this.resolved.reviewProvider + "\" does not advertise the agentOptions capability");
				}
				return {
					spawned: true,
					reviewer: {
						agentId: started.sessionId,
						label: reviewerLabel(started.sessionId)
					},
					run: started.run,
					controller,
					continuable: started.continuable
				};
			} catch (error) {
				return {
					spawned: false,
					reason: "failed",
					errorMessage: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/**
		* Attach the reviewer-run settlement listener: when the report-mode child
		* settles with a structured verdict, write it back onto the card. Only the
		* reviewer the card currently names may write; the run never rejects (a
		* model error resolves with stopReason "error"), so the rejection arm is a
		* defensive no-op.
		*/
		trackReviewerRun(ticketId, sessionId, run, controller) {
			this.runHandles.set(ticketId, {
				sessionId,
				run,
				controller
			});
			if (run === void 0) return;
			const result = run.result;
			if (result === void 0) return;
			result.then((outcome) => {
				this.recordReviewOutcome(ticketId, sessionId, outcome).catch(() => {});
			}, () => {});
		}
		/** Persist the structured reviewer report when the settled run produced one. */
		async recordReviewOutcome(ticketId, sessionId, outcome) {
			this.clearRunHandle(ticketId, sessionId);
			const structured = outcome.structured;
			if (structured === void 0 || !isReviewOutcome(structured)) return;
			await this.landReviewOutcome(ticketId, sessionId, structured);
		}
		/**
		* Land one reviewer-reported verdict on the card and notify the master. The
		* two report channels converge here: the one-shot structured-output capture
		* (the settled run's `structured` value) and, for a continuable reviewer
		* (V3-28), the taskboard_review_verdict tool the reviewer itself calls.
		* Identity checked either way: only the reviewer the card currently names,
		* while the card is still In testing, can land a verdict.
		*/
		async landReviewOutcome(ticketId, sessionId, structured) {
			let landed = false;
			const next = await this.mutate(ticketId, "review-claim", (current) => {
				if (current.reviewer === null || current.reviewer.agentId !== sessionId) return current;
				if (current.column !== "in_testing") return current;
				landed = true;
				return {
					...current,
					reviewOutcome: {
						verdict: structured.verdict,
						summary: structured.summary,
						problems: structured.problems,
						at: Date.now()
					},
					updatedAt: Date.now()
				};
			});
			if (landed) await this.notifyMaster(next.boardId, "Taskboard notice: " + formatCompactEvent("REVIEW_VERDICT", {
				ticket: next.id,
				title: next.title,
				state: compactCardState(next),
				scope: next.filesScope,
				verdict: structured.verdict,
				...structured.problems.length === 0 ? {} : { anomaly: structured.problems.join(" | ") }
			}) + ". Adjudicate with taskboard_resolve_review.", NOTICE_KIND.reviewVerdict, next.id);
		}
		/**
		* Report one reviewer verdict from a continuable reviewer session (V3-28).
		* A durable reviewer child cannot carry an outputSchema — structured output
		* is a one-shot-only subagent capability — so instead of the
		* structured-output capture it calls the taskboard_review_verdict tool,
		* which lands the same { verdict, summary, problems } report through the one
		* landing path. The reviewer still never decides the card: the master
		* resolves it with taskboard_resolve_review.
		* @param agent - the reviewer session agent.
		* @param ticketId - the In testing ticket under review.
		* @param verdict - 'approve' or 'reject'.
		* @param summary - what the reviewer inspected and concluded.
		* @param problems - concrete rework items (empty when approving).
		* @returns the card with reviewOutcome recorded.
		*/
		async submitReviewVerdict(agent, ticketId, verdict, summary, problems) {
			if (!REVIEW_VERDICTS.includes(verdict)) throw new TaskboardError("reviewer verdict must be \"approve\" or \"reject\"", "TASKBOARD_INVALID_INPUT");
			const notes = resolveRequiredText(summary, "reviewer summary");
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			if (current.column !== "in_testing" || current.reviewer === null || current.reviewer.agentId !== agent.id) throw new TaskboardError("ticket \"" + ticketId + "\" is not under review by session \"" + agent.id + "\"", "TASKBOARD_NOT_REVIEWER");
			const items = (Array.isArray(problems) ? problems : []).map((problem) => typeof problem === "string" ? problem.trim() : "").filter((problem) => problem !== "");
			await this.landReviewOutcome(ticketId, agent.id, {
				verdict,
				summary: notes,
				problems: items
			});
			return (await this.tickets()).get(ticketId) ?? current;
		}
		/**
		* Follow up the original worker after a rejection (打回原窗口). The worker
		* is addressed through the live Agent registry. This is best-effort: when
		* the session is no longer live the master re-dispatches with
		* taskboard_reassign.
		*/
		async followupWorker(master, ticket, feedback) {
			if (ticket.workerSessionId === void 0) return "none";
			const worker = this.ctx.agents.get(ticket.workerSessionId);
			if (worker === void 0) return "unavailable";
			try {
				const content = [{
					type: "text",
					text: [
						"The reviewer rejected taskboard ticket " + ticket.id + " (\"" + ticket.title + "\").",
						"",
						"Rework feedback:",
						feedback,
						"",
						"Fix the issues above, then finish with EXACTLY ONE call to taskboard_report with ticketId \"" + ticket.id + "\" and devNotes summarizing the rework."
					].join("\n")
				}];
				worker.followup(createUserMessage({
					content,
					source: {
						kind: "taskboard",
						boardId: ticket.boardId,
						form: "relay",
						senderSessionId: master.id
					}
				}));
				return "sent";
			} catch {
				return "unavailable";
			}
		}
		/**
		* Best-effort worker-session archive when a card lands in Done: the host's
		* workspace registry hides archived sessions from the grouping surfaces. A
		* missing registry, an unknown session, or a storage fault is not an error
		* — the resolution still succeeds and the result reports archived=false.
		*/
		async archiveWorkerSession(ticket) {
			if (ticket.workerSessionId === void 0) return false;
			const registry = this.ctx.get("workspaceRegistry");
			if (registry === void 0 || typeof registry.archiveSession !== "function") return false;
			try {
				await registry.archiveSession(ticket.workerSessionId);
				return true;
			} catch {
				return false;
			}
		}
		/**
		* Spawn the worker child for one ticket and attach termination
		* reclamation to its run result.
		* @param parent - the master session agent the child spawns under.
		* @param ticket - the card being dispatched.
		* @param workerLabel - optional display label for the worker child.
		* @param preflight - the V3-20 dispatch-time preflight report; when present
		* its raw facts (canonical base, assigned worktree, actual branch, HEAD,
		* dirty list, base/candidate relationship) are inlined into the worker
		* prompt so the worker starts from deterministic facts. Auto-redispatch
		* (liveness recovery) passes none — its working tree is dirty by design.
		*/
		async spawnWorker(parent, ticket, workerLabel, preflight) {
			const subagents = this.ctx.get("subagents");
			if (subagents === void 0) return {
				ok: false,
				reason: "unavailable"
			};
			try {
				const cwd = parent.session.header.cwd;
				const capabilities = (typeof subagents.getProvider === "function" ? subagents.getProvider(this.resolved.workerProvider) : void 0)?.capabilities;
				const supportsToolFilter = capabilities === void 0 || capabilities.toolFilter;
				const supportsAgentOptions = capabilities === void 0 || capabilities.agentOptions;
				const controller = new AbortController();
				const modelCfg = await this.effectiveModelConfig(ticket.boardId);
				const droppedWorkerEffort = modelCfg.workerEffort;
				const effortDowngraded = droppedWorkerEffort !== void 0 && !supportsAgentOptions;
				const request = {
					label: workerLabel ?? ticket.title,
					prompt: [{
						type: "text",
						text: preflight === void 0 ? buildWorkerPrompt(ticket, cwd, parent.id) : buildWorkerPrompt(ticket, cwd, parent.id) + "\n" + preflightPromptSection(preflight)
					}],
					parent,
					signal: controller.signal,
					...supportsAgentOptions ? { agentOptions: TaskboardService.agentOptionsFor(modelCfg.workerModel, modelCfg.workerEffort) } : {},
					...supportsToolFilter ? { toolFilter: { deny: WORKER_DENIED_TOOLS } } : {}
				};
				const started = await this.startChild(subagents, this.resolved.workerProvider, request);
				if (effortDowngraded) {
					await this.recordEffortDowngrade(ticket.id, "worker", droppedWorkerEffort, this.resolved.workerProvider).catch(() => {});
					this.ctx.logger.info("taskboard: worker effort \"" + droppedWorkerEffort + "\" downgraded for ticket " + ticket.id + ": provider \"" + this.resolved.workerProvider + "\" does not advertise the agentOptions capability");
				}
				return {
					ok: true,
					sessionId: started.sessionId,
					run: started.run,
					controller,
					continuable: started.continuable
				};
			} catch (error) {
				return {
					ok: false,
					reason: "failed",
					errorMessage: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/**
		* Reclaim a card whose worker session settled without reporting: the card
		* is still In progress and still owned by that session, so the worker was
		* terminated mid-flight.
		*/
		trackWorkerRun(ticketId, sessionId, run, controller) {
			this.runHandles.set(ticketId, {
				sessionId,
				run,
				controller
			});
			if (run === void 0) return;
			const result = run.result;
			if (result === void 0) return;
			result.then((outcome) => {
				this.reclaimTerminatedWorker(ticketId, sessionId, outcome.stopReason).catch(() => {});
			}, () => {
				this.reclaimTerminatedWorker(ticketId, sessionId, "error").catch(() => {});
			});
		}
		/** Mark a card blocked when its worker session ended without reporting. */
		async reclaimTerminatedWorker(ticketId, sessionId, stopReason) {
			this.clearRunHandle(ticketId, sessionId);
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) return;
			if (current.workerSessionId !== sessionId) return;
			if (current.column !== "in_progress" || current.status !== "running") return;
			await this.recoverLostWorker(current, "worker terminated (" + stopReason + ")");
		}
		/**
		* The durable failure reason the worker-liveness reconciliation records
		* when a lost worker cannot be auto-redispatched, distinct from the
		* settlement-callback reason ('worker terminated (<stopReason>)') so the
		* two reclaim paths never double-report one termination with two different
		* reasons.
		*/
		static RECONCILE_REASON = "worker terminated (restart reconciliation)";
		/**
		* The last observed activity of one live agent: the timestamp of its last
		* session event, falling back to the session creation time when the log is
		* empty. The session event log is the durable activity authority — a worker
		* appends a row on every turn/tool activity, so a session whose tail is
		* older than the idle threshold has genuinely been silent, not merely idle
		* between turns.
		*/
		static lastActivityOf(agent) {
			const events = agent.session.snapshotEvents();
			return (events.length > 0 ? events[events.length - 1]?.time : void 0) ?? agent.session.header.createdAt;
		}
		/**
		* Judge one running card's worker liveness: 'lost' when the session is
		* absent from the registry (restart / hard death) or when it is still
		* registered but idle — no running tool — and has had no session activity
		* for longer than lostWorkerTimeoutMs (stuck). 'alive' otherwise. The
		* idle-staleness arm is disabled when the timeout is 0; the
		* registry-absence arm is not configurable (a missing session is always
		* lost, per the restart rule).
		*/
		workerLost(registry, sessionId) {
			const agent = registry.get(sessionId);
			if (agent === void 0) return true;
			if (this.resolved.lostWorkerTimeoutMs === 0) return false;
			if (agent.status === "running") return false;
			return Date.now() - TaskboardService.lastActivityOf(agent) > this.resolved.lostWorkerTimeoutMs;
		}
		/**
		* The live agent registry, or undefined when the host exposes none. The
		* registry is the liveness authority for every seat: presence means alive
		* (an idle agent is still alive; only an unregistered session is gone).
		*/
		agentRegistry() {
			const registry = this.ctx.agents;
			if (registry === void 0 || typeof registry.get !== "function") return void 0;
			return registry;
		}
		/**
		* Judge whether one session still holds its seat — the single liveness
		* judgment shared by the master seat and the reviewer seat (V3-43): a seat
		* is held while its holder session exists anywhere. (1) A session present in
		* the live agent registry is alive, whatever the store says. (2) Otherwise
		* the host's own session persistence is the authority — the canonical "does
		* this session exist" query (stat/session-reference shape), never a clock, a
		* poll, or a cache of our own — and only a definite `undefined` answer
		* proves the record is gone, i.e. the session was deleted or cleaned up.
		*
		* Registry absence is therefore never a release on its own: a session the
		* host merely unloaded from its live registry (a host restart, idle
		* eviction) still has its stored session log, so it keeps the seat and
		* resumes its work on its next turn. That includes a report-mode reviewer,
		* which is a durable continuable child normally sitting in the session store
		* rather than the live registry — judging that normal state as death was the
		* V3-42 release/redispatch loop. Seat ownership follows the *session*, not
		* the process and not a clock (V3-32 keeps the wall-clock arm deleted): an
		* idle registered holder still keeps the seat however silent it is.
		*
		* The judgment fails closed (the seat counts as held) without a registry,
		* without a persistence seam able to answer the existence question, or when
		* the probe itself faults — none of those can prove the record is gone.
		* @param sessionId - the seat holder's session id.
		* @returns whether the holder session still exists (true keeps the seat).
		*/
		async sessionHoldsSeat(sessionId) {
			const registry = this.agentRegistry();
			if (registry === void 0) return true;
			if (registry.get(sessionId) !== void 0) return true;
			const persistence = this.ctx.get("sessionPersistence");
			if (persistence === void 0 || typeof persistence.stat !== "function") return true;
			try {
				return await persistence.stat(sessionId) !== void 0;
			} catch {
				return true;
			}
		}
		/**
		* Wake one lost worker's durable session instead of re-spawning it (V3-28).
		* The continuation message carries the ticket identity, the acceptance
		* criteria, the recorded progress and the standing "do not roll back"
		* instruction, and sendMessage delivers it to the exact child session the
		* card records: a running child admits it at the nearest step boundary, an
		* idle child starts a turn, and an absent child cold-resumes from
		* persistence.
		*
		* The sender is the live master Agent (`board.masterAgentId` from the
		* registry) — sendMessage requires an exact live direct parent, but not a
		* master *turn*, so the automatic recovery path can wake without one.
		* Fail-closed: every refusal (no seam method, no live master, a worker
		* dispatched before V3-28 whose session carries no continuation state, or a
		* provider that cannot resume) is returned as a detail so the caller falls
		* back to the historic re-spawn.
		* @returns woken once the message was accepted by the child's inbox.
		*/
		async wakeWorker(master, ticket, reason) {
			const subagents = this.ctx.get("subagents");
			if (subagents === void 0) return {
				woken: false,
				detail: "the subagent seam is unavailable"
			};
			if (typeof subagents.sendMessage !== "function") return {
				woken: false,
				detail: "the subagent seam exposes no continuable sendMessage"
			};
			const sessionId = ticket.workerSessionId ?? ticket.workerAgentId;
			if (sessionId === void 0) return {
				woken: false,
				detail: "the card records no worker session"
			};
			const content = [{
				type: "text",
				text: buildContinuationPrompt(ticket, reason)
			}];
			try {
				await subagents.sendMessage(master, sessionId, content, { signal: new AbortController().signal });
			} catch (error) {
				return {
					woken: false,
					detail: error instanceof Error ? error.message : String(error)
				};
			}
			return { woken: true };
		}
		/**
		* One lost-worker recovery: auto-redispatch a fresh worker while the
		* per-card budget lasts and a live master session exists to spawn from,
		* otherwise mark the card blocked. Shared by the settlement callback
		* (mid-flight death) and the liveness reconciliation (registry-absent or
		* idle-stale) so both paths converge on one deduped recovery.
		*
		* Auto-redispatch keeps the card running with a new worker session, clears
		* the failure record, appends the "续做勿回滚" annotation to the card
		* description (the next worker's prompt inlines it, so it continues the
		* existing working tree instead of rolling back), writes one 'reassign'
		* history row and notifies the master. Blocking writes one 'fail' row and
		* notifies the master that manual taskboard_reassign is needed.
		*
		* Reentry-safe: the guarded mutate re-checks column/status/worker identity
		* atomically, so a card another path already recovered is returned
		* untouched and exactly one recovery ever lands per loss.
		* V3-28: before spending a fresh spawn the recovery tries to WAKE the
		* durable worker session (see {@link wakeWorker}). A successful wake keeps
		* the card running with the same worker session — its context and working
		* tree survive — and only a refusal falls through to the re-spawn below.
		* @returns 'continued' | 'redispatched' | 'blocked' | 'skipped'
		*/
		async recoverLostWorker(ticket, reason) {
			const registry = this.ctx.agents;
			if (registry === void 0 || typeof registry.get !== "function") return "skipped";
			const sessionId = ticket.workerSessionId ?? ticket.workerAgentId;
			if (sessionId === void 0) return "skipped";
			if (ticket.autoRetries >= this.resolved.workerAutoRetryLimit) return this.blockLostWorker(ticket, reason, "worker lost after " + ticket.autoRetries + " automatic redispatch attempts (cap " + this.resolved.workerAutoRetryLimit + ")");
			const masterId = (await this.boards()).get(ticket.boardId)?.masterAgentId;
			const master = masterId === void 0 || masterId === null ? void 0 : registry.get(masterId);
			if (master === void 0) return this.blockLostWorker(ticket, reason, TaskboardService.RECONCILE_REASON + " (no live master session to auto-redispatch)");
			const attempt = ticket.autoRetries + 1;
			const wake = await this.wakeWorker(master, ticket, reason);
			if (wake.woken) {
				let continued = false;
				let woken;
				try {
					woken = await this.mutate(ticket.id, "reassign", (current) => {
						if (current.column !== "in_progress" || current.status !== "running") return current;
						if ((current.workerSessionId ?? current.workerAgentId) !== sessionId) return current;
						continued = true;
						return appendHistory({
							...current,
							status: "running",
							failure: null,
							autoRetries: attempt,
							description: current.description.trim() === "" ? `[auto-continue #${attempt}] 续做勿回滚：the existing worker session was woken; continue from the preserved working tree.` : `${current.description}\n\n[auto-continue #${attempt}] 续做勿回滚：the existing worker session was woken; continue from the preserved working tree.`,
							updatedAt: Date.now()
						}, "reassign", "woken to continue after " + reason);
					});
				} catch {
					return "skipped";
				}
				if (!continued) return "skipped";
				await this.notifyMaster(woken.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_CONTINUED", {
					ticket: woken.id,
					title: woken.title,
					state: compactCardState(woken),
					scope: woken.filesScope,
					anomaly: `lost (${reason}); woke the existing worker session (attempt ${attempt} of ${this.resolved.workerAutoRetryLimit}); its context and working tree are preserved`
				}), NOTICE_KIND.workerContinued, woken.id);
				return "continued";
			}
			const spawn = await this.spawnWorker(master, ticket, "auto-redispatch " + attempt + " " + ticket.title);
			if (!spawn.ok) {
				const failureReason = spawn.reason === "failed" && spawn.errorMessage !== void 0 ? "auto-redispatch spawn failed: " + spawn.errorMessage : "auto-redispatch spawn " + spawn.reason;
				return this.blockLostWorker(ticket, reason, failureReason);
			}
			let applied = false;
			let next;
			try {
				next = await this.mutate(ticket.id, "reassign", (current) => {
					if (current.column !== "in_progress" || current.status !== "running") return current;
					if ((current.workerSessionId ?? current.workerAgentId) !== sessionId) return current;
					applied = true;
					return appendHistory({
						...current,
						status: "running",
						failure: null,
						autoRetries: attempt,
						workerAgentId: spawn.sessionId,
						workerSessionId: spawn.sessionId,
						description: current.description.trim() === "" ? "[auto-redispatch #" + attempt + "] 续做勿回滚：previous worker lost; continue from the preserved working tree." : current.description + "\n\n[auto-redispatch #" + attempt + "] 续做勿回滚：previous worker lost; continue from the preserved working tree.",
						updatedAt: Date.now()
					}, "reassign", "auto-redispatched after " + reason);
				});
			} catch {
				return "skipped";
			}
			if (!applied) return "skipped";
			this.trackWorkerRun(ticket.id, spawn.sessionId, spawn.run, spawn.controller);
			await this.notifyMaster(next.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_REDISPATCHED", {
				ticket: next.id,
				title: next.title,
				state: compactCardState(next),
				scope: next.filesScope,
				anomaly: `lost (${reason}); auto-redispatched (attempt ${attempt} of ${this.resolved.workerAutoRetryLimit}); working tree preserved — the new worker continues without rolling back; wake refused (${wake.detail})`
			}), NOTICE_KIND.workerRedispatched, next.id);
			return "redispatched";
		}
		/**
		* Terminal lost-worker recovery: mark the card blocked with one durable
		* failure row and a master notice (the V3-13 fallback when auto-redispatch
		* is impossible or the per-card budget is exhausted). Reentry-safe like
		* {@link recoverLostWorker}: the guarded mutate only applies to a card that
		* still names the same worker session and is still running.
		*/
		async blockLostWorker(ticket, reason, detail) {
			let marked = false;
			let next;
			try {
				next = await this.mutate(ticket.id, "fail", (current) => {
					if (current.column !== "in_progress" || current.status !== "running") return current;
					if ((current.workerSessionId ?? current.workerAgentId) !== (ticket.workerSessionId ?? ticket.workerAgentId)) return current;
					marked = true;
					return appendHistory({
						...current,
						status: "blocked",
						failure: {
							reason: detail,
							at: Date.now()
						},
						updatedAt: Date.now()
					}, "fail", detail);
				});
			} catch {
				return "skipped";
			}
			if (!marked) return "skipped";
			await this.notifyMaster(next.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_LOST", {
				ticket: next.id,
				title: next.title,
				state: compactCardState(next),
				scope: next.filesScope,
				blocker: detail,
				anomaly: "lost (" + reason + ")"
			}) + ". Re-dispatch with taskboard_reassign.", NOTICE_KIND.workerLost, next.id);
			return "blocked";
		}
		/**
		* One worker-liveness reconciliation pass: every In progress/running card
		* whose worker is lost — absent from the live agent registry (restart /
		* hard death) or registered but idle with no activity past the configured
		* timeout — is recovered through {@link recoverLostWorker}: auto-redispatch
		* while the per-card budget lasts, block with a master notice once
		* exhausted. Shared by the startup scan and the periodic scanner.
		*
		* Liveness authority research (service dependency surface): the agent
		* registry is the exact "is this session's agent alive right now" authority
		* — agents.get(id) returns the live Agent or undefined; presence means
		* live (an idle agent is still alive, only an unregistered session is
		* lost), which is precisely the restart scenario where the in-memory run
		* settlement callbacks are gone. The session event log supplies the
		* activity tail for the idle-staleness arm. The subagent seam's
		* listChildren / listDescendants are parent-rooted tree listings that
		* throw without a mounted projection registry + session store, and the
		* session store tracks persisted sessions rather than live agent loops —
		* neither is a general flat liveness probe, so the registry is used
		* directly, and a missing registry (never in the host, where 'agents' is
		* an injected dependency) degrades to a silent skip without blocking
		* anything.
		*
		* Idempotent by construction and coexistent with the settlement callback:
		* only running cards are considered, and the guarded recovery re-checks
		* column/status/worker identity atomically on the committed record, so a
		* card the settlement callback already recovered (or whose worker came
		* back) is returned untouched — exactly one recovery ever lands per card.
		* @returns how many cards this pass recovered (redispatched or blocked).
		*/
		async reconcileLostWorkers() {
			const registry = this.agentRegistry();
			if (registry === void 0) return 0;
			const table = await this.tickets();
			let recovered = 0;
			for (const [, ticket] of table.entries()) {
				if (ticket.column !== "in_progress" || ticket.status !== "running") continue;
				const sessionId = ticket.workerSessionId ?? ticket.workerAgentId;
				if (sessionId === void 0) continue;
				if (!this.workerLost(registry, sessionId)) continue;
				const agent = registry.get(sessionId);
				const reason = agent === void 0 ? "no longer a live session (absent from the agent registry, e.g. after a restart)" : "idle with no activity for " + Math.round((Date.now() - TaskboardService.lastActivityOf(agent)) / 1e3) + "s";
				if (await this.recoverLostWorker(ticket, reason).catch(() => "skipped") !== "skipped") recovered += 1;
			}
			return recovered;
		}
		/**
		* One reviewer-staleness reconciliation pass: every In testing card that
		* still has a review seat but no reviewOutcome is judged by the *shared*
		* session-liveness rule (V3-43, {@link sessionHoldsSeat} — the same judgment
		* the master seat uses) plus the review-start clock:
		* - the seat is lost only when the holder session is gone for good — absent
		*   from the live agent registry *and* holding no stored session record.
		*   Registry absence alone releases nothing: a report-mode reviewer is a
		*   durable continuable child that normally lives in the session store
		*   (ready) rather than the live registry, and the old registry-only reading
		*   of that normal state as death was the V3-42 release/redispatch loop;
		* - a reviewer that is *registered* but idle — no running tool — with the
		*   review pending longer than reviewerStaleTimeoutMs is judged stuck and
		*   the seat is released. Staleness never applies to a holder that is only
		*   stored (there is no live session to judge idle).
		* On release the card history gets one 'review-release' row, the master is
		* notified, and a fresh reviewer is auto-redispatched when a live master
		* session exists to spawn from; otherwise the seat is left vacant so
		* taskboard_claim_review can take it.
		*
		* Loop brake (V3-43): the release/redispatch cycle is capped per card at
		* reviewerAutoRetryLimit, mirroring the worker's workerAutoRetryLimit. Once
		* the budget is spent the seat is still released, but instead of spawning
		* yet another reviewer the card is blocked with the concrete reason and a
		* master notice — so no future liveness fault can turn into an unbounded
		* release/redispatch loop.
		*
		* Reentry-safe: the guarded mutate only releases a seat that still names
		* the same reviewer and is still In testing without an outcome, so a card
		* another path already released (or resolved) is returned untouched.
		* @returns how many seats this pass released.
		*/
		async reconcileStaleReviewers() {
			const registry = this.agentRegistry();
			if (registry === void 0) return 0;
			const table = await this.tickets();
			let released = 0;
			for (const [, ticket] of table.entries()) {
				if (ticket.column !== "in_testing" || ticket.reviewer === null) continue;
				if (ticket.reviewOutcome !== null) continue;
				const seatedReviewer = ticket.reviewer;
				const reviewerAgent = registry.get(seatedReviewer.agentId);
				const seatLost = !await this.sessionHoldsSeat(seatedReviewer.agentId);
				const stale = !seatLost && reviewerAgent !== void 0 && this.resolved.reviewerStaleTimeoutMs > 0 && reviewerAgent.status !== "running" && Date.now() - TaskboardService.lastActivityOf(reviewerAgent) > this.resolved.reviewerStaleTimeoutMs;
				if (!seatLost && !stale) continue;
				const cap = this.resolved.reviewerAutoRetryLimit;
				const used = ticket.reviewerRetries ?? 0;
				const exhausted = used >= cap;
				const masterId = (await this.boards()).get(ticket.boardId)?.masterAgentId;
				const master = masterId === void 0 || masterId === null ? void 0 : registry.get(masterId);
				const redispatches = !exhausted && master !== void 0;
				const capReason = "reviewer seat lost after " + used + " automatic re-review attempts (cap " + cap + "); awaiting the master";
				const releaseDetail = seatLost ? "review seat released: reviewer session lost" : "review seat released: reviewer stale";
				let marked = false;
				let next;
				try {
					next = await this.mutate(ticket.id, exhausted ? "fail" : "review-release", (current) => {
						if (current.column !== "in_testing" || current.reviewer === null) return current;
						if (current.reviewer.agentId !== seatedReviewer.agentId) return current;
						if (current.reviewOutcome !== null) return current;
						marked = true;
						return appendHistory({
							...current,
							reviewer: null,
							...redispatches ? { reviewerRetries: used + 1 } : {},
							...exhausted ? {
								status: "blocked",
								failure: {
									reason: capReason,
									at: Date.now()
								}
							} : {},
							updatedAt: Date.now()
						}, exhausted ? "fail" : "review-release", exhausted ? capReason : releaseDetail);
					});
				} catch {
					continue;
				}
				if (!marked) continue;
				released += 1;
				if (exhausted) {
					await this.notifyMaster(next.boardId, "Taskboard notice: " + formatCompactEvent("REVIEWER_RELEASED", {
						ticket: next.id,
						title: next.title,
						state: compactCardState(next),
						scope: next.filesScope,
						blocker: capReason,
						anomaly: "review seat released: reviewer " + (seatLost ? "session is gone" : "was idle without a verdict for too long") + "; automatic re-review budget exhausted (cap " + cap + ") — the card is blocked awaiting the master; re-review from the board (request review) or taskboard_claim_review"
					}), NOTICE_KIND.reviewerReleased, next.id);
					continue;
				}
				const releasedTicket = next;
				let reseated = false;
				if (master !== void 0) {
					const spawn = await this.spawnReviewer(master, releasedTicket).catch(() => ({
						spawned: false,
						reason: "failed",
						errorMessage: "reconcile reviewer spawn threw"
					}));
					if (spawn.spawned) {
						reseated = (await this.attachReviewer(releasedTicket.id, spawn.reviewer, "reviewer " + spawn.reviewer.label + " started (auto after release)", false)).reviewer !== null;
						this.trackReviewerRun(releasedTicket.id, spawn.reviewer.agentId, spawn.run, spawn.controller);
					}
				}
				await this.notifyMaster(next.boardId, "Taskboard notice: " + formatCompactEvent("REVIEWER_RELEASED", {
					ticket: next.id,
					title: next.title,
					state: compactCardState(next),
					scope: next.filesScope,
					anomaly: "review seat released: reviewer " + (seatLost ? "session is gone" : "was idle without a verdict for too long") + (reseated ? "; fresh reviewer auto-redispatched" : "; seat vacant — use taskboard_claim_review")
				}), NOTICE_KIND.reviewerReleased, next.id);
			}
			return released;
		}
		/**
		* One master-seat liveness pass (V3-25, revised by V3-32 and V3-34): every
		* board whose seat names a session that is gone for good is released. Seat
		* ownership follows the session, not the process: a holder merely absent
		* from the live agent registry (host restart, idle eviction) but still
		* carrying a stored session record keeps the seat and is never released —
		* the reported "master keeps dropping" fault. Only a holder that has left
		* the registry *and* has no stored record (the session was deleted or
		* cleaned up) is released. A registered holder keeps the seat however long
		* it stays silent: silence is not death, and a master that ends its turn
		* after dispatching and waits for a notice must not be evicted for it.
		*
		* A release changes seat ownership only: in-flight cards keep their workers
		* and reviewers untouched, and no card is ever re-dispatched by this pass.
		* The board gets one masterHistory row (empty target = vacant seat) and a
		* durable notice the successor reads back from taskboard_claim_master /
		* taskboard_notices; taskboard_handover remains the explicit takeover path
		* while the holder is still alive.
		*
		* Reentry-safe: the guarded release only clears the seat that still names
		* the judged holder, so concurrent passes release each board exactly once.
		* @returns how many seats this pass released.
		*/
		async reconcileMasterSeats() {
			if (this.agentRegistry() === void 0) return 0;
			const table = await this.boards();
			let released = 0;
			for (const [boardId, board] of table.entries()) {
				const holder = board.masterAgentId;
				if (holder === null) continue;
				if (await this.sessionHoldsSeat(holder)) continue;
				if (await this.releaseLostMasterSeat(boardId, holder, "holder session absent from the agent registry and from the session store")) released += 1;
			}
			return released;
		}
		/**
		* Release one board's lost master seat: clear the seat, append one
		* master-history row naming the released holder with an empty target (the
		* seat is vacant), and land the durable successor notice. Reentry-safe: the
		* guarded board update only clears the seat that still names the judged
		* holder, so a seat another path already released (or handed over) is
		* returned untouched and exactly one release lands per loss.
		* @param boardId - the board whose seat is released.
		* @param holderAgentId - the judged-lost holder session id.
		* @param reason - the concrete release reason recorded in history/notice.
		* @returns whether this call performed the release.
		*/
		async releaseLostMasterSeat(boardId, holderAgentId, reason) {
			let released = false;
			try {
				await this.mutateBoard(boardId, (current) => {
					if (current.masterAgentId !== holderAgentId) return current;
					released = true;
					return {
						...current,
						masterAgentId: null,
						masterClaimedAt: null,
						masterExpiresAt: null,
						masterHistory: [...current.masterHistory ?? [], {
							fromAgentId: holderAgentId,
							toAgentId: "",
							at: Date.now(),
							notes: "seat released: " + reason
						}]
					};
				});
			} catch {
				return false;
			}
			if (!released) return false;
			await this.recordMasterRelease(boardId, holderAgentId, reason);
			return true;
		}
		/**
		* Record the durable successor-facing notice for one released master seat.
		* Recorded on the board synchronously (the in-board fallback), so the next
		* taskboard_claim_master / taskboard_notices read carries it even when no
		* live or persisted inbox can be reached; a vacant seat makes live delivery
		* a no-op by construction. Best-effort: a notice fault never fails the
		* release that triggered it.
		* @param boardId - the board whose seat was released.
		* @param holderAgentId - the lost holder session id.
		* @param reason - the concrete release reason.
		*/
		async recordMasterRelease(boardId, holderAgentId, reason) {
			const text = "Taskboard notice: MASTER_SEAT_RELEASED board=" + boardId + " previous=" + holderAgentId + " reason=" + JSON.stringify(reason) + "; the seat is vacant — claim it with taskboard_claim_master (the result carries the structured snapshot).";
			await this.notifyMaster(boardId, text, NOTICE_KIND.masterReleased, "");
		}
		/**
		* Attach the designated reviewer to an In testing ticket.
		* @param ticketId - the In testing card to seat.
		* @param reviewer - the reviewer identity taking the seat.
		* @param detail - the 'review-claim' history detail.
		* @param resetRetries - V3-43: clear the card's automatic reviewer
		*   redispatch budget (default true — a deliberate reseat starts a fresh
		*   review round: a worker's completion/report, a master's request or a
		*   manual claim). The reviewer-staleness reconciliation passes false so its
		*   own release/redispatch budget keeps accumulating until the cap blocks
		*   the card.
		*/
		attachReviewer(ticketId, reviewer, detail, resetRetries = true) {
			const now = Date.now();
			return this.mutate(ticketId, "review-claim", (current) => appendHistory({
				...current,
				reviewer,
				...resetRetries ? {
					reviewerRetries: 0,
					...current.column === "in_testing" && current.status === "blocked" ? {
						status: "claimed",
						failure: null
					} : {}
				} : {},
				updatedAt: now
			}, "review-claim", detail, now));
		}
		/**
		* Record the real reviewer-spawn failure on the card history. Uses the
		* free-form 'edit' change (no reviewer invariant) so the failure note lands
		* on the card without claiming a review seat.
		*/
		recordReviewerSpawnFailure(ticketId, errorMessage) {
			return this.mutate(ticketId, "edit", (current) => appendHistory({
				...current,
				updatedAt: Date.now()
			}, "review-spawn-failed", "reviewer spawn failed: " + errorMessage));
		}
		/**
		* One move with reviewer automation when the target is In testing. The
		* origin distinguishes the user-facing move (Remote 'move', the web UI
		* drag) from the master's own taskboard_move tool: only a user-origin move
		* into Not started wakes the master with the user-scheduled notice, so the
		* master never notifies itself about its own scheduling.
		*/
		async moveWithReviewer(agent, request, origin = "user") {
			if (!isColumn(request.column)) throw new TaskboardError("unknown column \"" + String(request.column) + "\"", "TASKBOARD_INVALID_COLUMN");
			const table = await this.tickets();
			const current = table.get(request.ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + request.ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertBoardAccessible(current.boardId, agent);
			TaskboardService.boardContextOf(request.boardId, current);
			const sourceColumn = current.column;
			const position = this.positionBetween(table, request.column, request.beforeTicketId, request.afterTicketId);
			const ticket = await this.mutate(request.ticketId, "move", (moved) => appendHistory({
				...moved,
				column: request.column,
				position,
				reviewer: request.column === "in_testing" ? moved.reviewer : null,
				updatedAt: Date.now()
			}, "move", "moved to " + request.column));
			if (request.column === "not_started" && origin === "user" && sourceColumn !== "not_started" && sourceColumn !== "in_progress") await this.notifyUserScheduled(ticket);
			if (request.column === "in_testing" && ticket.reviewer === null) {
				const spawn = await this.spawnReviewer(agent, ticket);
				if (spawn.spawned) {
					const withReviewer = await this.attachReviewer(ticket.id, spawn.reviewer, "reviewer " + spawn.reviewer.label + " started");
					this.trackReviewerRun(ticket.id, spawn.reviewer.agentId, spawn.run, spawn.controller);
					return withReviewer;
				}
				if (spawn.reason === "failed") await this.recordReviewerSpawnFailure(ticket.id, spawn.errorMessage).catch(() => {});
			}
			return ticket;
		}
		/**
		* Notify the board's master that the user scheduled one card into Not
		* started (a user-origin move), so it adjudicates whether to dispatch:
		* every dependency Done → taskboard_assign; otherwise
		* the master tells the user the refusal reason and records it on the card.
		* Reuses the durable master-notice channel (board notice + live inbox /
		* persisted inbox delivery); best-effort like every master notice, so a
		* notification fault never fails the move itself.
		*/
		async notifyUserScheduled(ticket) {
			try {
				const table = await this.tickets();
				const pending = ticket.dependsOn.filter((id) => {
					const dependency = table.get(id);
					return dependency === void 0 || dependency.column !== "done";
				});
				const dependsOn = ticket.dependsOn.length === 0 ? "none" : ticket.dependsOn.join(", ") + (pending.length === 0 ? " (all Done)" : " (NOT all Done: " + pending.join(", ") + ")");
				const filesScope = ticket.filesScope === "" ? "(none)" : ticket.filesScope;
				const text = "Taskboard notice: " + formatCompactEvent("USER_SCHEDULED", {
					ticket: ticket.id,
					title: ticket.title,
					state: "not_started",
					scope: ticket.filesScope,
					anomaly: "priority " + ticket.priority + "; type " + ticket.type + "; dependsOn [" + dependsOn + "]"
				}) + ". The user scheduled ticket " + ticket.id + " (\"" + ticket.title + "\", priority " + ticket.priority + ", type " + ticket.type + ") into Not started — adjudicate whether to start it. dependsOn [" + dependsOn + "]; filesScope \"" + filesScope + "\". When every dependency is Done, dispatch with taskboard_assign (the card moves to In progress and the workflow starts); otherwise tell the user why the card cannot start and record the reason in the card history or devNotes.";
				await this.notifyMaster(ticket.boardId, text, NOTICE_KIND.userScheduled, ticket.id);
			} catch {}
		}
		/**
		* Whole-board snapshot, sorted by column then position, scoped to one
		* board the caller may see: its own session-private boards plus its
		* workspace's project boards and the unowned legacy ones. A board outside
		* the caller's scope is denied as not found so its existence is not leaked.
		* @param agent - the calling session agent; its session and workspace scope the board.
		* @param boardId - the board to snapshot, or undefined for the caller's default board.
		* @returns the live board snapshot.
		*/
		async snapshot(agent, boardId) {
			const workspace = await this.workspaceOf(agent);
			const workspaceId = workspace === void 0 ? "" : workspace.id;
			await this.ensureSessionDefaultBoard(agent, workspace);
			const defaultBoard = await this.ensureDefaultBoard(workspaceId, workspace === void 0 ? void 0 : basename(workspace.path));
			const board = boardId ?? defaultBoard?.boardId ?? "default";
			await this.assertBoardAccessible(board, agent);
			const boardRow = (await this.boards()).get(board) ?? await this.ensureBoard(board);
			const table = await this.openedTable();
			const rows = [];
			for (const [, ticket] of table.entries()) if (ticket.boardId === board) rows.push(ticket);
			const tickets = rows.sort((a, b) => {
				const columnOrder = TASKBOARD_COLUMNS.indexOf(a.column) - TASKBOARD_COLUMNS.indexOf(b.column);
				return columnOrder !== 0 ? columnOrder : a.position - b.position;
			});
			return {
				boardId: board,
				name: boardRow.name,
				tickets,
				notices: boardRow.notices ?? []
			};
		}
		openTable = null;
		/**
		* List every board the caller may see: its session-private boards (scope
		* 'session' owned by this session), its workspace's project boards (scope
		* 'project' with a matching workspaceId), and the unowned legacy default
		* board awaiting adoption. Boards outside those scopes never appear, so a
		* foreign session-private board or a cross-workspace project board is not
		* leaked. The implicit unowned "default" board row is reported first when
		* no record exists for it yet (v1 compatibility).
		* @param agent - the calling session agent; its session and workspace scope the listing.
		* @returns the visible board rows.
		*/
		async listBoards(agent) {
			const workspace = await this.workspaceOf(agent);
			const workspaceId = workspace === void 0 ? "" : workspace.id;
			await this.ensureSessionDefaultBoard(agent, workspace);
			await this.ensureDefaultBoard(workspaceId, workspace === void 0 ? void 0 : basename(workspace.path));
			const table = await this.boards();
			const boards = [];
			for (const [, board] of table.entries()) {
				if (!this.isBoardVisible(board, agent.id, workspaceId)) continue;
				boards.push({
					...board,
					masterExpiresAt: null
				});
			}
			if (table.get("default") === void 0) boards.unshift({
				boardId: "default",
				name: "default",
				workspaceId: "",
				scope: "project",
				ownerSessionId: null,
				masterAgentId: null,
				masterClaimedAt: null,
				masterExpiresAt: null,
				handoverNotes: "",
				masterHistory: [],
				notices: [],
				archivedAt: null
			});
			return boards;
		}
		/**
		* Create one board through the Remote boundary. A 'project' scope stamps
		* the board with the caller's workspace ('' when unowned) and shares it
		* with every session of that workspace; the default 'session' scope records
		* the creating session as the owner and keeps the board private to it. The
		* boardId is always a fresh unique id; any workspaceId in the request is
		* ignored. An unowned caller (no resolvable cwd) is forced into 'session'
		* scope regardless of the request: a 'project' request from an unowned
		* session would otherwise mint a workspaceId-'' board shared with every
		* unowned session (the unowned leak).
		* @param agent - the calling session agent; it owns session boards and its workspace owns project boards.
		* @param request - the board name and visibility scope.
		* @returns the created board.
		*/
		async createBoardRemote(agent, request) {
			const workspace = await this.workspaceOf(agent);
			const workspaceId = workspace === void 0 ? "" : workspace.id;
			const scope = workspaceId === "" ? "session" : request.scope === "project" ? "project" : "session";
			await this.ensureSessionDefaultBoard(agent, workspace);
			await this.ensureDefaultBoard(workspaceId, workspace === void 0 ? void 0 : basename(workspace.path));
			const record = {
				boardId: "board-" + randomUUID(),
				name: resolveBoardName(request.name),
				workspaceId,
				scope,
				ownerSessionId: scope === "session" ? agent.id : null,
				masterAgentId: null,
				masterClaimedAt: null,
				masterExpiresAt: null,
				handoverNotes: "",
				archivedAt: null,
				masterHistory: [],
				notices: []
			};
			await (await this.boards()).put(record.boardId, record);
			return record;
		}
		/**
		* Archive one board through the Remote boundary. A board the caller cannot
		* see is denied as not found (no existence leak).
		* @param agent - the calling session agent.
		* @param request - the board to archive.
		* @returns the archived board.
		*/
		async archiveBoardRemote(agent, request) {
			await this.assertBoardAccessible(request.boardId, agent);
			return this.mutateBoard(request.boardId, (current) => ({
				...current,
				archivedAt: Date.now()
			}));
		}
		/**
		* Write the board-level worker/reviewer model+effort overrides (V3-5,
		* master only). Omitted patch fields keep the current board overrides; an
		* empty string clears one override so the host config governs again.
		* Effort values must be a deepseek level (off/high/max) or empty; anything
		* else is rejected loudly so the master sees the mistake instead of a
		* silent fallback.
		* @param agent - the board's current master.
		* @param boardId - the board to configure.
		* @param patch - the overrides to apply field by field.
		* @returns the updated board.
		*/
		async setBoardModelConfig(agent, boardId, patch) {
			await this.assertMasterOfBoard(boardId, agent);
			const board = (await this.boards()).get(boardId);
			if (board === void 0) throw new TaskboardError("board \"" + boardId + "\" does not exist", "TASKBOARD_BOARD_NOT_FOUND");
			const current = board.modelConfig ?? {};
			const pick = (key, value) => {
				if (value === void 0) return current[key];
				if (value === "") return void 0;
				if ((key === "workerEffort" || key === "reviewerEffort") && !EFFORT_LEVELS.includes(value)) throw new TaskboardError("reasoning effort \"" + value + "\" is not supported (off|high|max)", "TASKBOARD_INVALID_INPUT");
				return value;
			};
			const workerModel = pick("workerModel", patch.workerModel);
			const workerEffort = pick("workerEffort", patch.workerEffort);
			const reviewerModel = pick("reviewerModel", patch.reviewerModel);
			const reviewerEffort = pick("reviewerEffort", patch.reviewerEffort);
			const modelConfig = {
				...workerModel === void 0 ? {} : { workerModel },
				...workerEffort === void 0 ? {} : { workerEffort },
				...reviewerModel === void 0 ? {} : { reviewerModel },
				...reviewerEffort === void 0 ? {} : { reviewerEffort }
			};
			return this.mutateBoard(boardId, (currentBoard) => ({
				...currentBoard,
				modelConfig
			}));
		}
		/**
		* Create one ticket in Backlog through the Remote boundary. The target
		* board must be visible to the caller; an invisible board is denied as not
		* found (no existence leak).
		* @param agent - the calling session agent.
		* @param request - title, description, priority, ordering dependencies, and optional boardId.
		* @returns the created ticket.
		*/
		createRemote(agent, request) {
			return this.createRecordForBoard(agent, request);
		}
		/**
		* Shared Backlog creation used by the Remote surface and the master-only
		* taskboard_create tool. The Remote surface leaves type/targetBranch at
		* their defaults; the master tool supplies them explicitly.
		*/
		async createRecordForBoard(agent, request) {
			await this.assertBoardAccessible(request.boardId ?? "default", agent);
			const title = resolveTitle(request.title);
			const priority = TASKBOARD_PRIORITIES.includes(request.priority) ? request.priority : "normal";
			const type = request.type !== void 0 && TASKBOARD_TYPES.includes(request.type) ? request.type : "feature";
			const now = Date.now();
			const record = {
				id: "ticket-" + randomUUID(),
				title,
				description: typeof request.description === "string" ? request.description : "",
				column: "backlog",
				priority,
				boardId: request.boardId ?? "default",
				type,
				status: "ready",
				failure: null,
				autoRetries: 0,
				reviewerRetries: 0,
				createdAt: now,
				updatedAt: now,
				assignee: null,
				reviewer: null,
				reviewAttempts: 0,
				lastReview: null,
				reviewOutcome: null,
				devNotes: "",
				targetBranch: typeof request.targetBranch === "string" ? request.targetBranch : "",
				filesScope: typeof request.filesScope === "string" ? request.filesScope : "",
				dependsOn: Array.isArray(request.dependsOn) ? request.dependsOn : [],
				history: []
			};
			return this.createRecord(record, now);
		}
		/** Persist a fresh backlog record after dependency validation. */
		async createRecord(record, now) {
			const table = await this.tickets();
			this.validateDependencies(table, record.id, record.dependsOn);
			const open = await this.openedTable();
			let max = 0;
			for (const [, ticket] of open.entries()) if (ticket.column === record.column && ticket.position >= max) max = ticket.position + 1;
			const stored = appendHistory({
				...record,
				position: max
			}, "create", "created in backlog", now);
			await table.put(stored.id, stored);
			const change = {
				operation: "create",
				ticketId: stored.id,
				boardId: stored.boardId,
				ticket: stored
			};
			this.ctx.emit("taskboard/changed", change);
			return stored;
		}
		/**
		* Move one ticket through the Remote boundary; entering In testing also
		* assigns a fresh reviewer through the subagent seam.
		* @param agent - the session agent driving the move (reviewer parent).
		* @param request - target column and optional position anchors.
		* @returns the moved ticket.
		*/
		moveRemote(agent, request) {
			return this.moveWithReviewer(agent, request);
		}
		/**
		* Edit one ticket through the Remote boundary. The ticket's board must be
		* visible to the caller; an invisible board is denied as not found (no
		* existence leak).
		* @param agent - the calling session agent.
		* @param request - replacement content and dependency edges.
		* @returns the edited ticket.
		*/
		async editRemote(agent, request) {
			const title = resolveTitle(request.title);
			const priority = TASKBOARD_PRIORITIES.includes(request.priority) ? request.priority : "normal";
			const table = await this.openedTable();
			const current = table.get(request.ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + request.ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertBoardAccessible(current.boardId, agent);
			TaskboardService.boardContextOf(request.boardId, current);
			this.validateDependencies(table, request.ticketId, request.dependsOn);
			return this.mutate(request.ticketId, "edit", (edited) => appendHistory({
				...edited,
				title,
				description: typeof request.description === "string" ? request.description : edited.description,
				priority,
				dependsOn: request.dependsOn,
				targetBranch: typeof request.targetBranch === "string" ? request.targetBranch : edited.targetBranch,
				filesScope: typeof request.filesScope === "string" ? request.filesScope : edited.filesScope,
				updatedAt: Date.now()
			}, "edit", "content edited"));
		}
		/**
		* Remove one ticket through the Remote boundary. The ticket's board must be
		* visible to the caller; an invisible board is denied as not found (no
		* existence leak).
		* @param agent - the calling session agent.
		* @param request - the ticket to remove.
		* @returns the removal receipt.
		*/
		async removeRemote(agent, request) {
			const table = await this.tickets();
			const current = table.get(request.ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + request.ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertBoardAccessible(current.boardId, agent);
			const boardId = TaskboardService.boardContextOf(request.boardId, current);
			this.runHandles.delete(request.ticketId);
			if (!await table.delete(request.ticketId)) throw new TaskboardError("ticket \"" + request.ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			const change = {
				operation: "remove",
				ticketId: request.ticketId,
				boardId,
				ticket: null
			};
			this.ctx.emit("taskboard/changed", change);
			return { removedId: request.ticketId };
		}
		/**
		* (Re)assign a reviewer for one In testing ticket through the Remote
		* boundary.
		* @param agent - the session agent spawning the reviewer child.
		* @param request - the In testing ticket to review.
		* @returns the ticket with its fresh reviewer attached.
		*/
		async requestReviewRemote(agent, request) {
			const current = (await this.tickets()).get(request.ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + request.ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertBoardAccessible(current.boardId, agent);
			TaskboardService.boardContextOf(request.boardId, current);
			if (current.column !== "in_testing") throw new TaskboardError("ticket \"" + current.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
			const spawn = await this.spawnReviewer(agent, current);
			if (!spawn.spawned) {
				if (spawn.reason === "failed") {
					await this.recordReviewerSpawnFailure(current.id, spawn.errorMessage).catch(() => {});
					throw new TaskboardError("no reviewer backend is available to assign: " + spawn.errorMessage, "TASKBOARD_INVALID_TRANSITION");
				}
				throw new TaskboardError("no reviewer backend is available to assign", "TASKBOARD_INVALID_TRANSITION");
			}
			const withReviewer = await this.attachReviewer(current.id, spawn.reviewer, "reviewer " + spawn.reviewer.label + " started");
			this.trackReviewerRun(current.id, spawn.reviewer.agentId, spawn.run, spawn.controller);
			return withReviewer;
		}
		/**
		* Claim the master seat of one board. V3-25/V3-34: the seat is no longer
		* leased by a wall clock and no longer follows the process either — only a
		* holder session that is gone for good (absent from the live agent registry
		* *and* holding no stored session record) is preempted here, so the
		* successor takes a genuinely vacant seat immediately; a holder the host
		* merely restarted or unloaded still owns it. A preemption leaves a
		* masterHistory row plus a durable board notice the claimant reads back from
		* this claim. A board the caller cannot see is denied as not found (no
		* existence leak), so the master seat of a foreign session-private board
		* cannot be seized.
		*
		* The liveness judgment runs before the (synchronous) board updater because
		* the stored-record probe is asynchronous; the updater then re-checks that
		* the judged holder is still the one on the row, and a seat that changed
		* hands in between fails closed as held rather than preempted on stale
		* evidence.
		* @param boardId - the board to claim.
		* @param agent - the claiming session agent.
		* @returns the board with its fresh master.
		*/
		async claimMaster(boardId, agent) {
			await this.assertBoardAccessible(boardId, agent);
			await this.ensureMasterBoard(boardId, agent);
			const now = Date.now();
			const incumbent = (await this.boards()).get(boardId)?.masterAgentId ?? null;
			const incumbentLost = incumbent !== null && incumbent !== agent.id ? !await this.sessionHoldsSeat(incumbent) : false;
			let lostHolder = null;
			const board = await this.mutateBoard(boardId, (current) => {
				if (current.masterAgentId !== null && current.masterAgentId !== agent.id) {
					if (current.masterAgentId !== incumbent || !incumbentLost) throw new TaskboardError("board \"" + boardId + "\" master seat is held by " + current.masterAgentId, "TASKBOARD_MASTER_HELD");
					lostHolder = current.masterAgentId;
				}
				if (current.masterAgentId === agent.id) return current;
				const entry = {
					fromAgentId: current.masterAgentId,
					toAgentId: agent.id,
					at: now,
					notes: lostHolder === null ? "" : "preempted a lost seat: holder session " + lostHolder + " is absent from the agent registry and from the session store"
				};
				return {
					...current,
					masterAgentId: agent.id,
					masterClaimedAt: now,
					masterExpiresAt: null,
					masterHistory: [...current.masterHistory ?? [], entry]
				};
			});
			if (lostHolder === null) return board;
			await this.recordMasterRelease(boardId, lostHolder, "holder session absent from the agent registry and from the session store");
			return (await this.boards()).get(boardId) ?? board;
		}
		/**
		* Release the master seat of one board; only the current master may. A
		* board the caller cannot see is denied as not found (no existence leak).
		* @param boardId - the board to release.
		* @param agent - the current master.
		* @returns the board with an empty seat.
		*/
		async releaseMaster(boardId, agent) {
			await this.assertBoardAccessible(boardId, agent);
			return this.mutateBoard(boardId, (current) => {
				if (current.masterAgentId !== agent.id) throw new TaskboardError("only the current master may release the seat", "TASKBOARD_NOT_MASTER");
				return {
					...current,
					masterAgentId: null,
					masterClaimedAt: null,
					masterExpiresAt: null
				};
			});
		}
		/**
		* Require the caller to be a top-level session agent, not a spawned
		* subagent child. Master verbs that dispatch workers must run in the
		* master's own session so the spawned worker's parent lineage stays the
		* top-level session (the three-layer hierarchy: master -> worker ->
		* reviewer). A subagent child carries an origin/delegationDepth in its
		* session header; top-level sessions carry neither.
		* @param agent - the calling session agent.
		*/
		static assertRootSession(agent) {
			const header = agent.session.header;
			if (header.origin === "subagent" || header.delegationDepth !== void 0 && header.delegationDepth > 0) throw new TaskboardError("only a top-level session agent may perform this action (subagent " + agent.id + ")", "TASKBOARD_NOT_ROOT");
		}
		/**
		* Hand over the master seat (master only): generate the structured handover
		* notes — every card's status, each in-flight worker identity, the In
		* testing review seats, the backlog summary, and the master history —
		* write them onto the board's handoverNotes, and release the seat. The
		* successor claims the seat with taskboard_claim_master, whose result
		* carries the notes.
		* @param boardId - the board to hand over.
		* @param agent - the current master.
		* @returns the released board plus the generated notes.
		*/
		async handover(boardId, agent) {
			await this.assertBoardAccessible(boardId, agent);
			const table = await this.tickets();
			const board = (await this.boards()).get(boardId);
			if (board === void 0) throw new TaskboardError("board \"" + boardId + "\" does not exist", "TASKBOARD_BOARD_NOT_FOUND");
			const tickets = [];
			for (const [, ticket] of table.entries()) if (ticket.boardId === boardId) tickets.push(ticket);
			const notes = buildHandoverNotes(board, tickets);
			return {
				board: await this.mutateBoard(boardId, (current) => {
					if (current.masterAgentId !== agent.id) throw new TaskboardError("only the current master may hand over the seat", "TASKBOARD_NOT_MASTER");
					return {
						...current,
						handoverNotes: notes,
						masterAgentId: null,
						masterClaimedAt: null,
						masterExpiresAt: null
					};
				}),
				notes
			};
		}
		/**
		* Notify the board's master about one workflow event. Three layers, in
		* order of durability:
		* 1. A durable in-board notice ({kind, text, at, ticketId}) is recorded
		*    synchronously on the board — the master reads it back through
		*    taskboard_claim_master / taskboard_notices even when every delivery
		*    path fails.
		* 2. Live inbox injection when the master session is in the agent registry
		*    (master.followup, the goal-round driver's inbox-injection precedent):
		*    the loop claims the message as ordinary input and acts on it — no
		*    board polling.
		* 3. Persistent inbox delivery when the master is NOT live (e.g. after a
		*    restart the session is absent from the runtime registry): the notice
		*    is appended as an 'agent/inbox/spliced' event to the master's
		*    persisted session log through ctx.sessionPersistence, so the master's
		*    next load/resume replays it as new input (the agent-loop Inbox
		*    rebuilds its pending projection from exactly those events).
		* Same board + ticket + event kind inside the dedupe window records nothing
		* and delivers nothing. Best-effort by design: a vacant seat, an absent
		* registry/persistence backend, or any delivery fault never fails the
		* triggering mutation.
		* @param boardId - the board whose master receives the notice.
		* @param text - the notice text (what happened and what to do next).
		* @param kind - the stable event kind (dedupe key part, e.g. "worker-done").
		* @param ticketId - the ticket the notice refers to (dedupe key part; '' for board-wide notices).
		*/
		async notifyMaster(boardId, text, kind, ticketId = "") {
			try {
				if (!await this.recordBoardNotice(boardId, text, kind, ticketId)) return;
				await this.deliverInbox(boardId, text);
			} catch {}
		}
		/** Record one durable in-board notice; false when deduped or the board vanished. */
		async recordBoardNotice(boardId, text, kind, ticketId) {
			const table = await this.boards();
			if (table.get(boardId) === void 0) await this.ensureBoard(boardId);
			const now = Date.now();
			let appended = false;
			try {
				await table.update(boardId, (current) => {
					const tail = current.notices?.at(-1);
					if (tail !== void 0 && tail.ticketId === ticketId && tail.kind === kind && now - tail.at < this.resolved.noticeDedupeWindowMs) return current;
					appended = true;
					return appendNotice(current, {
						kind,
						text,
						at: now,
						ticketId
					});
				});
			} catch (error) {
				if (error instanceof DomainError && error.code === "missing-key") return false;
				throw error;
			}
			return appended;
		}
		/** Deliver one notice into the master's inbox: live followup, else a persistent inbox splice. */
		async deliverInbox(boardId, text) {
			const board = (await this.boards()).get(boardId);
			if (board === void 0 || board.masterAgentId === null) return;
			const masterId = board.masterAgentId;
			const master = this.ctx.agents?.get(masterId);
			if (master !== void 0 && typeof master.followup === "function") {
				const message = createUserMessage({
					content: [{
						type: "text",
						text
					}],
					source: {
						kind: "taskboard",
						boardId
					}
				});
				master.followup(message);
				return;
			}
			const persistence = this.ctx.get("sessionPersistence");
			if (persistence === void 0 || typeof persistence.append !== "function" || typeof persistence.inspect !== "function") return;
			const inspected = await persistence.inspect(masterId);
			if (inspected === void 0) return;
			const events = inspected.events;
			const pending = pendingInboxLengths(events);
			const message = createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "taskboard",
					boardId
				}
			});
			const splice = {
				type: "agent/inbox/spliced",
				seq: events.length,
				time: Date.now(),
				data: {
					target: "next-turn",
					start: pending.nextTurn,
					inserted: [message]
				}
			};
			await persistence.append(masterId, [splice]);
		}
		/**
		* Transfer the master seat to another session agent with handover notes.
		* A board the caller cannot see is denied as not found (no existence leak).
		* @param boardId - the board to transfer.
		* @param fromAgent - the current master.
		* @param toAgentId - the receiving session agent id.
		* @param handoverNotes - notes for the next master.
		* @returns the board with the new master.
		*/
		async transferMaster(boardId, fromAgent, toAgentId, handoverNotes) {
			await this.assertBoardAccessible(boardId, fromAgent);
			return this.mutateBoard(boardId, (current) => {
				if (current.masterAgentId !== fromAgent.id) throw new TaskboardError("only the current master may transfer the seat", "TASKBOARD_NOT_MASTER");
				if (typeof toAgentId !== "string" || toAgentId.trim() === "") throw new TaskboardError("transfer target agent id must be a non-empty string", "TASKBOARD_INVALID_INPUT");
				const notes = typeof handoverNotes === "string" ? handoverNotes : "";
				const now = Date.now();
				const entry = {
					fromAgentId: current.masterAgentId,
					toAgentId,
					at: now,
					notes
				};
				return {
					...current,
					masterAgentId: toAgentId,
					masterClaimedAt: now,
					masterExpiresAt: null,
					handoverNotes: notes,
					masterHistory: [...current.masterHistory ?? [], entry]
				};
			});
		}
		/**
		* V3-20: resolve a configured repo from one absolute path, from
		* configuration only (never guessed): the configured preflight repo root
		* that prefixes the path wins (longest match).
		* @param path - the absolute path to locate (a master cwd or a declared scope entry).
		* @returns the matched repo root and its preflight contract, or null when no configured root governs the path.
		*/
		resolvePreflightRepo(path) {
			if (path === void 0 || path === "") return null;
			const targetNorm = normalizePath(path);
			let best = null;
			for (const [root, config] of Object.entries(this.resolved.preflightRepos)) {
				if (!isInsidePath(root, targetNorm)) continue;
				if (best === null || normalizePath(root).length > normalizePath(best.repoRoot).length) best = {
					repoRoot: root,
					config
				};
			}
			return best;
		}
		/**
		* V3-26: locate the repo one card dispatches against, preferring the card's
		* own declared filesScope over the master session cwd. The first declared
		* scope entry that lands inside a configured repo root wins (longest-prefix
		* match; a relative entry names nothing on its own and is skipped). Only
		* when no entry lands anywhere does the master cwd fall back to the
		* pre-V3-26 resolution, so a master started from an unmapped directory no
		* longer rejects cards whose declared scope is governed. When that fallback
		* is what located the repo, the caller names it in the report rather than
		* letting the card masquerade as scope-located (V3-33); V3-41 widens that
		* naming to a scope whose absolute entries all miss every configured root,
		* so a miss is judged per entry rather than by the scope's shape.
		* @param filesScope - the card's declared file scope.
		* @param cwd - the master session cwd, used only as a fallback.
		* @returns the matched root + contract, or null when neither the scope nor the cwd locates a repo.
		*/
		locatePreflightRepo(filesScope, cwd) {
			for (const entry of parseFilesScope(filesScope)) {
				if (!isAbsolute(entry)) continue;
				const byScope = this.resolvePreflightRepo(entry);
				if (byScope !== null) return byScope;
			}
			return this.resolvePreflightRepo(cwd);
		}
		/**
		* V3-20: other in-flight (In progress, running) cards of the same board,
		* for the cross-card file-scope conflict check.
		* @param ticket - the card being dispatched.
		* @returns the in-flight cards' id + declared scope.
		*/
		async inFlightScopes(ticket) {
			const table = await this.tickets();
			const scopes = [];
			for (const [, other] of table.entries()) {
				if (other.id === ticket.id) continue;
				if (other.boardId !== ticket.boardId) continue;
				if (other.column !== "in_progress" || other.status !== "running") continue;
				scopes.push({
					ticketId: other.id,
					filesScope: other.filesScope
				});
			}
			return scopes;
		}
		/**
		* V3-20/V3-26: run the deterministic repo/worktree preflight for one
		* dispatch, computed fresh at dispatch time (never cached). The card's
		* declared filesScope locates the repo first (V3-26); the master session
		* cwd is only the fallback. Returns null when preflight is not enabled (no
		* configured repos — legacy dispatch path); otherwise always a report, and
		* a safe=false report carries the concrete violations the caller must fail
		* the dispatch with (fail closed). A filesScope that is non-empty yet no
		* entry of which lands in a configured repo root is named as a violation
		* whenever the cwd fallback is what located the repo — no absolute entry at
		* all (V3-33), or absolute entries that all miss every configured root
		* (V3-41) — so the fallback is never silent.
		* @param ticket - the card being dispatched.
		* @param agent - the master session agent (its cwd is the fallback workspace repo).
		* @returns the preflight outcome, or null when preflight is disabled.
		*/
		async preflightDispatch(ticket, agent) {
			if (Object.keys(this.resolved.preflightRepos).length === 0) return null;
			const cwd = agent.session.header.cwd;
			const filesScope = ticket.filesScope;
			const scopeEntries = parseFilesScope(filesScope);
			const absoluteEntries = scopeEntries.filter((entry) => isAbsolute(entry));
			const scopeLocatesRepo = absoluteEntries.some((entry) => this.resolvePreflightRepo(entry) !== null);
			const locatedByCwdOnly = scopeEntries.length > 0 && !scopeLocatesRepo;
			const located = this.locatePreflightRepo(filesScope, cwd);
			const inFlightScopes = await this.inFlightScopes(ticket);
			if (located === null) {
				const now = Date.now();
				const cwdLabel = typeof cwd === "string" && cwd !== "" ? cwd : "(none)";
				return {
					report: {
						safe: false,
						violations: [scopeEntries.length === 0 ? "no repo mapping for ticket \"" + ticket.id + "\": the card declares no filesScope to locate its repo, and the master cwd \"" + cwdLabel + "\" is not inside any configured preflight repo root (fail closed)" : "no repo mapping for ticket \"" + ticket.id + "\": neither the declared filesScope \"" + filesScope + "\" nor the master cwd \"" + cwdLabel + "\" is inside any configured preflight repo root (fail closed)"],
						repoRoot: typeof cwd === "string" && cwd !== "" ? cwd : "(unknown)",
						canonicalBase: {
							branch: "",
							commit: ""
						},
						assignedWorktree: "",
						actualBranch: "",
						head: "",
						dirtyFiles: [],
						baseCandidateRelationship: "unknown",
						filesScope,
						conflicts: [],
						checkedAt: now
					},
					enforce: true
				};
			}
			const report = runPreflight(located.repoRoot, located.config, filesScope, inFlightScopes);
			if (locatedByCwdOnly) {
				const cwdLabel = typeof cwd === "string" && cwd !== "" ? cwd : "(none)";
				report.violations.push(absoluteEntries.length === 0 ? "filesScope \"" + filesScope + "\" of ticket \"" + ticket.id + "\" declares only relative path(s) and no absolute entry, so the repo was located by falling back to the master cwd \"" + cwdLabel + "\" instead of from the card; declare absolute filesScope paths so the card, not the dispatch cwd, chooses the repo" : "filesScope \"" + filesScope + "\" of ticket \"" + ticket.id + "\" declares absolute entry/entries " + absoluteEntries.map((entry) => "\"" + entry + "\" (" + (existsSync(entry) ? "exists but is outside every configured preflight repo root" : "does not exist on disk") + ")").join(", ") + ", none of which lands inside any configured preflight repo root, so the repo was located by falling back to the master cwd \"" + cwdLabel + "\" instead of from the card; declare filesScope paths under the configured repo root(s) so the card, not the dispatch cwd, chooses the repo");
				report.safe = false;
			}
			return {
				report,
				enforce: located.config.enforce !== false
			};
		}
		/**
		* V3-20: land one preflight-blocked dispatch: the card is marked blocked
		* with the concrete violations as its failure reason (never a worker
		* spawn), and the master is notified.
		* @param running - the card in its In progress/running post-assign state.
		* @param report - the failing preflight report.
		* @returns the blocked card.
		*/
		async blockPreflight(running, report) {
			const reason = "preflight blocked: " + report.violations.join(" | ");
			/* v8 ignore next -- defensive: the fail-mutate only throws when the card vanished
			mid-block (a concurrent removal race the harnessed lanes never interleave); the
			pre-existing spawn-failure paths carry the same guard. */
			const blocked = await this.mutate(running.id, "fail", (ticket) => ({
				...ticket,
				status: "blocked",
				failure: {
					reason,
					at: Date.now()
				},
				updatedAt: Date.now()
			})).catch(() => running);
			await this.notifyMaster(blocked.boardId, "Taskboard notice: " + formatCompactEvent("PREFLIGHT_BLOCKED", {
				ticket: blocked.id,
				title: blocked.title,
				state: compactCardState(blocked),
				scope: blocked.filesScope,
				...report.head === "" ? {} : { commit: report.head },
				blocker: "repo preflight failed (no worker spawned)",
				anomaly: report.violations.join(" | ")
			}), NOTICE_KIND.preflightBlocked, blocked.id);
			return blocked;
		}
		/**
		* Master assigns a Backlog or Not started ticket to a freshly spawned
		* worker: the card moves to In progress, status running, and a worker
		* subagent is spawned immediately; on success its id is recorded on the
		* card. Not started remains the scheduling display for the next queue,
		* but a card needs no move before dispatch — assign accepts it straight
		* from Backlog (V3-6 relaxation).
		* @param agent - the master session agent.
		* @param ticketId - the Backlog or Not started ticket to dispatch.
		* @param workerLabel - optional display label for the worker child.
		* @returns the card plus the worker-spawn outcome.
		*/
		async assign(agent, ticketId, workerLabel) {
			TaskboardService.assertRootSession(agent);
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			const running = await this.mutate(ticketId, "assign", (ticket) => {
				if (ticket.column !== "not_started" && ticket.column !== "backlog") throw new TaskboardError("ticket \"" + ticket.id + "\" is in \"" + ticket.column + "\" (assign requires Not started or Backlog)", "TASKBOARD_INVALID_TRANSITION");
				return appendHistory({
					...ticket,
					column: "in_progress",
					status: "running",
					assignee: {
						agentId: agent.id,
						label: agentLabel(agent)
					},
					failure: null,
					autoRetries: 0,
					updatedAt: Date.now()
				}, "assign", "assigned to a worker by master " + agentLabel(agent));
			});
			const preflight = await this.preflightDispatch(running, agent);
			if (preflight !== null && preflight.enforce && !preflight.report.safe) return {
				ticket: await this.blockPreflight(running, preflight.report),
				worker: "failed",
				workerAgentId: null
			};
			const spawn = await this.spawnWorker(agent, running, workerLabel, preflight === null ? void 0 : preflight.report);
			if (!spawn.ok) {
				const failureReason = spawn.reason === "failed" && spawn.errorMessage !== void 0 ? "worker spawn failed: " + spawn.errorMessage : "worker spawn " + spawn.reason;
				return {
					ticket: await this.mutate(ticketId, "fail", (ticket) => ({
						...ticket,
						status: "blocked",
						failure: {
							reason: failureReason,
							at: Date.now()
						},
						updatedAt: Date.now()
					})).catch(() => running),
					worker: spawn.reason,
					workerAgentId: null
				};
			}
			const withWorker = await this.mutate(ticketId, "assign", (ticket) => ({
				...ticket,
				workerAgentId: spawn.sessionId,
				workerSessionId: spawn.sessionId,
				updatedAt: Date.now()
			}));
			this.trackWorkerRun(ticketId, spawn.sessionId, spawn.run, spawn.controller);
			return {
				ticket: withWorker,
				worker: "spawned",
				workerAgentId: spawn.sessionId
			};
		}
		/**
		* The assigned worker reports development done; the ticket enters In
		* testing and a reviewer (same worker model) is spawned.
		* @param agent - the assigned worker session agent.
		* @param ticketId - the owned In progress ticket.
		* @param devNotes - what changed and how it was verified.
		* @returns the In testing ticket plus the reviewer-spawn outcome.
		*/
		async report(agent, ticketId, devNotes) {
			const notes = resolveRequiredText(devNotes, "report devNotes");
			const existing = (await this.tickets()).get(ticketId);
			if (existing !== void 0 && existing.workerAgentId === agent.id && existing.column === "in_testing") return {
				ticket: existing,
				review: existing.reviewer === null ? "unavailable" : "spawned",
				reviewerAgentId: existing.reviewer?.agentId ?? null
			};
			const ticket = await this.mutate(ticketId, "report", (current) => {
				if (current.workerAgentId !== agent.id) throw new TaskboardError("only the assigned worker may report the ticket", "TASKBOARD_NOT_WORKER");
				if (current.column !== "in_progress") throw new TaskboardError("ticket \"" + current.id + "\" is in \"" + current.column + "\" (report requires In progress)", "TASKBOARD_INVALID_TRANSITION");
				return appendHistory({
					...current,
					column: "in_testing",
					status: "claimed",
					devNotes: notes,
					autoRetries: 0,
					reviewerRetries: 0,
					updatedAt: Date.now()
				}, "report", "worker reported development done, waiting for review");
			});
			const spawn = await this.spawnReviewer(agent, ticket);
			if (!spawn.spawned) {
				if (spawn.reason === "failed") await this.recordReviewerSpawnFailure(ticket.id, spawn.errorMessage).catch(() => {});
				await this.notifyMaster(ticket.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_DONE", {
					ticket: ticket.id,
					title: ticket.title,
					state: compactCardState(ticket),
					scope: ticket.filesScope,
					anomaly: "reviewer spawn " + spawn.reason
				}) + ". Adjudicate the review with taskboard_resolve_review.", NOTICE_KIND.workerDone, ticket.id);
				return {
					ticket,
					review: spawn.reason,
					reviewerAgentId: null
				};
			}
			const withReviewer = await this.attachReviewer(ticket.id, spawn.reviewer, "reviewer " + spawn.reviewer.label + " started");
			this.trackReviewerRun(ticket.id, spawn.reviewer.agentId, spawn.run, spawn.controller);
			await this.notifyMaster(withReviewer.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_DONE", {
				ticket: withReviewer.id,
				title: withReviewer.title,
				state: compactCardState(withReviewer),
				scope: withReviewer.filesScope
			}) + ". Adjudicate the review with taskboard_resolve_review.", NOTICE_KIND.workerDone, withReviewer.id);
			return {
				ticket: withReviewer,
				review: "spawned",
				reviewerAgentId: spawn.reviewer.agentId
			};
		}
		/**
		* The assigned worker reports failure; the card stays In progress but is
		* marked blocked with a durable failure record.
		* @param agent - the assigned worker session agent.
		* @param ticketId - the owned In progress ticket.
		* @param reason - the concrete failure reason.
		* @returns the blocked ticket.
		*/
		async fail(agent, ticketId, reason) {
			const notes = resolveRequiredText(reason, "fail reason");
			const existing = (await this.tickets()).get(ticketId);
			if (existing !== void 0 && existing.workerAgentId === agent.id && existing.status === "blocked") return existing;
			const blocked = await this.mutate(ticketId, "fail", (current) => {
				if (current.workerAgentId !== agent.id) throw new TaskboardError("only the assigned worker may report failure", "TASKBOARD_NOT_WORKER");
				if (current.column !== "in_progress") throw new TaskboardError("ticket \"" + current.id + "\" is in \"" + current.column + "\" (fail requires In progress)", "TASKBOARD_INVALID_TRANSITION");
				return appendHistory({
					...current,
					status: "blocked",
					failure: {
						reason: notes,
						at: Date.now()
					},
					updatedAt: Date.now()
				}, "fail", "worker reported failure");
			});
			await this.notifyMaster(blocked.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_FAILED", {
				ticket: blocked.id,
				title: blocked.title,
				state: compactCardState(blocked),
				scope: blocked.filesScope,
				blocker: notes
			}) + ". Re-dispatch with taskboard_reassign.", NOTICE_KIND.workerFailed, blocked.id);
			return blocked;
		}
		/**
		* Master re-dispatches one card: "retry" spawns a fresh worker (card back
		* to running, failure cleared), "backlog" returns the card to Not started,
		* and "continue" (V3-28) wakes the card's existing worker session instead of
		* spawning a replacement — the manual entry into the same wake path the
		* automatic recovery uses for a running, blocked, or paused card. A refused
		* wake (no continuation state, dead session, no seam) degrades to the
		* historic fresh spawn, so "continue" never leaves the card without a
		* worker.
		* @param agent - the master session agent.
		* @param ticketId - the In progress card to re-dispatch.
		* @param action - retry, backlog, or continue.
		* @param workerLabel - optional display label for a retry worker.
		* @returns the re-dispatched card plus the worker-spawn outcome.
		*/
		async reassign(agent, ticketId, action, workerLabel) {
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			if (action === "continue") {
				if (current.column !== "in_progress") throw new TaskboardError("ticket \"" + current.id + "\" is in \"" + current.column + "\" (continue requires In progress)", "TASKBOARD_INVALID_TRANSITION");
				const wake = await this.wakeWorker(agent, current, current.status === "paused" ? "the master resumed this card from pause" : "the master asked this worker session to continue");
				if (wake.woken) {
					const continued = await this.mutate(ticketId, "reassign", (woken) => {
						if (woken.column !== "in_progress") return woken;
						if ((woken.workerSessionId ?? woken.workerAgentId) !== (current.workerSessionId ?? current.workerAgentId)) return woken;
						return appendHistory({
							...woken,
							status: "running",
							failure: null,
							updatedAt: Date.now()
						}, "reassign", "master woke the existing worker session (续做勿回滚)");
					});
					return {
						ticket: continued,
						worker: "continued",
						workerAgentId: continued.workerSessionId ?? continued.workerAgentId ?? null
					};
				}
				this.ctx.logger.warn("taskboard: cannot continue ticket " + ticketId + " (" + wake.detail + "); spawning a fresh worker on the preserved working tree");
			}
			if (action === "backlog") {
				const ticket = await this.mutate(ticketId, "reassign", (returned) => {
					if (returned.column !== "in_progress") throw new TaskboardError("ticket \"" + returned.id + "\" is in \"" + returned.column + "\" (backlog requires In progress)", "TASKBOARD_INVALID_TRANSITION");
					const reset = {
						...returned,
						column: "not_started",
						status: "ready",
						assignee: null,
						failure: null,
						reviewer: null,
						autoRetries: 0,
						reviewerRetries: 0,
						updatedAt: Date.now()
					};
					delete reset.workerAgentId;
					delete reset.workerSessionId;
					return appendHistory(reset, "reassign", "returned to Not started by master");
				});
				this.runHandles.delete(ticketId);
				return {
					ticket,
					worker: null,
					workerAgentId: null
				};
			}
			const running = await this.mutate(ticketId, "reassign", (retried) => {
				if (retried.column !== "in_progress") throw new TaskboardError("ticket \"" + retried.id + "\" is in \"" + retried.column + "\" (retry requires In progress)", "TASKBOARD_INVALID_TRANSITION");
				return appendHistory({
					...retried,
					status: "running",
					failure: null,
					autoRetries: 0,
					reviewerRetries: 0,
					updatedAt: Date.now()
				}, "reassign", retried.status === "paused" ? "re-dispatched by master (resumed from pause)" : "re-dispatched by master");
			});
			const preflight = await this.preflightDispatch(running, agent);
			if (preflight !== null && preflight.enforce && !preflight.report.safe) return {
				ticket: await this.blockPreflight(running, preflight.report),
				worker: "failed",
				workerAgentId: null
			};
			const spawn = await this.spawnWorker(agent, running, workerLabel, preflight === null ? void 0 : preflight.report);
			if (!spawn.ok) {
				const failureReason = spawn.reason === "failed" && spawn.errorMessage !== void 0 ? "worker spawn failed: " + spawn.errorMessage : "worker spawn " + spawn.reason;
				return {
					ticket: await this.mutate(ticketId, "fail", (ticket) => ({
						...ticket,
						status: "blocked",
						failure: {
							reason: failureReason,
							at: Date.now()
						},
						updatedAt: Date.now()
					})).catch(() => running),
					worker: spawn.reason,
					workerAgentId: null
				};
			}
			const withWorker = await this.mutate(ticketId, "reassign", (ticket) => ({
				...ticket,
				workerAgentId: spawn.sessionId,
				workerSessionId: spawn.sessionId,
				updatedAt: Date.now()
			}));
			this.trackWorkerRun(ticketId, spawn.sessionId, spawn.run, spawn.controller);
			return {
				ticket: withWorker,
				worker: "spawned",
				workerAgentId: spawn.sessionId
			};
		}
		/**
		* Master pauses one In progress/running card (taskboard_pause): the
		* in-flight worker run is aborted through the card's recorded handle, the
		* card status flips to 'paused' (column unchanged, one 'pause' history row
		* naming the pauser and the reason), and the master is notified. A paused
		* card is never marked blocked: the settlement callback and the
		* worker-liveness reconciliation only ever act on status 'running', so the
		* paused status alone keeps the card out of V3-13/V3-9 reclamation. Resume
		* with taskboard_reassign action "retry", which clears the paused status
		* and spawns a fresh worker.
		* @param agent - the master session agent.
		* @param ticketId - the In progress card whose worker to pause.
		* @param reason - why the master pauses the card (recorded in history).
		* @returns the paused card.
		*/
		async pause(agent, ticketId, reason) {
			const notes = resolveRequiredText(reason, "pause reason");
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			const paused = await this.mutate(ticketId, "pause", (ticket) => {
				if (ticket.column !== "in_progress" || ticket.status !== "running") throw new TaskboardError("ticket \"" + ticket.id + "\" is in \"" + ticket.column + "\" with status \"" + ticket.status + "\" (pause requires an In progress running card)", "TASKBOARD_INVALID_TRANSITION");
				return appendHistory({
					...ticket,
					status: "paused",
					updatedAt: Date.now()
				}, "pause", "paused by " + agentLabel(agent) + ": " + notes);
			});
			const handle = this.runHandles.get(ticketId);
			if (handle !== void 0) {
				handle.controller.abort();
				if (handle.run === void 0) {
					const subagents = this.ctx.get("subagents");
					if (subagents !== void 0 && typeof subagents.interrupt === "function") try {
						subagents.interrupt(handle.sessionId, {
							kind: "ancestor",
							agent
						});
					} catch {}
				}
				this.runHandles.delete(ticketId);
			}
			await this.notifyMaster(paused.boardId, "Taskboard notice: " + formatCompactEvent("WORKER_PAUSED", {
				ticket: paused.id,
				title: paused.title,
				state: compactCardState(paused),
				scope: paused.filesScope,
				anomaly: "worker run aborted by master"
			}) + ". Resume with taskboard_reassign action \"continue\" (wake the same session) or \"retry\" (fresh worker).", NOTICE_KIND.workerPaused, paused.id);
			return paused;
		}
		/**
		* Master records a new ticket on a board's Backlog (the discussion
		* whiteboard: the plan the master agreed with the user is written down).
		* Unlike the Remote create surface, the master tool also sets the ticket
		* type and may target any board the caller masters.
		* @param agent - the master session agent.
		* @param request - title, description, type, priority, dependencies, boardId and optional targetBranch.
		* @returns the created Backlog ticket.
		*/
		async createAsMaster(agent, request) {
			const boardId = request.boardId ?? "default";
			await this.assertMasterOfBoard(boardId, agent);
			return this.createRecordForBoard(agent, {
				...request,
				boardId
			});
		}
		/**
		* Master schedules a ticket to another column, optionally next to an
		* anchor; entering In testing still auto-assigns a fresh reviewer. The
		* caller must hold the master seat of the ticket's board.
		* @param agent - the master session agent.
		* @param request - target column and optional position anchors.
		* @returns the moved ticket.
		*/
		async moveAsMaster(agent, request) {
			const current = (await this.tickets()).get(request.ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + request.ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			const boardId = request.boardId ?? current.boardId;
			return this.moveWithReviewer(agent, {
				...request,
				boardId
			}, "master");
		}
		/**
		* Master adjusts the planning attributes of one ticket: dependency edges,
		* priority, and ordering position inside the ticket's column. Dependencies
		* are validated against the live board; position is an index in the column
		* ordering (halving semantics, like an anchor move).
		* @param agent - the master session agent.
		* @param ticketId - the ticket to plan.
		* @param dependsOn - replacement dependency edges, or undefined to keep them.
		* @param priority - replacement priority, or undefined to keep it.
		* @param position - the desired index in the ticket's column, or undefined to keep it.
		* @returns the planned ticket.
		*/
		async planAsMaster(agent, ticketId, dependsOn, priority, position) {
			const table = await this.tickets();
			const current = table.get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			const nextDependsOn = dependsOn === void 0 ? current.dependsOn : dependsOn;
			this.validateDependencies(table, ticketId, nextDependsOn);
			if (priority !== void 0 && !TASKBOARD_PRIORITIES.includes(priority)) throw new TaskboardError("unknown priority \"" + String(priority) + "\"", "TASKBOARD_INVALID_INPUT");
			let nextPosition = current.position;
			if (position !== void 0) {
				if (!Number.isSafeInteger(position) || position < 0) throw new TaskboardError("plan position must be a non-negative safe integer", "TASKBOARD_INVALID_INPUT");
				nextPosition = this.positionAtIndex(table, current.column, ticketId, position);
			}
			return this.mutate(ticketId, "edit", (planned) => appendHistory({
				...planned,
				priority: priority === void 0 ? planned.priority : priority,
				dependsOn: nextDependsOn,
				position: nextPosition,
				updatedAt: Date.now()
			}, "edit", "planned by master"));
		}
		/**
		* Master claims a Not started ticket and schedules it to In progress.
		* V3-7 closes the free claim: under the dispatch system only the master
		* of the ticket's board may claim — workers and reviewers receive cards
		* through taskboard_assign (dispatch) or taskboard_reassign (re-dispatch),
		* never by claiming. The caller must hold the master seat.
		* @param agent - the master session agent.
		* @param ticketId - the Not started ticket to claim.
		* @returns the claimed ticket, now In progress.
		*/
		async claim(agent, ticketId) {
			const table = await this.tickets();
			const current = table.get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			const label = agentLabel(agent);
			return this.mutate(ticketId, "claim", (current) => {
				if (current.assignee !== null) throw new TaskboardError("ticket \"" + current.id + "\" is already claimed", "TASKBOARD_ALREADY_CLAIMED");
				if (current.column !== "not_started") throw new TaskboardError("ticket \"" + current.id + "\" is in \"" + current.column + "\" (claim requires Not started)", "TASKBOARD_INVALID_TRANSITION");
				for (const dependencyId of current.dependsOn) {
					const dependency = table.get(dependencyId);
					if (dependency === void 0) throw new TaskboardError("unknown dependency ticket \"" + dependencyId + "\"", "TASKBOARD_DEPENDENCY_UNKNOWN");
					if (dependency.column !== "done") throw new TaskboardError("ticket \"" + current.id + "\" is blocked: dependency \"" + dependencyId + "\" is not Done", "TASKBOARD_DEPENDENCY_BLOCKED");
				}
				return appendHistory({
					...current,
					column: "in_progress",
					status: "claimed",
					assignee: {
						agentId: agent.id,
						label
					},
					reviewer: null,
					updatedAt: Date.now()
				}, "claim", "claimed by " + label);
			});
		}
		/**
		* Agent takes the empty review seat of one In testing ticket.
		* @param agent - the reviewing agent.
		* @param ticketId - the In testing ticket with no reviewer.
		* @returns the ticket with the reviewer attached.
		*/
		async claimReview(agent, ticketId) {
			const label = agentLabel(agent);
			const reviewer = {
				agentId: agent.id,
				label
			};
			return this.mutate(ticketId, "review-claim", (current) => {
				if (current.column !== "in_testing") throw new TaskboardError("ticket \"" + current.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
				if (current.reviewer !== null) throw new TaskboardError("ticket \"" + current.id + "\" already has a reviewer", "TASKBOARD_REVIEWER_PRESENT");
				return appendHistory({
					...current,
					reviewer,
					reviewerRetries: 0,
					...current.status === "blocked" ? {
						status: "claimed",
						failure: null
					} : {},
					updatedAt: Date.now()
				}, "review-claim", "review claimed by " + label);
			});
		}
		/**
		* Owner marks development done; the ticket enters In testing and gets a
		* reviewer (v1 path).
		* @param agent - the owning developer agent.
		* @param ticketId - the owned In progress ticket.
		* @param devNotes - what changed and how it was verified.
		* @returns the In testing ticket plus the reviewer-spawn outcome.
		*/
		async complete(agent, ticketId, devNotes) {
			const notes = typeof devNotes === "string" ? devNotes.trim() : "";
			const ticket = await this.mutate(ticketId, "complete", (current) => {
				if (current.column !== "in_progress") throw new TaskboardError("ticket \"" + current.id + "\" is in \"" + current.column + "\" (complete requires In progress)", "TASKBOARD_INVALID_TRANSITION");
				if (current.assignee === null || current.assignee.agentId !== agent.id) throw new TaskboardError("only the assignee may complete the ticket", "TASKBOARD_NOT_OWNER");
				return appendHistory({
					...current,
					column: "in_testing",
					devNotes: notes,
					autoRetries: 0,
					reviewerRetries: 0,
					updatedAt: Date.now()
				}, "complete", "development done, waiting for review");
			});
			const spawn = await this.spawnReviewer(agent, ticket);
			if (!spawn.spawned) {
				if (spawn.reason === "failed") await this.recordReviewerSpawnFailure(ticket.id, spawn.errorMessage).catch(() => {});
				return {
					ticket,
					review: spawn.reason,
					reviewerAgentId: null
				};
			}
			const withReviewer = await this.attachReviewer(ticket.id, spawn.reviewer, "reviewer " + spawn.reviewer.label + " started");
			this.trackReviewerRun(ticket.id, spawn.reviewer.agentId, spawn.run, spawn.controller);
			return {
				ticket: withReviewer,
				review: "spawned",
				reviewerAgentId: spawn.reviewer.agentId
			};
		}
		/**
		* The designated reviewer approves; the ticket lands in Done.
		* @param agent - the designated reviewer agent.
		* @param ticketId - the In testing ticket under review.
		* @param summary - what was inspected and why it passes.
		* @returns the approved Done ticket.
		*/
		async approve(agent, ticketId, summary) {
			return this.mutate(ticketId, "approve", (current) => {
				if (current.column !== "in_testing") throw new TaskboardError("ticket \"" + current.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
				if (current.reviewer === null || current.reviewer.agentId !== agent.id) throw new TaskboardError("only the designated reviewer may approve", "TASKBOARD_NOT_REVIEWER");
				return appendHistory({
					...current,
					column: "done",
					status: "claimed",
					reviewAttempts: current.reviewAttempts + 1,
					lastReview: {
						outcome: "approved",
						feedback: typeof summary === "string" ? summary.trim() : "",
						reviewer: current.reviewer,
						attempt: current.reviewAttempts + 1,
						at: Date.now()
					},
					updatedAt: Date.now()
				}, "approve", "review approved");
			});
		}
		/**
		* The designated reviewer rejects; the ticket is returned for rework.
		* @param agent - the designated reviewer agent.
		* @param ticketId - the In testing ticket under review.
		* @param feedback - concrete, actionable rework feedback.
		* @returns the rejected ticket, back In progress.
		*/
		async reject(agent, ticketId, feedback) {
			const reason = typeof feedback === "string" ? feedback.trim() : "";
			if (reason.length === 0) throw new TaskboardError("reject feedback must be a non-empty string", "TASKBOARD_INVALID_INPUT");
			return this.mutate(ticketId, "reject", (current) => {
				if (current.column !== "in_testing") throw new TaskboardError("ticket \"" + current.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
				if (current.reviewer === null || current.reviewer.agentId !== agent.id) throw new TaskboardError("only the designated reviewer may reject", "TASKBOARD_NOT_REVIEWER");
				return appendHistory({
					...current,
					column: "in_progress",
					status: "claimed",
					reviewAttempts: current.reviewAttempts + 1,
					lastReview: {
						outcome: "rejected",
						feedback: reason,
						reviewer: current.reviewer,
						attempt: current.reviewAttempts + 1,
						at: Date.now()
					},
					reviewer: null,
					autoRetries: 0,
					reviewerRetries: 0,
					updatedAt: Date.now()
				}, "reject", "review rejected, returned for rework");
			});
		}
		/**
		* The master resolves a report-mode review against the reviewer-reported
		* verdict (taskboard_resolve_review). Approve lands the card in Done and
		* archives the worker session; reject returns the card for rework, tries to
		* follow up the original worker, and marks the card blocked on the third
		* consecutive reject for the user to decide. The master may not overturn a
		* rejection into an approval — the verdict is applied as reported.
		* @param agent - the master session agent.
		* @param ticketId - the In testing ticket under review.
		* @param verdict - the reviewer-reported conclusion to apply.
		* @param summary - what the reviewer inspected and concluded.
		* @param problems - concrete rework items (empty on approval).
		* @returns the resolved card plus the followup/archive outcomes.
		*/
		async resolveReview(agent, ticketId, verdict, summary, problems) {
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			await this.assertMasterOfTicket(current, agent);
			if (current.column !== "in_testing") throw new TaskboardError("ticket \"" + current.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
			if (verdict !== "approve" && verdict !== "reject") throw new TaskboardError("verdict must be \"approve\" or \"reject\"", "TASKBOARD_INVALID_INPUT");
			const cleanSummary = typeof summary === "string" ? summary.trim() : "";
			const cleanProblems = Array.isArray(problems) ? problems.filter((problem) => typeof problem === "string").map((problem) => problem.trim()).filter((problem) => problem.length > 0) : [];
			const reviewer = current.reviewer ?? {
				agentId: agent.id,
				label: agentLabel(agent)
			};
			const attempt = current.reviewAttempts + 1;
			if (verdict === "approve") {
				if (current.type === "merge" && current.targetBranch.trim() === "") throw new TaskboardError("merge ticket \"" + ticketId + "\" has no confirmed target branch; record it in targetBranch before approving", "TASKBOARD_INVALID_INPUT");
				const approved = await this.mutate(ticketId, "approve", (ticket) => {
					if (ticket.column !== "in_testing") throw new TaskboardError("ticket \"" + ticket.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
					return appendHistory({
						...ticket,
						column: "done",
						status: "claimed",
						reviewAttempts: attempt,
						lastReview: {
							outcome: "approved",
							feedback: cleanSummary,
							reviewer,
							attempt,
							at: Date.now()
						},
						updatedAt: Date.now()
					}, "approve", "review approved by master");
				});
				return {
					ticket: approved,
					action: "approved",
					followup: "none",
					archived: await this.archiveWorkerSession(approved),
					blockedAfterReject: false
				};
			}
			const feedback = cleanProblems.length > 0 ? cleanProblems.join("\n") : cleanSummary;
			if (feedback.length === 0) throw new TaskboardError("reject requires problems or a summary", "TASKBOARD_INVALID_INPUT");
			const blockedAfterReject = attempt >= 3;
			const rejected = await this.mutate(ticketId, "reject", (ticket) => {
				if (ticket.column !== "in_testing") throw new TaskboardError("ticket \"" + ticket.id + "\" is not In testing", "TASKBOARD_INVALID_TRANSITION");
				return appendHistory({
					...ticket,
					column: "in_progress",
					status: blockedAfterReject ? "blocked" : "running",
					failure: blockedAfterReject ? {
						reason: "rejected 3 times, awaiting user decision",
						at: Date.now()
					} : null,
					reviewAttempts: attempt,
					lastReview: {
						outcome: "rejected",
						feedback,
						reviewer,
						attempt,
						at: Date.now()
					},
					reviewer: null,
					autoRetries: 0,
					reviewerRetries: 0,
					updatedAt: Date.now()
				}, "reject", blockedAfterReject ? "review rejected 3 times; awaiting user decision" : "review rejected, returned for rework");
			});
			return {
				ticket: rejected,
				action: "rejected",
				followup: await this.followupWorker(agent, rejected, feedback),
				archived: false,
				blockedAfterReject
			};
		}
		/**
		* Route one model-facing card edit (taskboard_update). The master of the
		* ticket's board may correct planning metadata on ANY card of that board
		* (Backlog through In testing, including cards already dispatched to someone
		* else) — title, description, filesScope and devNotes — and every such call
		* appends one history row naming the master and each changed field's old ->
		* new summary; a call that changes nothing records that too, so a master
		* correction is never silent. Every other caller keeps the pre-V3-40
		* assignee-only rule unchanged (TASKBOARD_NOT_OWNER), and only the master may
		* widen a card's filesScope (TASKBOARD_NOT_MASTER), so the worker-side
		* ownership semantics are untouched.
		* @param agent - the calling session agent.
		* @param ticketId - the card to edit.
		* @param edit - replacement fields; omitted fields stay unchanged.
		* @returns the updated ticket.
		*/
		async updateTicket(agent, ticketId, edit) {
			const current = (await this.tickets()).get(ticketId);
			if (current === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			if (!await this.isMasterOfTicket(current, agent)) {
				if (edit.filesScope !== void 0) throw new TaskboardError("only the master of board \"" + current.boardId + "\" may correct the ticket filesScope", "TASKBOARD_NOT_MASTER");
				if (current.assignee === null || current.assignee.agentId !== agent.id) throw new TaskboardError("only the assignee may update the ticket", "TASKBOARD_NOT_OWNER");
				return this.updateOwn(agent, ticketId, edit.title, edit.description, edit.devNotes);
			}
			return this.mutate(ticketId, "edit", (ticket) => {
				const title = typeof edit.title === "string" && edit.title.trim() !== "" ? edit.title.trim() : ticket.title;
				const description = typeof edit.description === "string" ? edit.description : ticket.description;
				const devNotes = typeof edit.devNotes === "string" ? edit.devNotes : ticket.devNotes;
				const filesScope = typeof edit.filesScope === "string" ? edit.filesScope : ticket.filesScope;
				const changes = [
					...title === ticket.title ? [] : [historyFieldChange("title", ticket.title, title)],
					...description === ticket.description ? [] : [historyFieldChange("description", ticket.description, description)],
					...devNotes === ticket.devNotes ? [] : [historyFieldChange("devNotes", ticket.devNotes, devNotes)],
					...filesScope === ticket.filesScope ? [] : [historyFieldChange("filesScope", ticket.filesScope, filesScope)]
				];
				return appendHistory({
					...ticket,
					title,
					description,
					devNotes,
					filesScope,
					updatedAt: Date.now()
				}, "edit", "metadata corrected by master " + agentLabel(agent) + ": " + (changes.length === 0 ? "no field changed" : changes.join("; ")));
			});
		}
		/**
		* Edit own-ticket content through the model-facing surface.
		* @param agent - the owning developer agent.
		* @param ticketId - the owned ticket.
		* @param title - replacement title, or undefined to keep it.
		* @param description - replacement description, or undefined to keep it.
		* @param devNotes - replacement notes, or undefined to keep them.
		* @returns the updated ticket.
		*/
		async updateOwn(agent, ticketId, title, description, devNotes) {
			return this.mutate(ticketId, "edit", (current) => {
				if (current.assignee === null || current.assignee.agentId !== agent.id) throw new TaskboardError("only the assignee may update the ticket", "TASKBOARD_NOT_OWNER");
				return appendHistory({
					...current,
					title: typeof title === "string" && title.trim() !== "" ? title.trim() : current.title,
					description: typeof description === "string" ? description : current.description,
					devNotes: typeof devNotes === "string" ? devNotes : current.devNotes,
					updatedAt: Date.now()
				}, "edit", "updated by assignee");
			});
		}
		/**
		* Whole-board rows for the model, optionally filtered.
		* @param column - column filter, or null for every column.
		* @param mine - when true, only rows assigned to agentId.
		* @param agentId - the calling agent's id.
		* @param detail - "compact" (default) returns the compact row; "full" also
		* carries description, devNotes and the pending review report (V3-21 card
		* read layering: compact by default, full when an anomaly needs it).
		* @returns the matching rows in position order.
		*/
		async listRows(column, mine, agentId, detail = "compact") {
			const table = await this.tickets();
			const rows = [];
			for (const [, ticket] of table.entries()) {
				if (column !== null && ticket.column !== column) continue;
				if (mine && ticket.assignee?.agentId !== agentId) continue;
				rows.push({
					id: ticket.id,
					title: ticket.title,
					column: ticket.column,
					priority: ticket.priority,
					boardId: ticket.boardId,
					type: ticket.type,
					status: ticket.status,
					workerAgentId: ticket.workerAgentId ?? null,
					failure: ticket.failure,
					position: ticket.position,
					assignee: ticket.assignee,
					reviewer: ticket.reviewer,
					reviewAttempts: ticket.reviewAttempts,
					lastReviewOutcome: ticket.lastReview?.outcome ?? null,
					filesScope: ticket.filesScope,
					dependsOn: ticket.dependsOn,
					...detail === "full" ? {
						description: ticket.description,
						devNotes: ticket.devNotes,
						reviewOutcome: ticket.reviewOutcome === null || ticket.reviewOutcome === void 0 ? null : {
							verdict: ticket.reviewOutcome.verdict,
							summary: ticket.reviewOutcome.summary,
							problems: ticket.reviewOutcome.problems
						}
					} : {}
				});
			}
			return rows.sort((a, b) => a.position - b.position);
		}
		/**
		* One full ticket for the model.
		* @param ticketId - the ticket to read.
		* @returns the full ticket view.
		*/
		async viewTicket(ticketId) {
			const ticket = (await this.tickets()).get(ticketId);
			if (ticket === void 0) throw new TaskboardError("ticket \"" + ticketId + "\" does not exist", "TASKBOARD_TICKET_NOT_FOUND");
			return ticket;
		}
		/**
		* Read the durable master notices of one board — the in-board fallback
		* inbox. Every notifyMaster event lands a row here synchronously, so the
		* master can see what happened even when live followup or persistent inbox
		* delivery could not reach it. A board the caller cannot see is denied as
		* not found (no existence leak).
		* @param boardId - the board to read.
		* @param agent - the calling session agent.
		* @returns the board id and its notices, newest last.
		*/
		async boardNotices(boardId, agent) {
			await this.assertBoardAccessible(boardId, agent);
			return {
				boardId,
				notices: (await this.ensureBoard(boardId)).notices ?? []
			};
		}
		/** Capture the opened table handle once the domain resolves. */
		async openedTable() {
			if (this.openTable !== null) return this.openTable;
			const domain = await this.domain;
			this.openTable = domain.table("tickets");
			return this.openTable;
		}
		/** The caller agent of one tool execution, loud when absent. */
		static agentOf(exec) {
			if (exec.agent === void 0) throw new TaskboardError("taskboard tools require an owning agent session", "TASKBOARD_AGENT_REQUIRED");
			return exec.agent;
		}
		/** Shared schemastery row schema for the model-facing card view. */
		static ticketRowSchema() {
			return {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					column: {
						type: "string",
						required: true,
						enum: [...TASKBOARD_COLUMNS]
					},
					priority: {
						type: "string",
						required: true,
						enum: [...TASKBOARD_PRIORITIES]
					},
					boardId: {
						type: "string",
						required: true
					},
					type: {
						type: "string",
						required: true,
						enum: [...TASKBOARD_TYPES]
					},
					status: {
						type: "string",
						required: true,
						enum: [...TASKBOARD_WORKER_STATUSES]
					},
					workerAgentId: {
						oneOf: [{ type: "string" }, { type: "null" }],
						required: true
					},
					failure: {
						oneOf: [{
							type: "object",
							additionalProperties: false,
							properties: {
								reason: {
									type: "string",
									required: true
								},
								at: {
									type: "number",
									required: true
								}
							}
						}, { type: "null" }],
						required: true
					},
					position: {
						type: "number",
						required: true
					},
					assignee: {
						oneOf: [{
							type: "object",
							additionalProperties: false,
							properties: {
								agentId: {
									type: "string",
									required: true
								},
								label: {
									type: "string",
									required: true
								}
							}
						}, { type: "null" }],
						required: true
					},
					reviewer: {
						oneOf: [{
							type: "object",
							additionalProperties: false,
							properties: {
								agentId: {
									type: "string",
									required: true
								},
								label: {
									type: "string",
									required: true
								}
							}
						}, { type: "null" }],
						required: true
					},
					reviewAttempts: {
						type: "number",
						required: true
					},
					lastReviewOutcome: {
						oneOf: [
							{
								type: "string",
								enum: ["approved"]
							},
							{
								type: "string",
								enum: ["rejected"]
							},
							{ type: "null" }
						],
						required: true
					},
					filesScope: {
						type: "string",
						required: true
					},
					dependsOn: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					description: { type: "string" },
					devNotes: { type: "string" },
					reviewOutcome: { oneOf: [{
						type: "object",
						additionalProperties: false,
						properties: {
							verdict: {
								type: "string",
								required: true
							},
							summary: {
								type: "string",
								required: true
							},
							problems: {
								type: "array",
								required: true,
								items: { type: "string" }
							}
						}
					}, { type: "null" }] }
				}
			};
		}
		/** Register every model-facing taskboard tool on the global tool registry. */
		registerTools() {
			this.ctx.tools.register(defineTool({
				name: "taskboard_list",
				description: "List taskboard tickets. Tickets come back sorted by implementation order (position) inside each column; dependsOn names tickets that must be Done before this one may be claimed. Prefer this over taskboard_view when scanning for the next card to pick up. detail \"compact\" (default) returns one compact line per card; detail \"full\" also carries description, devNotes and the pending review report — use full only when a compact line leaves an anomaly unresolved.",
				parameters: {
					column: {
						type: "string",
						enum: [...TASKBOARD_COLUMNS],
						description: "Only tickets in this column. Omit for the whole board."
					},
					mine: {
						type: "boolean",
						description: "When true, only tickets assigned to the calling agent."
					},
					detail: {
						type: "string",
						enum: ["compact", "full"],
						description: "compact (default) returns one line per card; full also includes description, devNotes and the pending review report for anomaly adjudication."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: { tickets: {
							type: "array",
							required: true,
							items: TaskboardService.ticketRowSchema()
						} }
					},
					render: (args, value) => [{
						type: "text",
						text: value.tickets.length === 0 ? "0 tickets" : String(value.tickets.length) + " ticket(s):\n" + value.tickets.map((ticket) => formatTicketRowLine(ticket) + (args.detail === "full" ? (ticket.description === "" || ticket.description === void 0 ? "" : "\n  description: " + ticket.description) + (ticket.devNotes === "" || ticket.devNotes === void 0 ? "" : "\n  devNotes: " + ticket.devNotes) + (ticket.reviewOutcome === null || ticket.reviewOutcome === void 0 ? "" : "\n  reviewOutcome: " + ticket.reviewOutcome.verdict + " — " + ticket.reviewOutcome.summary) : "")).join("\n")
					}]
				},
				execute: async (args, exec) => {
					const agent = TaskboardService.agentOf(exec);
					const column = args.column === void 0 ? null : args.column;
					if (column !== null && !isColumn(column)) throw new TaskboardError("unknown column \"" + String(column) + "\"", "TASKBOARD_INVALID_COLUMN");
					const detail = args.detail === "full" ? "full" : "compact";
					return { tickets: await this.listRows(column, args.mine === true, agent.id, detail) };
				},
				presentCall: (args) => ({
					card: "generic",
					title: "List taskboard tickets",
					kind: "other",
					rawInput: args.column ?? null
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_view",
				description: "Read one full taskboard ticket: description, assignee, review state, rejection feedback, devNotes and history. Use this when you need the ticket details before claiming or reworking it.",
				parameters: { ticketId: {
					type: "string",
					required: true,
					description: "The ticket id."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							description: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							priority: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_PRIORITIES]
							},
							boardId: {
								type: "string",
								required: true
							},
							type: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_TYPES]
							},
							status: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_WORKER_STATUSES]
							},
							workerAgentId: TaskboardService.ticketRowSchema().properties.workerAgentId,
							failure: TaskboardService.ticketRowSchema().properties.failure,
							createdAt: {
								type: "number",
								required: true
							},
							updatedAt: {
								type: "number",
								required: true
							},
							position: {
								type: "number",
								required: true
							},
							assignee: TaskboardService.ticketRowSchema().properties.assignee,
							reviewer: TaskboardService.ticketRowSchema().properties.reviewer,
							reviewAttempts: {
								type: "number",
								required: true
							},
							lastReview: {
								oneOf: [{
									type: "object",
									additionalProperties: false,
									properties: {
										outcome: {
											type: "string",
											required: true,
											enum: ["approved", "rejected"]
										},
										feedback: {
											type: "string",
											required: true
										},
										reviewer: {
											type: "object",
											additionalProperties: false,
											properties: {
												agentId: {
													type: "string",
													required: true
												},
												label: {
													type: "string",
													required: true
												}
											}
										},
										attempt: {
											type: "number",
											required: true
										},
										at: {
											type: "number",
											required: true
										}
									}
								}, { type: "null" }],
								required: true
							},
							reviewOutcome: {
								oneOf: [{
									type: "object",
									additionalProperties: false,
									properties: {
										verdict: {
											type: "string",
											required: true,
											enum: ["approve", "reject"]
										},
										summary: {
											type: "string",
											required: true
										},
										problems: {
											type: "array",
											required: true,
											items: { type: "string" }
										},
										at: {
											type: "number",
											required: true
										}
									}
								}, { type: "null" }],
								required: true
							},
							devNotes: {
								type: "string",
								required: true
							},
							targetBranch: {
								type: "string",
								required: true
							},
							filesScope: {
								type: "string",
								required: true
							},
							dependsOn: {
								type: "array",
								required: true,
								items: { type: "string" }
							},
							history: {
								type: "array",
								required: true,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										at: {
											type: "number",
											required: true
										},
										kind: {
											type: "string",
											required: true
										},
										detail: {
											type: "string",
											required: true
										}
									}
								}
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: formatTicketRowLine(value) + "\n" + (value.description === "" ? "" : "description: " + value.description + "\n") + (value.devNotes === "" ? "" : "devNotes: " + value.devNotes + "\n") + (value.filesScope === "" ? "" : "filesScope: " + value.filesScope + "\n") + (value.dependsOn.length === 0 ? "" : "dependsOn: " + value.dependsOn.join(", ") + "\n") + (value.reviewOutcome === null ? "" : "reviewOutcome: " + value.reviewOutcome.verdict + " — " + value.reviewOutcome.summary + "\n")
					}]
				},
				execute: async (args) => {
					const ticket = await this.viewTicket(args.ticketId);
					return {
						id: ticket.id,
						title: ticket.title,
						description: ticket.description,
						column: ticket.column,
						priority: ticket.priority,
						boardId: ticket.boardId,
						type: ticket.type,
						status: ticket.status,
						workerAgentId: ticket.workerAgentId ?? null,
						failure: ticket.failure,
						createdAt: ticket.createdAt,
						updatedAt: ticket.updatedAt,
						position: ticket.position,
						assignee: ticket.assignee,
						reviewer: ticket.reviewer,
						reviewAttempts: ticket.reviewAttempts,
						lastReview: ticket.lastReview,
						reviewOutcome: ticket.reviewOutcome,
						devNotes: ticket.devNotes,
						targetBranch: ticket.targetBranch,
						filesScope: ticket.filesScope,
						dependsOn: ticket.dependsOn,
						history: ticket.history
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "View taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_claim",
				description: "Claim a Not started taskboard ticket as the board master (master only): the card moves to In progress and is scheduled under the master's dispatch. Rejected when the caller is not the master of the ticket's board (TASKBOARD_NOT_MASTER), when the ticket is claimed by someone else, when a dependsOn ticket is not Done yet. Workers and reviewers never claim — they receive cards through taskboard_assign (dispatch) or taskboard_reassign (re-dispatch).",
				parameters: { ticketId: {
					type: "string",
					required: true,
					description: "The Not started ticket to claim (master only)."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							assignee: TaskboardService.ticketRowSchema().properties.assignee,
							reviewAttempts: {
								type: "number",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "claimed " + value.id
					}]
				},
				execute: async (args, exec) => {
					const value = await this.claim(TaskboardService.agentOf(exec), args.ticketId);
					return {
						id: value.id,
						title: value.title,
						column: value.column,
						assignee: value.assignee,
						reviewAttempts: value.reviewAttempts
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Claim taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_complete",
				description: "Mark an owned In progress ticket as development-complete: the card moves to In testing and the board automatically assigns a fresh reviewer agent. Summarize what changed and how it was verified in devNotes — the reviewer reads exactly that. The reviewer decides approve/reject; you never review your own ticket.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The ticket this agent owns."
					},
					devNotes: {
						type: "string",
						required: true,
						description: "What was implemented, files/areas touched, and how it was verified (tests run, manual checks). The reviewer reads this."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							ticketId: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							review: {
								type: "string",
								required: true,
								enum: [
									"spawned",
									"unavailable",
									"failed"
								]
							},
							reviewerAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.review === "spawned" ? "ticket " + value.ticketId + " is In testing; reviewer " + String(value.reviewerAgentId) + " assigned" : "ticket " + value.ticketId + " is In testing but reviewer spawn " + value.review + "; use taskboard_claim_review or tell the user"
					}]
				},
				execute: async (args, exec) => {
					const result = await this.complete(TaskboardService.agentOf(exec), args.ticketId, args.devNotes);
					return {
						ticketId: result.ticket.id,
						column: result.ticket.column,
						review: result.review,
						reviewerAgentId: result.reviewerAgentId
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Complete taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_claim_review",
				description: "Take the empty review seat of an In testing taskboard ticket (used when the automatic reviewer could not be spawned). After claiming, you are its reviewer: inspect the work, then call taskboard_approve or taskboard_reject.",
				parameters: { ticketId: {
					type: "string",
					required: true,
					description: "The In testing ticket with no reviewer."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							reviewer: TaskboardService.ticketRowSchema().properties.reviewer
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "review seat claimed for " + value.id
					}]
				},
				execute: async (args, exec) => {
					const value = await this.claimReview(TaskboardService.agentOf(exec), args.ticketId);
					return {
						id: value.id,
						column: value.column,
						reviewer: value.reviewer
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Claim taskboard review",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_approve",
				description: "Approve an In testing taskboard ticket you are the designated reviewer of: the card moves to Done. Summary states what was verified. Use only after actually inspecting the work; otherwise use taskboard_reject.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The In testing ticket you review."
					},
					summary: {
						type: "string",
						required: true,
						description: "What you inspected and why it passes."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							reviewAttempts: {
								type: "number",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " approved and Done"
					}]
				},
				execute: async (args, exec) => {
					const value = await this.approve(TaskboardService.agentOf(exec), args.ticketId, args.summary);
					return {
						id: value.id,
						column: value.column,
						reviewAttempts: value.reviewAttempts
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Approve taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_reject",
				description: "Reject an In testing taskboard ticket you are the designated reviewer of: the card returns to In progress (打回) with your feedback for the developer to rework. Feedback must list concrete, actionable problems. Do not fix the code yourself.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The In testing ticket you review."
					},
					feedback: {
						type: "string",
						required: true,
						description: "Concrete, actionable rework feedback."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							reviewAttempts: {
								type: "number",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " rejected and returned for rework"
					}]
				},
				execute: async (args, exec) => {
					const value = await this.reject(TaskboardService.agentOf(exec), args.ticketId, args.feedback);
					return {
						id: value.id,
						column: value.column,
						reviewAttempts: value.reviewAttempts
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Reject taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_review_verdict",
				description: "Report your review verdict on an In testing taskboard ticket you are the designated reviewer of (V3-28 report-mode reviewers running as a durable continuable child): the verdict is recorded on the card and the master resolves it with taskboard_resolve_review. This tool never moves the card, so report only after actually inspecting the work.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The In testing ticket you review."
					},
					verdict: {
						type: "string",
						required: true,
						enum: ["approve", "reject"],
						description: "\"approve\" when the work passes, \"reject\" when it must be reworked."
					},
					summary: {
						type: "string",
						required: true,
						description: "What you inspected and why it passes or fails."
					},
					problems: {
						type: "array",
						items: { type: "string" },
						description: "Concrete, actionable rework items; empty when approving."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							verdict: {
								type: "string",
								required: true,
								enum: ["approve", "reject"]
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " review verdict \"" + value.verdict + "\" recorded; the master resolves the card"
					}]
				},
				execute: async (args, exec) => {
					const value = await this.submitReviewVerdict(TaskboardService.agentOf(exec), args.ticketId, args.verdict, args.summary, args.problems ?? []);
					return {
						id: value.id,
						column: value.column,
						verdict: args.verdict
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Report review verdict",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_update",
				description: "Update a taskboard ticket. An assignee edits its own card (title, description, devNotes); the master of the card's board may additionally correct planning metadata on ANY card of that board — title, description, filesScope and devNotes — including cards already dispatched to someone else, so a planning typo in a frozen filesScope is fixable in place (V3-40). Omitted fields stay unchanged. Every master correction appends one history row naming the master and each changed field's old -> new summary; a correction that changes nothing is recorded too, never silently. Worker-side ownership is unchanged: an agent that is neither the assignee nor the board master is refused with TASKBOARD_NOT_OWNER, and only the master may change filesScope (a non-master, including the assignee, gets TASKBOARD_NOT_MASTER).",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The ticket to update."
					},
					title: {
						type: "string",
						description: "Replacement title."
					},
					description: {
						type: "string",
						description: "Replacement description."
					},
					devNotes: {
						type: "string",
						description: "Replacement completion notes."
					},
					filesScope: {
						type: "string",
						description: "Replacement declared file scope (master only; \"\" clears it)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " updated"
					}]
				},
				execute: async (args, exec) => {
					const patch = {};
					if (args.title !== void 0) patch.title = args.title;
					if (args.description !== void 0) patch.description = args.description;
					if (args.devNotes !== void 0) patch.devNotes = args.devNotes;
					if (args.filesScope !== void 0) patch.filesScope = args.filesScope;
					const value = await this.updateTicket(TaskboardService.agentOf(exec), args.ticketId, patch);
					return {
						id: value.id,
						title: value.title,
						column: value.column
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Update taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_claim_master",
				description: "Claim the master seat of a taskboard board: the caller becomes the master of that board (default board \"default\") and gains the exclusive right to taskboard_assign/taskboard_reassign. The seat is held by liveness, not by a clock (V3-25, revised by V3-32/V3-34): a holder session still present in the live agent registry keeps the seat, and a session the host merely unloaded from that registry still keeps it because its stored session record answers the existence probe; only a holder session gone for good — absent from the registry and with no stored session record — is released and preempted here at once, recorded with one master-history row and one \"master-released\" notice. An unjudgeable seat fails closed as held: no agent registry, no session-store existence probe, and a probe that faults all leave the seat with its holder. There is no wall-clock lease and no silence timeout — a registered holder keeps the seat however long it stays silent — and no cached liveness verdict: every judgment re-probes the host session store instead of trusting a cached liveness flag. Explicit taskboard_handover and taskboard_release_master remain the transfer paths. The liveness judgment is taken before the synchronous board updater, which then re-checks that the judged holder still holds the row, so a seat that changed hands in between fails closed as held rather than being preempted on stale evidence. When the previous master handed over with taskboard_handover, the claim result carries the structured handoverNotes (every card status, worker identity, review seats, backlog summary and master history). The claim result also carries the board's durable notices (worker done/failed/lost, review verdicts) — read them first so no event since your last look is missed.",
				parameters: { boardId: {
					type: "string",
					description: "The board to claim. Omit for the default board."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							boardId: {
								type: "string",
								required: true
							},
							name: {
								type: "string",
								required: true
							},
							masterAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							},
							handoverNotes: {
								type: "string",
								required: true
							},
							backlogSummary: {
								type: "string",
								required: true
							},
							pendingAdjudications: {
								type: "array",
								required: true,
								items: { type: "string" }
							},
							cards: {
								type: "array",
								required: true,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										ticketId: {
											type: "string",
											required: true
										},
										title: {
											type: "string",
											required: true
										},
										column: {
											type: "string",
											required: true,
											enum: [...TASKBOARD_COLUMNS]
										},
										status: {
											type: "string",
											required: true,
											enum: [...TASKBOARD_WORKER_STATUSES]
										},
										type: {
											type: "string",
											required: true
										},
										priority: {
											type: "string",
											required: true
										},
										workerAgentId: {
											oneOf: [{ type: "string" }, { type: "null" }],
											required: true
										},
										reviewer: {
											oneOf: [{
												type: "object",
												additionalProperties: false,
												properties: {
													agentId: {
														type: "string",
														required: true
													},
													label: {
														type: "string",
														required: true
													}
												}
											}, { type: "null" }],
											required: true
										},
										dependsOn: {
											type: "array",
											required: true,
											items: { type: "string" }
										},
										lastReviewOutcome: {
											oneOf: [{
												type: "string",
												enum: ["approved", "rejected"]
											}, { type: "null" }],
											required: true
										},
										reviewOutcome: {
											oneOf: [{
												type: "object",
												additionalProperties: false,
												properties: {
													verdict: {
														type: "string",
														required: true
													},
													summary: {
														type: "string",
														required: true
													},
													problems: {
														type: "array",
														required: true,
														items: { type: "string" }
													}
												}
											}, { type: "null" }],
											required: true
										},
										failure: {
											oneOf: [{
												type: "object",
												additionalProperties: false,
												properties: {
													reason: {
														type: "string",
														required: true
													},
													at: {
														type: "number",
														required: true
													}
												}
											}, { type: "null" }],
											required: true
										}
									}
								}
							},
							notices: {
								type: "array",
								required: true,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										kind: {
											type: "string",
											required: true
										},
										text: {
											type: "string",
											required: true
										},
										at: {
											type: "number",
											required: true
										},
										ticketId: {
											type: "string",
											required: true
										}
									}
								}
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "master seat of board " + value.boardId + " claimed by " + String(value.masterAgentId) + "\n" + formatHandoverSnapshotText({
							boardId: value.boardId,
							name: value.name,
							masterAgentId: value.masterAgentId,
							handoverNotes: value.handoverNotes,
							cards: value.cards,
							backlogSummary: value.backlogSummary,
							pendingAdjudications: value.pendingAdjudications
						}, value.notices)
					}]
				},
				execute: async (args, exec) => {
					const board = await this.claimMaster(args.boardId ?? "default", TaskboardService.agentOf(exec));
					const table = await this.tickets();
					const tickets = [];
					for (const [, ticket] of table.entries()) if (ticket.boardId === board.boardId) tickets.push(ticket);
					const snapshot = buildHandoverSnapshot(board, tickets);
					return {
						boardId: snapshot.boardId,
						name: snapshot.name,
						masterAgentId: snapshot.masterAgentId,
						handoverNotes: snapshot.handoverNotes,
						backlogSummary: snapshot.backlogSummary,
						pendingAdjudications: snapshot.pendingAdjudications,
						cards: snapshot.cards,
						notices: board.notices ?? []
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Claim taskboard master seat",
					kind: "other",
					rawInput: args.boardId ?? "default"
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_notices",
				description: "Read the durable master notices of a taskboard board (default board \"default\"): every notice (worker reported done/failed, worker lost after a restart, review verdicts) lands on the board synchronously, so this read works even when live or persistent inbox delivery could not reach the master. Notices carry {kind, text, at, ticketId}; the newest is last.",
				parameters: { boardId: {
					type: "string",
					description: "The board to read. Omit for the default board."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							boardId: {
								type: "string",
								required: true
							},
							notices: {
								type: "array",
								required: true,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										kind: {
											type: "string",
											required: true
										},
										text: {
											type: "string",
											required: true
										},
										at: {
											type: "number",
											required: true
										},
										ticketId: {
											type: "string",
											required: true
										}
									}
								}
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.notices.length === 0 ? "0 notices on board " + value.boardId : String(value.notices.length) + " notice(s) on board " + value.boardId + ":\n" + value.notices.map((notice) => "- [" + notice.kind + "] " + notice.ticketId + ": " + notice.text).join("\n")
					}]
				},
				execute: async (args, exec) => {
					return await this.boardNotices(args.boardId ?? "default", TaskboardService.agentOf(exec));
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Read taskboard board notices",
					kind: "other",
					rawInput: args.boardId ?? "default"
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_release_master",
				description: "Release the master seat of a taskboard board (default board \"default\"); only the current master may release. After release, another agent may claim the seat.",
				parameters: { boardId: {
					type: "string",
					description: "The board to release. Omit for the default board."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							boardId: {
								type: "string",
								required: true
							},
							masterAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "master seat of board " + value.boardId + " released"
					}]
				},
				execute: async (args, exec) => {
					const board = await this.releaseMaster(args.boardId ?? "default", TaskboardService.agentOf(exec));
					return {
						boardId: board.boardId,
						masterAgentId: board.masterAgentId
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Release taskboard master seat",
					kind: "other",
					rawInput: args.boardId ?? "default"
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_handover",
				description: "Hand over the master seat of a taskboard board (master only): generate structured handover notes (every card status, each in-flight worker identity, the In testing review seats, the backlog summary, and the master history), write them onto the board, and release the seat. The successor claims the seat with taskboard_claim_master — the claim result carries these notes.",
				parameters: { boardId: {
					type: "string",
					description: "The board to hand over. Omit for the default board."
				} },
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							boardId: {
								type: "string",
								required: true
							},
							masterAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							},
							notes: {
								type: "string",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "master seat of board " + value.boardId + " released with structured handover notes (" + String(value.notes.length) + " chars)"
					}]
				},
				execute: async (args, exec) => {
					const result = await this.handover(args.boardId ?? "default", TaskboardService.agentOf(exec));
					return {
						boardId: result.board.boardId,
						masterAgentId: result.board.masterAgentId,
						notes: result.notes
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Hand over taskboard master seat",
					kind: "other",
					rawInput: args.boardId ?? "default"
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_assign",
				description: "Dispatch a Backlog or Not started taskboard ticket (master only): the card moves to In progress with status running and a fresh worker subagent (DeepSeek v4 flash) is spawned immediately with the ticket content. Not started is the scheduling display for the next queue, but a card needs no move before dispatch — assign accepts it straight from Backlog. When repo preflight is configured (V3-20), the live git facts are checked first and a violated repo lands the card blocked with the concrete violations instead of spawning a worker. The worker finishes with taskboard_report (done) or taskboard_fail (blocked); the card records the worker identity.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The Backlog or Not started ticket to dispatch."
					},
					workerLabel: {
						type: "string",
						description: "Optional display label for the worker subagent; defaults to the ticket title."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							ticketId: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							status: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_WORKER_STATUSES]
							},
							worker: {
								type: "string",
								required: true,
								enum: [
									"spawned",
									"unavailable",
									"failed"
								]
							},
							workerAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: (value.worker === "spawned" ? "ticket " + value.ticketId + " dispatched; worker " + String(value.workerAgentId) + " started" : value.status === "blocked" ? "ticket " + value.ticketId + " blocked before a worker was spawned (see the card failure for the reason)" : "ticket " + value.ticketId + " moved In progress but worker spawn " + value.worker) + "\nThis turn ends here; worker/reviewer events (WORKER_DONE / WORKER_FAILED / REVIEW_VERDICT) will wake you — do not sleep or re-read the board to wait."
					}]
				},
				execute: async (args, exec) => {
					const result = await this.assign(TaskboardService.agentOf(exec), args.ticketId, args.workerLabel);
					return {
						ticketId: result.ticket.id,
						column: result.ticket.column,
						status: result.ticket.status,
						worker: result.worker,
						workerAgentId: result.workerAgentId
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Assign taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_report",
				description: "Report taskboard ticket development as complete (assigned worker only): the card moves to In testing and the board automatically assigns a fresh reviewer agent. devNotes summarizes what changed, which files were touched, and how it was verified — the reviewer reads exactly that.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The ticket this worker was assigned."
					},
					devNotes: {
						type: "string",
						required: true,
						description: "What was implemented, files/areas touched, and how it was verified (tests run, manual checks)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							ticketId: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							review: {
								type: "string",
								required: true,
								enum: [
									"spawned",
									"unavailable",
									"failed"
								]
							},
							reviewerAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.review === "spawned" ? "ticket " + value.ticketId + " reported done; reviewer " + String(value.reviewerAgentId) + " assigned" : "ticket " + value.ticketId + " reported done but reviewer spawn " + value.review
					}]
				},
				execute: async (args, exec) => {
					const result = await this.report(TaskboardService.agentOf(exec), args.ticketId, args.devNotes);
					return {
						ticketId: result.ticket.id,
						column: result.ticket.column,
						review: result.review,
						reviewerAgentId: result.reviewerAgentId
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Report taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_fail",
				description: "Report a taskboard ticket as failed (assigned worker only): the card stays In progress but is marked blocked with your failure reason so the master can re-dispatch it.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The ticket this worker was assigned."
					},
					reason: {
						type: "string",
						required: true,
						description: "Concrete failure reason (blocked, missing access, irrecoverable error)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							status: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_WORKER_STATUSES]
							},
							failure: TaskboardService.ticketRowSchema().properties.failure
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " marked blocked"
					}]
				},
				execute: async (args, exec) => {
					const value = await this.fail(TaskboardService.agentOf(exec), args.ticketId, args.reason);
					return {
						id: value.id,
						column: value.column,
						status: value.status,
						failure: value.failure
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Fail taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_reassign",
				description: "Re-dispatch one taskboard ticket (master only): action \"retry\" clears the failure and spawns a fresh worker on the same In progress card (status back to running); action \"continue\" (V3-28) instead wakes the card's existing worker session — it keeps its context and the preserved working tree, so prefer it for a blocked, paused or silent worker, and it degrades to a fresh spawn by itself when the session cannot be resumed; action \"backlog\" returns the card to Not started with status ready, clearing assignee and worker identity.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The In progress card to re-dispatch."
					},
					action: {
						type: "string",
						required: true,
						enum: [
							"retry",
							"continue",
							"backlog"
						],
						description: "retry spawns a new worker; continue wakes the existing worker session (falling back to a fresh spawn); backlog returns the card to Not started."
					},
					workerLabel: {
						type: "string",
						description: "Optional display label for a retry worker subagent."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							ticketId: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							status: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_WORKER_STATUSES]
							},
							worker: {
								oneOf: [{
									type: "string",
									enum: [
										"spawned",
										"continued",
										"unavailable",
										"failed"
									]
								}, { type: "null" }],
								required: true
							},
							workerAgentId: {
								oneOf: [{ type: "string" }, { type: "null" }],
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: (value.worker === "spawned" ? "ticket " + value.ticketId + " re-dispatched; new worker started" : value.worker === "continued" ? "ticket " + value.ticketId + " re-dispatched; the existing worker session was woken (context and working tree preserved)" : "ticket " + value.ticketId + " re-dispatched; worker spawn " + String(value.worker)) + "\nThis turn ends here; worker/reviewer events (WORKER_DONE / WORKER_FAILED / REVIEW_VERDICT) will wake you — do not sleep or re-read the board to wait."
					}]
				},
				execute: async (args, exec) => {
					const result = await this.reassign(TaskboardService.agentOf(exec), args.ticketId, args.action, args.workerLabel);
					return {
						ticketId: result.ticket.id,
						column: result.ticket.column,
						status: result.ticket.status,
						worker: result.worker,
						workerAgentId: result.workerAgentId
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Reassign taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_pause",
				description: "Pause one In progress/running taskboard ticket (master only): the in-flight worker run is aborted and the card is marked paused (column unchanged) with one history row naming the pauser and the reason. A paused card is never auto-blocked by settlement or liveness reconciliation. Resume it with taskboard_reassign action \"retry\", which clears paused and spawns a fresh worker.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The In progress card whose worker to pause."
					},
					reason: {
						type: "string",
						required: true,
						description: "Why the master pauses the card (recorded in the card history)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							status: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_WORKER_STATUSES]
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " (\"" + value.title + "\") paused (status " + value.status + ")"
					}]
				},
				execute: async (args, exec) => {
					const value = await this.pause(TaskboardService.agentOf(exec), args.ticketId, args.reason);
					return {
						id: value.id,
						title: value.title,
						column: value.column,
						status: value.status
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Pause taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_resolve_review",
				description: "Resolve a report-mode review (master only): apply the reviewer-reported verdict for an In testing taskboard ticket. approve moves the card to Done and archives the worker session; reject returns the card for rework with the reviewer's problems as feedback. The master applies the verdict as reported and may not overturn a rejection. After the third consecutive reject the card is marked blocked, awaiting the user's decision.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The In testing ticket under review."
					},
					verdict: {
						type: "string",
						required: true,
						enum: ["approve", "reject"],
						description: "The reviewer-reported conclusion to apply."
					},
					summary: {
						type: "string",
						required: true,
						description: "What the reviewer inspected and concluded."
					},
					problems: {
						type: "array",
						required: true,
						items: { type: "string" },
						description: "Concrete rework items reported by the reviewer (empty when approving)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							ticketId: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							status: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_WORKER_STATUSES]
							},
							action: {
								type: "string",
								required: true,
								enum: ["approved", "rejected"]
							},
							followup: {
								type: "string",
								required: true,
								enum: [
									"sent",
									"unavailable",
									"none"
								]
							},
							archived: {
								type: "boolean",
								required: true
							},
							blockedAfterReject: {
								type: "boolean",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.action === "approved" ? "ticket " + value.ticketId + " approved and Done" : "ticket " + value.ticketId + " rejected for rework (worker followup " + value.followup + (value.blockedAfterReject ? "; blocked after 3 rejects" : "") + ")"
					}]
				},
				execute: async (args, exec) => {
					const result = await this.resolveReview(TaskboardService.agentOf(exec), args.ticketId, args.verdict, args.summary, args.problems);
					return {
						ticketId: result.ticket.id,
						column: result.ticket.column,
						status: result.ticket.status,
						action: result.action,
						followup: result.followup,
						archived: result.archived,
						blockedAfterReject: result.blockedAfterReject
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Resolve taskboard review",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_create",
				description: "Create a taskboard ticket on a board's Backlog (master only): the plan you agreed with the user is written down as a card. The ticket lands in Backlog with the given type, priority and dependencies.",
				parameters: {
					boardId: {
						type: "string",
						description: "The board to create the ticket on. Omit for the default board."
					},
					title: {
						type: "string",
						required: true,
						description: "Ticket title."
					},
					description: {
						type: "string",
						required: true,
						description: "Ticket description / acceptance criteria."
					},
					type: {
						type: "string",
						enum: [...TASKBOARD_TYPES],
						description: "Ticket kind badge. Omit for \"feature\"."
					},
					priority: {
						type: "string",
						enum: [...TASKBOARD_PRIORITIES],
						description: "Ticket priority. Omit for \"normal\"."
					},
					dependsOn: {
						type: "array",
						items: { type: "string" },
						description: "Ticket ids this ticket waits for; all must exist and be open to completion."
					},
					filesScope: {
						type: "string",
						description: "Declared file scope: the ABSOLUTE paths (files or directories, e.g. \"C:/repo/packages/x/src\") this card affects. The master uses it when dispatching to judge parallel safety and soft dependencies between cards; it also locates the card's repo, so a scope written only as relative paths makes the dispatch fall back to the master cwd (V3-33)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							type: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_TYPES]
							},
							boardId: {
								type: "string",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " (\"" + value.title + "\") created in " + value.column
					}]
				},
				execute: async (args, exec) => {
					const agent = TaskboardService.agentOf(exec);
					const ticket = await this.createAsMaster(agent, {
						title: args.title,
						description: args.description,
						priority: args.priority ?? "normal",
						dependsOn: args.dependsOn ?? [],
						...args.boardId === void 0 ? {} : { boardId: args.boardId },
						...args.type === void 0 ? {} : { type: args.type },
						...args.filesScope === void 0 ? {} : { filesScope: args.filesScope }
					});
					return {
						id: ticket.id,
						title: ticket.title,
						column: ticket.column,
						type: ticket.type,
						boardId: ticket.boardId
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Create taskboard ticket",
					kind: "other",
					rawInput: args.title
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_move",
				description: "Move a taskboard ticket between columns (master only): schedules the card, optionally next to an anchor ticket. Moving into In testing keeps the automatic reviewer assignment.",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The ticket to move."
					},
					column: {
						type: "string",
						required: true,
						enum: [...TASKBOARD_COLUMNS],
						description: "The target column."
					},
					beforeTicketId: {
						type: "string",
						description: "Insert immediately before this ticket in the target column."
					},
					afterTicketId: {
						type: "string",
						description: "Insert immediately after this ticket in the target column (used when before is omitted)."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							reviewer: TaskboardService.ticketRowSchema().properties.reviewer
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " (\"" + value.title + "\") moved to " + value.column
					}]
				},
				execute: async (args, exec) => {
					const ticket = await this.moveAsMaster(TaskboardService.agentOf(exec), {
						ticketId: args.ticketId,
						column: args.column,
						beforeTicketId: args.beforeTicketId ?? null,
						afterTicketId: args.afterTicketId ?? null
					});
					return {
						id: ticket.id,
						title: ticket.title,
						column: ticket.column,
						reviewer: ticket.reviewer
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Move taskboard ticket",
					kind: "other",
					rawInput: args.ticketId + " -> " + args.column
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_plan",
				description: "Plan a taskboard ticket (master only): adjust dependency edges, priority, and the card's ordering position inside its column. Dependency changes take effect immediately on claim gates; position is an index in the column ordering (0 = first).",
				parameters: {
					ticketId: {
						type: "string",
						required: true,
						description: "The ticket to plan."
					},
					dependsOn: {
						type: "array",
						items: { type: "string" },
						description: "Replacement dependency edges (tickets that must be Done first). Omit to keep the current edges."
					},
					priority: {
						type: "string",
						enum: [...TASKBOARD_PRIORITIES],
						description: "Replacement priority. Omit to keep the current priority."
					},
					position: {
						type: "number",
						description: "Desired index in the ticket's column ordering (0 = first). Omit to keep the current position."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							title: {
								type: "string",
								required: true
							},
							column: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_COLUMNS]
							},
							priority: {
								type: "string",
								required: true,
								enum: [...TASKBOARD_PRIORITIES]
							},
							dependsOn: {
								type: "array",
								required: true,
								items: { type: "string" }
							},
							position: {
								type: "number",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "ticket " + value.id + " (\"" + value.title + "\") planned at position " + String(value.position)
					}]
				},
				execute: async (args, exec) => {
					const ticket = await this.planAsMaster(TaskboardService.agentOf(exec), args.ticketId, args.dependsOn, args.priority, args.position);
					return {
						id: ticket.id,
						title: ticket.title,
						column: ticket.column,
						priority: ticket.priority,
						dependsOn: ticket.dependsOn,
						position: ticket.position
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Plan taskboard ticket",
					kind: "other",
					rawInput: args.ticketId
				})
			}));
			this.ctx.tools.register(defineTool({
				name: "taskboard_board_config",
				description: "Read or set the per-board worker/reviewer model and reasoning-effort overrides (V3-5, master only). Every configured field overrides the host config for the board's spawned workers/reviewers; omit a field to keep the current board override, pass \"\" to clear it back to the host default (and the reviewer knobs fall back to the worker ones). Effort levels are the deepseek vocabulary: off | high | max. Spawns after the change use the new overrides; the board record keeps them durably.",
				parameters: {
					boardId: {
						type: "string",
						description: "The board to configure. Omit for the default board."
					},
					workerModel: {
						type: "string",
						description: "Board-level worker model override; \"\" clears it. Omit to keep the current override."
					},
					workerEffort: {
						type: "string",
						description: "Board-level worker reasoning effort (off|high|max); \"\" clears it. Omit to keep the current override."
					},
					reviewerModel: {
						type: "string",
						description: "Board-level reviewer model override; \"\" clears it. Omit to keep the current override."
					},
					reviewerEffort: {
						type: "string",
						description: "Board-level reviewer reasoning effort (off|high|max); \"\" clears it. Omit to keep the current override."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							boardId: {
								type: "string",
								required: true
							},
							name: {
								type: "string",
								required: true
							},
							modelConfig: {
								type: "object",
								required: true,
								additionalProperties: false,
								properties: {
									workerModel: { type: "string" },
									workerEffort: { type: "string" },
									reviewerModel: { type: "string" },
									reviewerEffort: { type: "string" }
								}
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: "board " + value.boardId + " (\"" + value.name + "\") model config: " + JSON.stringify(value.modelConfig)
					}]
				},
				execute: async (args, exec) => {
					const board = await this.setBoardModelConfig(TaskboardService.agentOf(exec), args.boardId ?? "default", {
						...args.workerModel === void 0 ? {} : { workerModel: args.workerModel },
						...args.workerEffort === void 0 ? {} : { workerEffort: args.workerEffort },
						...args.reviewerModel === void 0 ? {} : { reviewerModel: args.reviewerModel },
						...args.reviewerEffort === void 0 ? {} : { reviewerEffort: args.reviewerEffort }
					});
					const stored = board.modelConfig ?? {};
					const modelConfig = {
						...stored.workerModel === void 0 ? {} : { workerModel: stored.workerModel },
						...stored.workerEffort === void 0 ? {} : { workerEffort: stored.workerEffort },
						...stored.reviewerModel === void 0 ? {} : { reviewerModel: stored.reviewerModel },
						...stored.reviewerEffort === void 0 ? {} : { reviewerEffort: stored.reviewerEffort }
					};
					return {
						boardId: board.boardId,
						name: board.name,
						modelConfig
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Set taskboard board model config",
					kind: "other",
					rawInput: args.boardId ?? "default"
				})
			}));
		}
	};
})();
/**
* Administrative taskboard tools denied to spawned workers: the worker only
* reports (taskboard_report) or fails (taskboard_fail); everything else on
* the board belongs to the master. Only names registered in the global tool
* registry may be denied — tools.restrict() rejects unknown names loudly, so
* future administrative tools must be appended here when they land. The
* master-only whiteboard tools (create/move/plan) are registered before this
* list is consulted, so denying them here is safe.
*/
const WORKER_DENIED_TOOLS = [
	"taskboard_review_verdict",
	"taskboard_claim",
	"taskboard_list",
	"taskboard_view",
	"taskboard_complete",
	"taskboard_claim_review",
	"taskboard_approve",
	"taskboard_reject",
	"taskboard_update",
	"taskboard_assign",
	"taskboard_reassign",
	"taskboard_pause",
	"taskboard_claim_master",
	"taskboard_release_master",
	"taskboard_handover",
	"taskboard_create",
	"taskboard_move",
	"taskboard_plan",
	"taskboard_notices"
];
/**
* Administrative review tools denied to report-mode reviewers: the reviewer
* only inspects and returns a structured verdict — the master resolves the
* card with taskboard_resolve_review. Names must be registered in the global
* tool registry (tools.restrict() rejects unknown names loudly).
*/
const REVIEWER_DENIED_TOOLS = ["taskboard_approve", "taskboard_reject"];
//#endregion
export { TASKBOARD_COLUMNS, TASKBOARD_PRIORITIES, TaskboardError, TaskboardService as default };
