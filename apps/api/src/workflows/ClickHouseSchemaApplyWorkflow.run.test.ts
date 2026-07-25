import { describe, expect, it } from "@effect/vitest"
import { loadOptionalFeatureState } from "./ClickHouseSchemaApplyWorkflow.run"

describe("loadOptionalFeatureState", () => {
	const successfulReads = {
		readServerVersion: async () => "26.2.1",
		readAppliedFeatureRevisions: async () => new Map([["search_text_v1", 1]]),
	}

	it("turns feature bookkeeping creation failure into an unavailable optional state", async () => {
		const state = await loadOptionalFeatureState({
			...successfulReads,
			ensureBookkeeping: async () => {
				throw new Error("CREATE TABLE denied")
			},
		})

		expect(state).toEqual({ available: false, reason: "CREATE TABLE denied" })
	})

	it("turns feature bookkeeping read failure into an unavailable optional state", async () => {
		const state = await loadOptionalFeatureState({
			...successfulReads,
			ensureBookkeeping: async () => {},
			readAppliedFeatureRevisions: async () => {
				throw new Error("SELECT denied")
			},
		})

		expect(state).toEqual({ available: false, reason: "SELECT denied" })
	})

	it("returns the server and applied revisions only after every optional read succeeds", async () => {
		const state = await loadOptionalFeatureState({
			...successfulReads,
			ensureBookkeeping: async () => {},
		})

		expect(state.available).toBe(true)
		if (state.available) {
			expect(state.serverVersion).toBe("26.2.1")
			expect([...state.appliedFeatureRevisions]).toEqual([["search_text_v1", 1]])
		}
	})
})
