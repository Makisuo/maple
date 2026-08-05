/**
 * PLACEHOLDER — none of this is real data.
 *
 * The investigations redesign is built around a fan-out run: 1–5 diagnosing
 * agents, each assigned a distinct *lens*, then a validator that promotes one
 * candidate and records why each rival lost. Nothing persists that today.
 * `packages/db/src/schema/investigations.ts` is one flat row and the v2 wire
 * carries a single `report` blob, one model, one token pair, and no steps — so
 * the lens lanes, the "Hypotheses considered" table, the checks panel and the
 * fan-out segment of the run spine have no source to read from.
 *
 * Everything here is derived from the investigation's `id` (stable across
 * refreshes — a lane that renumbered itself every 3s poll would be worse than
 * no lane) and from its `status`, so the investigating / diagnosed / failed
 * boards each render their real variant instead of one frozen mock.
 *
 * When the fan-out is persisted, this module is the only file that has to die:
 * replace these functions with reads off the wire and every consumer keeps its
 * shape. Nothing else in `components/investigations/` invents data.
 *
 * No `Math.random`, no `Date.now` — a placeholder that changes under the user
 * is a bug report waiting to happen.
 */

import type { V2Investigation } from "@maple/domain/http/v2"

/* -------------------------------------------------------------------------------------------------
 * Lens catalogue
 * -----------------------------------------------------------------------------------------------*/

export type LensId =
	| "deploy_correlation"
	| "downstream_dependency"
	| "resource_saturation"
	| "traffic_shape"
	| "config_flags"

export interface Lens {
	readonly id: LensId
	readonly name: string
	/** What this lens is actually asking — shown as the catalogue's one-liner. */
	readonly question: string
}

/**
 * Fixed, and deliberately so: lenses are picked, not invented per run, which is
 * what keeps "ruled out" comparable across two investigations. A lens that finds
 * nothing is still a result worth printing.
 *
 * Order is dispatch order — the fan-out takes the first N.
 */
export const LENS_CATALOGUE: ReadonlyArray<Lens> = [
	{
		id: "deploy_correlation",
		name: "Deploy correlation",
		question: "What shipped before the window, and does the onset line up",
	},
	{
		id: "downstream_dependency",
		name: "Downstream dependency",
		question: "Is a callee actually degraded, or only being blamed",
	},
	{
		id: "resource_saturation",
		name: "Resource saturation",
		question: "Pools, queues, memory, connections at a ceiling",
	},
	{
		id: "traffic_shape",
		name: "Traffic shape",
		question: "Volume and mix against the 7-day baseline for that hour",
	},
	{
		id: "config_flags",
		name: "Config & flags",
		question: "Flag flips and config writes inside the window",
	},
]

/* -------------------------------------------------------------------------------------------------
 * Deterministic seeding
 * -----------------------------------------------------------------------------------------------*/

/** FNV-1a. Small, no dependency, and well spread over short id strings. */
const hashSeed = (value: string): number => {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

/**
 * A tiny LCG. Callers pull a fresh sequence per concern (`lenses`, `checks`, …)
 * so adding a field to one section can't shift the numbers in another.
 */
const rng = (seed: number) => {
	let state = seed || 1
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return state / 0x100000000
	}
}

const seedFor = (investigation: V2Investigation, concern: string) =>
	rng(hashSeed(`${investigation.id}:${concern}`))

/** Inclusive integer in [min, max]. */
const between = (next: () => number, min: number, max: number) => min + Math.floor(next() * (max - min + 1))

/* -------------------------------------------------------------------------------------------------
 * Fan-out sizing
 * -----------------------------------------------------------------------------------------------*/

/**
 * Severity × signal kind, straight off the design's sizing table. A freeform
 * question gets one agent and no validator — there is nothing to compare — and
 * every consumer treats `1` as "collapse the fan-out UI entirely".
 */
export function fanoutSize(investigation: V2Investigation): number {
	if (investigation.subject.type === "freeform") return 1
	const kind = investigation.subject.incident_kind
	if (kind === "alert") return 5
	if (kind === "anomaly") return 2
	switch (investigation.severity ?? investigation.snapshot.severity) {
		case "critical":
			return 5
		case "high":
			return 4
		case "medium":
			return 3
		case "low":
			return 2
		default:
			return 3
	}
}

/** At one agent there are no rivals, so there is nothing to rank or rule out. */
export const hasFanout = (investigation: V2Investigation): boolean => fanoutSize(investigation) > 1

/* -------------------------------------------------------------------------------------------------
 * Lens lanes
 * -----------------------------------------------------------------------------------------------*/

/** Where the lens itself got to, independent of what the validator made of it. */
export type LensRunStatus = "reported" | "checking" | "queued" | "no_finding"

/** What the validator did with the lens's candidate. `pending` = not ranked yet. */
export type LensVerdict = "promoted" | "merged" | "ruled_out" | "rejected" | "pending"

export interface PlaceholderLens {
	readonly lens: Lens
	readonly status: LensRunStatus
	readonly verdict: LensVerdict
	/** The candidate cause this lens put forward. */
	readonly claim: string | null
	/** The validator's one-line reason — the trust payload of the whole section. */
	readonly reason: string | null
	/** What it is doing right now, while `status` is `checking`. */
	readonly progressNote: string | null
	readonly elapsedSeconds: number | null
	readonly toolCount: number
	readonly confidence: "high" | "medium" | "low" | null
}

/** The validator lane — present whenever the run fanned out at all. */
export interface PlaceholderValidator {
	readonly status: "blocked" | "ranked" | "rejected_all"
	readonly note: string
	readonly elapsedSeconds: number | null
}

/**
 * The lens's own subject line. The scope is woven in so two investigations don't
 * read identically, but the sentence is still a template — it is not a finding.
 */
const CLAIM: Record<LensId, (scope: string) => string> = {
	deploy_correlation: (scope) => `A deploy to ${scope} lands just before the onset of the window`,
	downstream_dependency: (scope) => `A dependency of ${scope} degrades and propagates upstream`,
	resource_saturation: (scope) => `${scope} is pinned against a pool or queue ceiling`,
	traffic_shape: (scope) => `A volume shift overwhelms the capacity ${scope} was sized for`,
	config_flags: (scope) => `A flag or config write inside the window changes how ${scope} behaves`,
}

const PROMOTED_REASON =
	"strongest causal chain — the only candidate that explains both the onset delay and the shape of the recovery."
const MERGED_REASON =
	"same mechanism seen from the other end — folded into the promoted cause as evidence rather than kept as a rival."
const RULED_OUT_REASON: Record<LensId, string> = {
	deploy_correlation: "no deploy landed inside the window, so nothing shipped can explain the onset.",
	downstream_dependency: "contradicted by evidence — the callee stayed flat across the whole window.",
	resource_saturation: "utilisation sat well under its ceiling for the duration.",
	traffic_shape:
		"request volume sits within a few percent of the 7-day baseline for this hour — nothing load-driven to explain.",
	config_flags: "no flag flip or config write is recorded inside the window.",
}

const CHECKING_NOTE: Record<LensId, string> = {
	deploy_correlation: "correlating the deploy timeline",
	downstream_dependency: "comparing downstream percentiles",
	resource_saturation: "pulling pool and queue gauges",
	traffic_shape: "pulling the 7-day volume baseline",
	config_flags: "diffing config inside the window",
}

const scopeWord = (investigation: V2Investigation): string =>
	investigation.snapshot.scope?.trim().split(/\s+/)[0] ?? "this service"

/**
 * One lane per dispatched lens, shaped by status:
 *
 * - `investigating` — a prefix has reported, one is checking, the rest queued.
 * - `diagnosed` — the first lens is promoted, at most one merged, rest ruled out.
 * - `failed` — every lens is rejected (the `validation_inconclusive` variant),
 *   with one lens having run out of budget before it found anything.
 * - `resolved` — same as diagnosed; resolving doesn't rewrite what was found.
 */
export function placeholderLenses(investigation: V2Investigation): ReadonlyArray<PlaceholderLens> {
	const size = fanoutSize(investigation)
	const next = seedFor(investigation, "lenses")
	const scope = scopeWord(investigation)
	const dispatched = LENS_CATALOGUE.slice(0, size)
	const status = investigation.status

	// How far through the fan-out a live run is. Always leaves at least one lens
	// unfinished, or "investigating" would render as a completed board.
	const reportedCount = status === "investigating" ? between(next, 1, Math.max(1, size - 1)) : size
	// Which lens the validator folded into the promoted one. -1 = none merged.
	const mergedIndex = size > 2 && next() > 0.45 ? 1 : -1
	// On a failed run, the lens that never got to a finding at all.
	const starvedIndex = status === "failed" ? size - 1 : -1

	return dispatched.map((lens, index) => {
		const elapsed = Math.round((4 + next() * 11) * 10) / 10
		const toolCount = between(next, 2, 5)
		const claim = CLAIM[lens.id](scope)

		if (status === "investigating") {
			if (index < reportedCount) {
				return {
					lens,
					status: "reported",
					verdict: "pending",
					claim,
					reason: null,
					progressNote: null,
					elapsedSeconds: elapsed,
					toolCount,
					confidence: null,
				}
			}
			if (index === reportedCount) {
				return {
					lens,
					status: "checking",
					verdict: "pending",
					claim: null,
					reason: null,
					progressNote: CHECKING_NOTE[lens.id],
					elapsedSeconds: Math.round(elapsed * 0.4 * 10) / 10,
					toolCount: 1,
					confidence: null,
				}
			}
			return {
				lens,
				status: "queued",
				verdict: "pending",
				claim: null,
				reason: null,
				progressNote: null,
				elapsedSeconds: null,
				toolCount: 0,
				confidence: null,
			}
		}

		if (status === "failed") {
			if (index === starvedIndex) {
				return {
					lens,
					status: "no_finding",
					verdict: "rejected",
					claim: null,
					reason: "ran out of tool budget before it could reach a finding.",
					progressNote: null,
					elapsedSeconds: elapsed,
					toolCount,
					confidence: null,
				}
			}
			return {
				lens,
				status: "reported",
				verdict: "rejected",
				claim,
				reason: "contradicted by at least one other lens, and it did not explain the onset delay.",
				progressNote: null,
				elapsedSeconds: elapsed,
				toolCount,
				confidence: null,
			}
		}

		// diagnosed / resolved
		if (index === 0) {
			return {
				lens,
				status: "reported",
				verdict: "promoted",
				// The promoted lane states the real diagnosis, not a template — this
				// one field is genuine.
				claim: investigation.report?.suspectedCause ?? claim,
				reason: PROMOTED_REASON,
				progressNote: null,
				elapsedSeconds: elapsed,
				toolCount,
				confidence: investigation.report?.confidence ?? investigation.confidence ?? "medium",
			}
		}
		if (index === mergedIndex) {
			return {
				lens,
				status: "reported",
				verdict: "merged",
				claim,
				reason: MERGED_REASON,
				progressNote: null,
				elapsedSeconds: elapsed,
				toolCount,
				confidence: "medium",
			}
		}
		return {
			lens,
			status: "reported",
			verdict: "ruled_out",
			claim,
			reason: RULED_OUT_REASON[lens.id],
			progressNote: null,
			elapsedSeconds: elapsed,
			toolCount,
			confidence: index % 2 === 0 ? "low" : "medium",
		}
	})
}

/** Tallies the lanes the way the run spine and the section headers quote them. */
export function lensTally(lenses: ReadonlyArray<PlaceholderLens>) {
	return {
		total: lenses.length,
		reported: lenses.filter((entry) => entry.status === "reported").length,
		promoted: lenses.filter((entry) => entry.verdict === "promoted").length,
		merged: lenses.filter((entry) => entry.verdict === "merged").length,
		ruledOut: lenses.filter((entry) => entry.verdict === "ruled_out").length,
		rejected: lenses.filter((entry) => entry.verdict === "rejected").length,
	}
}

export function placeholderValidator(investigation: V2Investigation): PlaceholderValidator | null {
	if (!hasFanout(investigation)) return null
	const lenses = placeholderLenses(investigation)
	const tally = lensTally(lenses)
	if (investigation.status === "investigating") {
		return {
			status: "blocked",
			note: `Starts once all ${tally.total} lenses report — then ranks the candidates and promotes one`,
			elapsedSeconds: null,
		}
	}
	if (investigation.status === "failed") {
		return {
			status: "rejected_all",
			note: `No candidate survived: each was contradicted by at least one other lens`,
			elapsedSeconds: 8.2,
		}
	}
	return {
		status: "ranked",
		note: `${tally.promoted} promoted · ${tally.merged} merged · ${tally.ruledOut} ruled out`,
		elapsedSeconds: 8.2,
	}
}

/* -------------------------------------------------------------------------------------------------
 * Checks
 * -----------------------------------------------------------------------------------------------*/

export type CheckState = "held" | "failed" | "checking" | "queued" | "skipped"

export interface PlaceholderCheck {
	readonly key: string
	readonly label: string
	/** The terse result line under the label — the whole point of the panel. */
	readonly result: string
	readonly state: CheckState
}

/**
 * One shape per lens, keyed by lens id rather than positionally: the checks panel
 * *is* the lens results in one line each, so a check that could outlive its lens —
 * or land in a different order than the fan-out dispatched — would be inventing a
 * second, contradicting account of the same run.
 */
const CHECK_SHAPES: Record<
	LensId,
	{
		readonly label: string
		readonly held: string
		readonly failed: string
		readonly checking: string
		readonly starved: string
	}
> = {
	deploy_correlation: {
		label: "Deploy in the window",
		held: "a rollout lands minutes before onset",
		failed: "nothing shipped inside the window",
		checking: "correlating the deploy timeline…",
		starved: "not checked — lens ran out of budget",
	},
	downstream_dependency: {
		label: "Downstream latency",
		held: "callee percentiles climb with the caller",
		failed: "callee percentiles flat — healthy",
		checking: "comparing percentiles…",
		starved: "not checked — lens ran out of budget",
	},
	resource_saturation: {
		label: "Connection pool headroom",
		held: "at the ceiling for the duration",
		failed: "well under the ceiling throughout",
		checking: "pulling pool gauges…",
		starved: "not checked — lens ran out of budget",
	},
	traffic_shape: {
		label: "Request volume",
		held: "well above the 7-day baseline",
		failed: "within a few percent of the 7-day baseline",
		checking: "pulling the baseline…",
		starved: "not checked — lens ran out of budget",
	},
	config_flags: {
		label: "Client agent config",
		held: "changed inside the window",
		failed: "unchanged across the window",
		checking: "diffing config…",
		starved: "not checked — lens ran out of budget",
	},
}

/**
 * The rail's lead: one line per dispatched lens, each with a ✓ / ✗ / ○ and a terse
 * result. `n of m held` is what someone reads before anything else on the page, so
 * a check that *fails* still has to say something useful — "flat at baseline" is a
 * finding, not a blank.
 *
 * Every row is derived from the lens lane it summarises, which is what keeps the
 * rail and the board from disagreeing: a validator that rejected everything cannot
 * leave three ticks standing in the rail. At a fan-out of one there are no lens
 * results to summarise, so the panel drops out entirely — the same way the run
 * spine's fan-out segment and the validator lane already do.
 */
export function placeholderChecks(investigation: V2Investigation): ReadonlyArray<PlaceholderCheck> {
	if (!hasFanout(investigation)) return []
	const next = seedFor(investigation, "checks")

	return placeholderLenses(investigation).map((lane) => {
		const shape = CHECK_SHAPES[lane.lens.id]
		const base = { key: lane.lens.id, label: shape.label }

		switch (lane.status) {
			case "checking":
				return { ...base, result: shape.checking, state: "checking" as const }
			case "queued":
				return { ...base, result: "queued", state: "queued" as const }
			case "no_finding":
				return { ...base, result: shape.starved, state: "skipped" as const }
			default: {
				// A lens that has reported but not yet been ranked still made an
				// observation — the validator decides whether it *explains* anything,
				// not whether it happened. Seeded so a 3s poll can't flip it.
				const held =
					lane.verdict === "pending"
						? next() > 0.5
						: lane.verdict === "promoted" || lane.verdict === "merged"
				return {
					...base,
					result: held ? shape.held : shape.failed,
					state: held ? ("held" as const) : ("failed" as const),
				}
			}
		}
	})
}

export const checksHeld = (checks: ReadonlyArray<PlaceholderCheck>): number =>
	checks.filter((check) => check.state === "held").length

/* -------------------------------------------------------------------------------------------------
 * Run spine — fan-out segment
 * -----------------------------------------------------------------------------------------------*/

export interface PlaceholderRunStep {
	readonly key: string
	readonly label: string
	readonly detail: string
	readonly tone: "muted" | "active" | "success" | "failed"
}

/**
 * The steps that sit between "Opened" and "Diagnosed" on the run spine. The
 * real spine (`investigation-rail.tsx`) still owns Opened, Diagnosed, Escalated,
 * Resolved and Failed — those are derived from real timestamps. Only this middle
 * segment is invented, and it drops out entirely at a fan-out of one.
 */
export function placeholderRunSteps(investigation: V2Investigation): ReadonlyArray<PlaceholderRunStep> {
	if (!hasFanout(investigation)) return []
	const lenses = placeholderLenses(investigation)
	const tally = lensTally(lenses)
	const size = tally.total
	const slowest = lenses.reduce((max, entry) => Math.max(max, entry.elapsedSeconds ?? 0), 0)

	const dispatched: PlaceholderRunStep = {
		key: "dispatched",
		label: `Dispatched ${size} lenses`,
		detail: `Scaled to ${describeSubject(investigation)}`,
		tone: "muted",
	}

	if (investigation.status === "investigating") {
		return [
			dispatched,
			{
				key: "reporting",
				label: `${tally.reported} of ${size} reported`,
				detail: "Validation blocked until every lens reports",
				tone: "active",
			},
		]
	}

	if (investigation.status === "failed") {
		return [
			dispatched,
			{
				key: "inconclusive",
				label: "Validation inconclusive",
				detail: `${tally.reported} reported · 0 promoted`,
				tone: "failed",
			},
		]
	}

	return [
		dispatched,
		{
			key: "all_reported",
			label: `All ${size} reported`,
			detail: `Slowest lens ${slowest.toFixed(1)}s`,
			tone: "muted",
		},
		{
			key: "validated",
			label: "Validated",
			detail: `${tally.promoted} promoted · ${tally.merged} merged · ${tally.ruledOut} ruled out`,
			tone: "success",
		},
	]
}

const describeSubject = (investigation: V2Investigation): string => {
	if (investigation.subject.type === "freeform") return "a freeform question"
	const severity = investigation.severity ?? investigation.snapshot.severity
	const kind = `${investigation.subject.incident_kind} incident`
	return severity ? `a ${severity} ${kind}` : `an ${kind}`
}

/* -------------------------------------------------------------------------------------------------
 * Blast radius
 * -----------------------------------------------------------------------------------------------*/

export interface PlaceholderBlastRadius {
	readonly events: number
	readonly users: number
}

/**
 * The impact strip's last lane. Event and user counts exist nowhere on the
 * investigation — they'd have to come from the incident the subject points at.
 */
export function placeholderBlastRadius(investigation: V2Investigation): PlaceholderBlastRadius {
	const next = seedFor(investigation, "blast")
	const events = between(next, 120, 4800)
	return { events, users: Math.max(1, Math.round(events * (0.15 + next() * 0.3))) }
}
