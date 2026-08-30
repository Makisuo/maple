import { afterEach, describe, expect, test } from "bun:test"
import { addStepUsage, resetTurnUsageForTests, takeTurnUsage } from "./usage-report.js"

describe("turn usage accumulation", () => {
	afterEach(() => {
		resetTurnUsageForTests()
	})

	test("sums step usage per turn and keeps turns independent", () => {
		addStepUsage("turn-1", { inputTokens: 100, outputTokens: 20 })
		addStepUsage("turn-1", { inputTokens: 250, outputTokens: 35 })
		addStepUsage("turn-2", { inputTokens: 7, outputTokens: 3 })

		expect(takeTurnUsage("turn-1")).toEqual({ inputTokens: 350, outputTokens: 55 })
		expect(takeTurnUsage("turn-2")).toEqual({ inputTokens: 7, outputTokens: 3 })
	})

	test("treats missing usage and missing fields as zero", () => {
		addStepUsage("turn-1", undefined)
		addStepUsage("turn-1", {})
		addStepUsage("turn-1", { inputTokens: 40 })
		addStepUsage("turn-1", { outputTokens: 8 })

		expect(takeTurnUsage("turn-1")).toEqual({ inputTokens: 40, outputTokens: 8 })
	})

	test("returns null for a turn that never accumulated usage", () => {
		expect(takeTurnUsage("turn-unknown")).toBeNull()
	})

	test("take removes the totals so a duplicate flush cannot bill twice", () => {
		addStepUsage("turn-1", { inputTokens: 10, outputTokens: 5 })
		expect(takeTurnUsage("turn-1")).toEqual({ inputTokens: 10, outputTokens: 5 })
		expect(takeTurnUsage("turn-1")).toBeNull()
	})
})
