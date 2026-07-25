import { describe, expect, it } from "vitest"
import { applySchemaFeatures, reconcileSchemaFeatures } from "./apply"

describe("applySchemaFeatures", () => {
	it("skips unsupported features without executing or recording them", async () => {
		const executed: string[] = []
		const recorded: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "24.8.12",
			appliedFeatureRevisions: new Map(),
			execute: async (sql) => {
				executed.push(sql)
				return ""
			},
			record: async (feature) => {
				recorded.push(feature.id)
			},
		})

		expect(executed).toEqual([])
		expect(recorded).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toContain("requires ClickHouse 26.2.0+")
	})

	it("skips a feature whose revision is already recorded", async () => {
		const executed: string[] = []
		const recorded: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "26.2.1",
			appliedFeatureRevisions: new Map([["search_text_v1", 1]]),
			execute: async (sql) => {
				executed.push(sql)
				return ""
			},
			record: async (feature) => {
				recorded.push(feature.id)
			},
		})

		expect(executed).toEqual([])
		expect(recorded).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toBe("already present")
	})

	it("does not record a partially applied feature and reports the failure", async () => {
		const executed: string[] = []
		const recorded: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "26.2.1",
			appliedFeatureRevisions: new Map(),
			execute: async (sql) => {
				executed.push(sql)
				if (executed.length === 2) throw new Error("DDL rejected")
				return ""
			},
			record: async (feature) => {
				recorded.push(feature.id)
			},
		})

		expect(executed).toHaveLength(2)
		expect(recorded).toEqual([])
		expect(result.appliedFeatures).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toBe("DDL rejected")
	})

	it("records only after every statement succeeds", async () => {
		const events: string[] = []
		const result = await applySchemaFeatures({
			serverVersion: "26.2.1",
			appliedFeatureRevisions: new Map(),
			execute: async (sql) => {
				events.push(`execute:${sql}`)
				return ""
			},
			record: async (feature) => {
				events.push(`record:${feature.id}`)
			},
		})

		expect(result.appliedFeatures.map((feature) => feature.id)).toEqual(["search_text_v1"])
		expect(result.skippedFeatures).toEqual([])
		expect(events.at(-1)).toBe("record:search_text_v1")
		expect(events.slice(0, -1).every((event) => event.startsWith("execute:"))).toBe(true)
		expect(events.some((event) => event.includes("MATERIALIZE"))).toBe(false)
	})
})

describe("reconcileSchemaFeatures", () => {
	const optionalAdapters = {
		readServerVersion: async () => "26.2.1",
		readAppliedFeatureRevisions: async () => new Map<string, number>(),
		execute: async () => "",
		record: async () => {},
	}

	it("reports feature bookkeeping creation failures without rejecting", async () => {
		const result = await reconcileSchemaFeatures({
			...optionalAdapters,
			ensureBookkeeping: async () => {
				throw new Error("CREATE TABLE denied")
			},
		})

		expect(result.appliedFeatures).toEqual([])
		expect(result.skippedFeatures).toEqual([
			{
				id: "feature_reconciliation",
				description: "Reconcile optional schema features",
				reason: "CREATE TABLE denied",
			},
		])
	})

	it("reports feature bookkeeping read failures without rejecting", async () => {
		const result = await reconcileSchemaFeatures({
			...optionalAdapters,
			ensureBookkeeping: async () => {},
			readAppliedFeatureRevisions: async () => {
				throw new Error("SELECT denied")
			},
		})

		expect(result.appliedFeatures).toEqual([])
		expect(result.skippedFeatures[0]?.reason).toBe("SELECT denied")
	})
})
