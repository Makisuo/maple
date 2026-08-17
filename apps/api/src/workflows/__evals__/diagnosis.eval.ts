// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
/**
 * Does the model actually follow the rules the prompts state?
 *
 * The scoring rules themselves are unit-tested in `diagnosis-scorers.test.ts`;
 * this is the half that needs a real model. Two things are exercised, and they
 * are the two the whole rework turns on:
 *
 *  1. **Planning.** Given a sweep that establishes what an org emits, does the
 *     planner refrain from proposing a hypothesis nothing can answer? The fixed
 *     catalogue could not — it dispatched a saturation lane at an org exporting
 *     no resource metrics, every run.
 *  2. **Concluding.** Given an incident where nothing is checkable, does the
 *     investigator say so *with what it checked*, or invent a cause? A bare
 *     "it's an unknown error" used to be a fully compliant answer.
 *
 * The telemetry is handed to the model as prose rather than through live tools:
 * the tool-selection question is already covered by `mcp/__evals__`, and what is
 * under test here is the reasoning and the reporting discipline the prompts ask
 * for — which is exactly what nothing scored before.
 *
 * Gated like every other eval: skips without `OPENROUTER_API_KEY`, runs under
 * `bun run eval`, never as part of `bun run test`.
 */
import { generateObject, jsonSchema } from "ai"
import { describe, it } from "vitest"
import { describeEval, type TaskResult } from "vitest-evals"
import { INVESTIGATE_SYSTEM_PROMPT } from "@/chat/prompts"
import { PLANNER_SYSTEM_PROMPT } from "@/workflows/planner-prompt"
import { createEvalModel, hasEvalCredentials } from "@/mcp/__evals__/model"
import { DIAGNOSIS_FIXTURES, type DiagnosisFixture } from "./diagnosis-fixtures"
import {
	scoreCauseMatch,
	scoreEvidenceGrounding,
	scorePlanRelevance,
	scoreUnknownDiscipline,
	type ScoredPlan,
	type ScoredReport,
} from "./diagnosis-scorers"

const byId = new Map(DIAGNOSIS_FIXTURES.map((fixture) => [fixture.id, fixture]))

const fixtureFor = (input: string): DiagnosisFixture => {
	const fixture = byId.get(input)
	if (!fixture) throw new Error(`no diagnosis fixture named ${input}`)
	return fixture
}

const stringArray = { type: "array", items: { type: "string" } } as const

interface PlanModel {
	readonly scopeSummary: string
	readonly collapseReason: string | null
	readonly hypotheses: ReadonlyArray<{
		readonly id: string
		readonly name: string
		readonly question: string
		readonly claimToTest: string
		readonly rationale: string
		readonly toolNames: ReadonlyArray<string>
		readonly priority: number
	}>
}

interface ReportModel {
	readonly summary: string
	readonly suspectedCause: string
	readonly severityAssessment: "critical" | "high" | "medium" | "low"
	readonly affectedScope: string
	readonly evidence: ReadonlyArray<{
		readonly traceIds: ReadonlyArray<string>
		readonly logPatterns: ReadonlyArray<string>
		readonly relatedServices: ReadonlyArray<string>
		readonly note: string
	}>
	readonly suggestedActions: ReadonlyArray<string>
	readonly confidence: "high" | "medium" | "low"
	readonly ruledOut: ReadonlyArray<string>
}

/**
 * Mirrors `InvestigationPlan`, in the shape the `ai` SDK wants.
 *
 * Hand-written rather than derived from the Effect schema: this suite exists to
 * catch the prompt drifting away from the contract, and deriving both from one
 * source would let a schema change silently move the target it is scored against.
 *
 * Expressed as JSON Schema via the SDK's own `jsonSchema()`, the way
 * `mcp/__evals__/tools.ts` does — `apps/api` carries no zod, and one eval file is
 * not a reason to add it.
 */
const PLAN_SCHEMA = jsonSchema<PlanModel>({
	type: "object",
	additionalProperties: false,
	required: ["scopeSummary", "collapseReason", "hypotheses"],
	properties: {
		scopeSummary: { type: "string" },
		collapseReason: { type: ["string", "null"] },
		hypotheses: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "name", "question", "claimToTest", "rationale", "toolNames", "priority"],
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					question: { type: "string" },
					claimToTest: { type: "string" },
					rationale: { type: "string" },
					toolNames: stringArray,
					priority: { type: "number" },
				},
			},
		},
	},
})

const REPORT_SCHEMA = jsonSchema<ReportModel>({
	type: "object",
	additionalProperties: false,
	required: [
		"summary",
		"suspectedCause",
		"severityAssessment",
		"affectedScope",
		"evidence",
		"suggestedActions",
		"confidence",
		"ruledOut",
	],
	properties: {
		summary: { type: "string" },
		suspectedCause: { type: "string" },
		severityAssessment: { type: "string", enum: ["critical", "high", "medium", "low"] },
		affectedScope: { type: "string" },
		evidence: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["traceIds", "logPatterns", "relatedServices", "note"],
				properties: {
					traceIds: stringArray,
					logPatterns: stringArray,
					relatedServices: stringArray,
					note: { type: "string" },
				},
			},
		},
		suggestedActions: stringArray,
		confidence: { type: "string", enum: ["high", "medium", "low"] },
		ruledOut: stringArray,
	},
})

const planTask = async (input: string): Promise<TaskResult> => {
	const fixture = fixtureFor(input)
	const result = await generateObject({
		model: createEvalModel(),
		temperature: 0,
		schema: PLAN_SCHEMA,
		system: PLANNER_SYSTEM_PROMPT,
		prompt: [
			"Your scoping calls have already run. This is everything they established:",
			"",
			fixture.context,
			"",
			"Write the plan.",
		].join("\n"),
	})
	return { result: JSON.stringify(result.object) }
}

const diagnoseTask = async (input: string): Promise<TaskResult> => {
	const fixture = fixtureFor(input)
	const result = await generateObject({
		model: createEvalModel(),
		temperature: 0,
		schema: REPORT_SCHEMA,
		system: INVESTIGATE_SYSTEM_PROMPT,
		prompt: [
			"Your tool calls have already run. This is everything they returned:",
			"",
			fixture.context,
			"",
			`What planning established: ${fixture.scopeSummary}`,
			"",
			"Produce the diagnosis you would submit.",
		].join("\n"),
	})
	return { result: JSON.stringify(result.object) }
}

const parse = <T>(output: string | undefined): T => JSON.parse(output ?? "{}") as T

/** Bridge a rule to `vitest-evals`, resolving the fixture from the data item's input. */
const rule =
	(
		name: string,
		apply: (
			output: string | undefined,
			fixture: DiagnosisFixture,
		) => { score: number; rationale: string },
	) =>
	async (opts: { readonly input: string; readonly output?: string }) => {
		const { score, rationale } = apply(opts.output, fixtureFor(opts.input))
		return { score, metadata: { rationale: `${name}: ${rationale}` } }
	}

type DescribeEvalArgs = Parameters<typeof describeEval>

/** Skips rather than fails without a key, matching `mcp/__evals__/utils.ts`. */
const describeDiagnosisEval = (...args: DescribeEvalArgs): void => {
	const [name, options] = args
	if (!hasEvalCredentials()) {
		describe.skip(`[eval] ${String(name)}`, () => {
			it("skipped — set OPENROUTER_API_KEY to run diagnosis evals", () => {})
		})
		return
	}
	describeEval(name, options)
}

describeDiagnosisEval("investigation planning", {
	data: async () => DIAGNOSIS_FIXTURES.map((fixture) => ({ input: fixture.id, expected: "" })),
	task: planTask,
	scorers: [
		rule("plan relevance", (output, fixture) =>
			scorePlanRelevance(parse<ScoredPlan>(output), fixture),
		) as never,
	],
	// Below 1 because the "missed the planted cause" half-credit is a real, tolerable
	// outcome; proposing something unanswerable scores zero and drags the mean under.
	threshold: 0.75,
})

describeDiagnosisEval("investigation diagnosis", {
	data: async () => DIAGNOSIS_FIXTURES.map((fixture) => ({ input: fixture.id, expected: "" })),
	task: diagnoseTask,
	scorers: [
		rule("cause match", (output, fixture) =>
			scoreCauseMatch(parse<ScoredReport>(output), fixture),
		) as never,
		rule("evidence grounding", (output, fixture) =>
			scoreEvidenceGrounding(parse<ScoredReport>(output), fixture),
		) as never,
		rule("unknown discipline", (output) => scoreUnknownDiscipline(parse<ScoredReport>(output))) as never,
	],
	threshold: 0.75,
})
