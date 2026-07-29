import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_WORKERS_AI_MODEL } from "./model.js"
import { prepareUsageReport, trackStepUsage, type StepUsageInput } from "./token-usage.js"

const step = (overrides: Partial<StepUsageInput> = {}): StepUsageInput => ({
	sessionId: "sess_1",
	teamId: "T1",
	turnId: "turn_1",
	stepIndex: 0,
	inputTokens: 120,
	outputTokens: 34,
	...overrides,
})

const originalModel = process.env.WORKERS_AI_MODEL
afterEach(() => {
	if (originalModel === undefined) delete process.env.WORKERS_AI_MODEL
	else process.env.WORKERS_AI_MODEL = originalModel
})

describe("prepareUsageReport", () => {
	test("builds a report keyed by session, turn and step", () => {
		expect(prepareUsageReport(step({ stepIndex: 3 }))).toEqual({
			teamId: "T1",
			report: {
				idempotencyKey: "sess_1:turn_1:3",
				inputTokens: 120,
				outputTokens: 34,
				model: DEFAULT_WORKERS_AI_MODEL,
			},
		})
	})

	test("stamps the configured model", () => {
		process.env.WORKERS_AI_MODEL = "@cf/meta/llama-4"
		expect(prepareUsageReport(step())?.report.model).toBe("@cf/meta/llama-4")
	})

	test("keys distinct steps of one turn distinctly", () => {
		const first = prepareUsageReport(step({ stepIndex: 0 }))?.report.idempotencyKey
		const second = prepareUsageReport(step({ stepIndex: 1 }))?.report.idempotencyKey
		expect(first).not.toBe(second)
	})

	test("skips a session with no Slack team — nothing maps it to a payer", () => {
		expect(prepareUsageReport(step({ teamId: undefined }))).toBeNull()
		expect(prepareUsageReport(step({ teamId: "" }))).toBeNull()
	})

	test("skips an all-zero step (truncated stream), but keeps a one-sided one", () => {
		expect(prepareUsageReport(step({ inputTokens: 0, outputTokens: 0 }))).toBeNull()
		expect(prepareUsageReport(step({ inputTokens: undefined, outputTokens: undefined }))).toBeNull()
		expect(prepareUsageReport(step({ outputTokens: 0 }))?.report.outputTokens).toBe(0)
	})

	test("coerces provider counts to non-negative integers", () => {
		const prepared = prepareUsageReport(step({ inputTokens: 12.7, outputTokens: -5 }))
		expect(prepared?.report).toMatchObject({ inputTokens: 12, outputTokens: 0 })
	})

	test("drops non-finite counts rather than sending NaN", () => {
		expect(prepareUsageReport(step({ inputTokens: Number.NaN, outputTokens: 0 }))).toBeNull()
	})
})

describe("trackStepUsage", () => {
	test("reports a billable step to Maple", async () => {
		const calls: Array<{ teamId: string; idempotencyKey: string; inputTokens: number }> = []
		await trackStepUsage(step(), {
			reportTokenUsage: async (teamId, usage) => {
				calls.push({ teamId, idempotencyKey: usage.idempotencyKey, inputTokens: usage.inputTokens })
			},
		})
		expect(calls).toEqual([{ teamId: "T1", idempotencyKey: "sess_1:turn_1:0", inputTokens: 120 }])
	})

	test("does not call Maple for a skipped step", async () => {
		let called = false
		await trackStepUsage(step({ teamId: undefined }), {
			reportTokenUsage: async () => {
				called = true
			},
		})
		expect(called).toBe(false)
	})

	test("swallows a reporting failure — a billing write must not fail the turn", async () => {
		const promise = trackStepUsage(step(), {
			reportTokenUsage: async () => {
				throw new Error("HTTP 503")
			},
		})
		await expect(promise).resolves.toBeUndefined()
	})
})
