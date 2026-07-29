import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_WORKERS_AI_MODEL } from "./model.js"
import {
	prepareUsageReport,
	resetZeroTokenDiagnosticsForTests,
	trackStepUsage,
	type StepUsageInput,
} from "./token-usage.js"

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
	test("builds a report prefixed by session, turn and step", () => {
		const prepared = prepareUsageReport(step({ stepIndex: 3 }))
		expect(prepared?.teamId).toBe("T1")
		expect(prepared?.report).toMatchObject({
			inputTokens: 120,
			outputTokens: 34,
			model: DEFAULT_WORKERS_AI_MODEL,
		})
		// Readable prefix for debugging, plus a per-process unique suffix.
		expect(prepared?.report.idempotencyKey).toStartWith("sess_1:turn_1:3:")
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

	test("keys a re-used session/turn/step triple distinctly — eve reuses turn ids", () => {
		// A terminal model failure does not advance eve's `sequence`, so the next
		// turn is minted as the same `turn_${sequence}` with `stepIndex` back at 0.
		// Identical input must NOT produce an identical key, or the billing
		// provider silently drops the retry's spend.
		const first = prepareUsageReport(step())?.report.idempotencyKey
		const second = prepareUsageReport(step())?.report.idempotencyKey
		expect(first).not.toBe(second)
		expect(first).toStartWith("sess_1:turn_1:0:")
		expect(second).toStartWith("sess_1:turn_1:0:")
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
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({ teamId: "T1", inputTokens: 120 })
		expect(calls[0]?.idempotencyKey).toStartWith("sess_1:turn_1:0:")
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

	test("warns once per window when steps are skipped for zero tokens", async () => {
		// If the provider never surfaces usage, EVERY step is skipped and nothing
		// is ever billed — that has to be visible in the logs, not silent.
		resetZeroTokenDiagnosticsForTests()
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (line: unknown) => {
			warnings.push(String(line))
		}
		try {
			const zero = step({ inputTokens: 0, outputTokens: 0 })
			const deps = { reportTokenUsage: async () => {} }
			await trackStepUsage(zero, deps)
			await trackStepUsage(zero, deps)
			await trackStepUsage(zero, deps)
		} finally {
			console.warn = originalWarn
			resetZeroTokenDiagnosticsForTests()
		}

		// Throttled to the first of the window, not one line per skipped step.
		const zeroTokenLines = warnings.filter((line) => line.includes("usage_report_zero_tokens"))
		expect(zeroTokenLines).toHaveLength(1)
		expect(zeroTokenLines[0]).toContain("maple.ai.zero_token_steps")
	})

	test("does not warn about zero tokens when there is simply no team to bill", async () => {
		resetZeroTokenDiagnosticsForTests()
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (line: unknown) => {
			warnings.push(String(line))
		}
		try {
			await trackStepUsage(step({ teamId: undefined }), { reportTokenUsage: async () => {} })
		} finally {
			console.warn = originalWarn
			resetZeroTokenDiagnosticsForTests()
		}
		expect(warnings.filter((line) => line.includes("usage_report_zero_tokens"))).toHaveLength(0)
	})
})
