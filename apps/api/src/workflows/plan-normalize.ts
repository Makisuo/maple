/**
 * Turning what the planner said into what the workflow can actually dispatch.
 *
 * Kept pure, and separate from the agent that produces the plan, for one reason:
 * this is where every "the model said something unusable" case is decided, and
 * each of those decisions is a rule someone will want to argue with. A rule you
 * can read as a table and test without a model is a rule that stays honest.
 *
 * The load-bearing one is rule 3. A hypothesis whose tools do not survive the
 * intersection is *dropped*, not dispatched with an empty allowlist. That is the
 * mechanical form of the lesson `config_flags` taught: a lane asking a question
 * its tools cannot answer does not report "inconclusive", it reports a confident
 * guess, and the validator then has to rank a confabulation against real
 * findings.
 */
import type {
	InvestigationPlan,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	IssueSeverity,
} from "@maple/domain/http"
import { Option } from "effect"
import { permittedTools, seedHypotheses } from "./hypothesis-catalogue"

/** A hypothesis as the workflow dispatches it: ids slugged, tools already filtered. */
export interface PlannedHypothesis {
	readonly id: string
	readonly name: string
	readonly question: string
	readonly claimToTest: string
	readonly rationale: string
	readonly toolNames: ReadonlyArray<string>
	readonly priority: number
	readonly seedLensId: string | null
}

export interface NormalizedPlan {
	readonly scopeSummary: string
	readonly incidentStartedAt: string | null
	readonly incidentEndedAt: string | null
	readonly hypotheses: ReadonlyArray<PlannedHypothesis>
	/** Exactly one hypothesis: run it alone and skip the validator. */
	readonly collapsed: boolean
	readonly collapseReason: string | null
	/** True when the planner produced nothing usable and the seed catalogue stood in. */
	readonly usedSeedFallback: boolean
	/** What normalization changed, persisted with the plan so a reader can see it. */
	readonly notes: ReadonlyArray<string>
}

/**
 * How many hypotheses a subject of this shape deserves.
 *
 * This is the surviving half of the old `fanoutSize` table. The half that is
 * gone decided *whether* to fan out at all — that question no longer exists, and
 * conflating the two is what let a medium-severity alert compute a width of five
 * and dispatch zero.
 *
 * An anomaly is capped below the others because an anomaly is already a narrow
 * claim about one signal; five angles on it mostly produces four polite
 * negatives. A null severity reads as medium rather than as "minimum": an
 * unclassified incident is unclassified, not unimportant, and treating it as the
 * floor is how error incidents — which carry no severity until someone triages
 * them — would get the thinnest investigations.
 */
export const widthFor = (
	severity: IssueSeverity | null | undefined,
	incidentKind: string | undefined,
): number => {
	if (incidentKind === "anomaly") return 3
	switch (severity) {
		case "critical":
			return 5
		case "high":
			return 4
		case "low":
			return 3
		default:
			return 4
	}
}

/**
 * `Pool exhaustion in payments-api` → `pool_exhaustion_in_payments_api`.
 *
 * The id keys a unique index and appears in span names, so it has to be a slug
 * whatever the model wrote. Truncated to the schema's 48 characters rather than
 * rejected, because a too-long id is a formatting slip and throwing away a
 * hypothesis over one wastes a pass the planner already paid for.
 */
const slugify = (raw: string): string | null => {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48)
		.replace(/_+$/g, "")
	return /^[a-z][a-z0-9_]{2,47}$/.test(slug) ? slug : null
}

const MIN_WIDTH = 1

export interface NormalizePlanContext {
	readonly subject: InvestigationSubject
	readonly snapshot: InvestigationSubjectSnapshot | null
	readonly maxWidth: number
}

const fallback = (
	context: NormalizePlanContext,
	notes: ReadonlyArray<string>,
	scopeSummary: string,
): NormalizedPlan => {
	// Narrower than `maxWidth` on purpose. These were not selected on evidence, so
	// spending a critical incident's full width on four standing questions buys
	// breadth rather than relevance.
	const width = Math.max(MIN_WIDTH, Math.min(context.maxWidth, 3))
	const hypotheses = seedHypotheses(width).map((seed) => ({
		id: seed.id,
		name: seed.name,
		question: seed.question,
		claimToTest: seed.claimToTest,
		rationale: seed.rationale,
		toolNames: [...permittedTools(seed.toolNames)],
		priority: seed.priority,
		seedLensId: seed.seedLensId,
	}))
	return {
		scopeSummary,
		incidentStartedAt: context.snapshot?.incidentStartedAt ?? null,
		incidentEndedAt: context.snapshot?.incidentEndedAt ?? null,
		hypotheses,
		collapsed: hypotheses.length === 1,
		collapseReason: null,
		usedSeedFallback: true,
		notes,
	}
}

/**
 * Apply the rules, in order. Each returns the seed fallback rather than an empty
 * plan, because "we could not plan" must still produce an investigation — a run
 * that dispatches nothing is indistinguishable to the user from one that broke.
 */
export const normalizePlan = (
	raw: Option.Option<InvestigationPlan>,
	context: NormalizePlanContext,
): NormalizedPlan => {
	if (Option.isNone(raw)) {
		return fallback(
			context,
			["planner produced no plan; fell back to the seed catalogue"],
			"Planning did not complete. These are standing hypotheses, not ones selected from this incident's evidence.",
		)
	}
	const plan = raw.value
	const notes: Array<string> = []

	const seen = new Set<string>()
	const kept: Array<PlannedHypothesis> = []
	for (const hypothesis of plan.hypotheses) {
		const slug = slugify(hypothesis.id) ?? slugify(hypothesis.name)
		if (slug === null) {
			notes.push(`dropped a hypothesis whose id and name both slugged to nothing`)
			continue
		}
		// Suffix rather than drop: two hypotheses that collided on an id are still
		// two distinct propositions, and the index only needs them to differ.
		let id = slug
		let suffix = 2
		while (seen.has(id)) {
			id = `${slug.slice(0, 45)}_${suffix}`
			suffix += 1
		}
		const toolNames = [...permittedTools(hypothesis.toolNames)]
		if (toolNames.length === 0) {
			notes.push(`dropped "${hypothesis.name}": none of its tools exist`)
			continue
		}
		if (toolNames.length < hypothesis.toolNames.length) {
			notes.push(
				`"${hypothesis.name}": dropped ${hypothesis.toolNames.length - toolNames.length} unknown tool(s)`,
			)
		}
		seen.add(id)
		kept.push({
			id,
			name: hypothesis.name,
			question: hypothesis.question,
			claimToTest: hypothesis.claimToTest,
			rationale: hypothesis.rationale,
			toolNames,
			// Clamped rather than validated, for the same reason the id is slugified:
			// an out-of-range priority is a formatting slip, and rejecting the plan
			// over one throws away a pass that has already been paid for.
			priority: Math.min(5, Math.max(1, Math.round(hypothesis.priority))),
			seedLensId: hypothesis.seedLensId,
		})
	}

	if (kept.length === 0) {
		return fallback(
			context,
			[...notes, "no hypothesis survived normalization; fell back to the seed catalogue"],
			plan.scopeSummary,
		)
	}

	// Stable within a priority so a replay that produced the same plan dispatches
	// the same lane to the same ordinal — the ordinal is the workflow step name.
	const ordered = kept
		.map((hypothesis, index) => ({ hypothesis, index }))
		.sort((a, b) =>
			a.hypothesis.priority === b.hypothesis.priority
				? a.index - b.index
				: a.hypothesis.priority - b.hypothesis.priority,
		)
		.map((entry) => entry.hypothesis)

	const width = Math.max(MIN_WIDTH, context.maxWidth)
	if (ordered.length > width) {
		notes.push(`kept the top ${width} of ${ordered.length} hypotheses by priority`)
	}
	const hypotheses = ordered.slice(0, width)
	const collapsed = hypotheses.length === 1

	return {
		scopeSummary: plan.scopeSummary,
		// The planner's window wins over the snapshot's: the snapshot's is whatever
		// the incident producer happened to know, this one was checked.
		incidentStartedAt: plan.incidentStartedAt ?? context.snapshot?.incidentStartedAt ?? null,
		incidentEndedAt: plan.incidentEndedAt ?? context.snapshot?.incidentEndedAt ?? null,
		hypotheses,
		collapsed,
		collapseReason: collapsed
			? (plan.collapseReason ??
				"Only one hypothesis survived planning, so there were no rivals to rank.")
			: null,
		usedSeedFallback: false,
		notes,
	}
}
