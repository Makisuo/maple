import { describe, expect, it } from "vitest"
import { appendSettings, detectQuotaSetting, QueryProfile, resolveSettings } from "./TinybirdQueryProfile"

describe("appendSettings", () => {
	it("returns sql unchanged when settings are undefined", () => {
		expect(appendSettings("SELECT 1", undefined)).toBe("SELECT 1")
	})

	it("returns sql unchanged when settings are empty", () => {
		expect(appendSettings("SELECT 1", {})).toBe("SELECT 1")
	})

	it("appends a single setting", () => {
		expect(appendSettings("SELECT 1", { maxExecutionTime: 10 })).toBe(
			"SELECT 1 SETTINGS max_execution_time=10",
		)
	})

	it("appends multiple settings comma-separated", () => {
		expect(
			appendSettings("SELECT 1", {
				maxExecutionTime: 10,
				maxMemoryUsage: 1_000_000,
				maxThreads: 4,
			}),
		).toBe("SELECT 1 SETTINGS max_execution_time=10, max_memory_usage=1000000, max_threads=4")
	})

	it("strips trailing semicolon before appending", () => {
		expect(appendSettings("SELECT 1;", { maxExecutionTime: 5 })).toBe(
			"SELECT 1 SETTINGS max_execution_time=5",
		)
	})

	it("ignores undefined / non-finite values", () => {
		expect(
			appendSettings("SELECT 1", {
				maxExecutionTime: undefined,
				maxMemoryUsage: NaN,
				maxThreads: 2,
			}),
		).toBe("SELECT 1 SETTINGS max_threads=2")
	})
})

describe("resolveSettings", () => {
	it("returns undefined when no options", () => {
		expect(resolveSettings(undefined)).toBeUndefined()
		expect(resolveSettings({})).toBeUndefined()
	})

	it("returns profile defaults", () => {
		expect(resolveSettings({ profile: "discovery" })).toEqual(QueryProfile.discovery)
	})

	it("merges explicit settings on top of profile", () => {
		expect(resolveSettings({ profile: "discovery", settings: { maxExecutionTime: 99 } })).toEqual({
			...QueryProfile.discovery,
			maxExecutionTime: 99,
		})
	})

	it("unbounded profile yields no settings", () => {
		expect(resolveSettings({ profile: "unbounded" })).toEqual({})
	})

	it("explicit settings without profile pass through", () => {
		expect(resolveSettings({ settings: { maxThreads: 8 } })).toEqual({ maxThreads: 8 })
	})
})

describe("detectQuotaSetting", () => {
	it("matches max_execution_time errors", () => {
		expect(detectQuotaSetting("DB::Exception: Code: 159. TIMEOUT_EXCEEDED")).toBe("max_execution_time")
		expect(detectQuotaSetting("estimated query execution time exceeded")).toBe("max_execution_time")
		// Real Tinybird error format observed in production
		expect(
			detectQuotaSetting("[Error] Timeout exceeded: elapsed 1.0009 seconds, maximum: 1 seconds."),
		).toBe("max_execution_time")
	})

	it("matches max_memory_usage errors", () => {
		expect(detectQuotaSetting("Memory limit (for query) exceeded")).toBe("max_memory_usage")
		expect(detectQuotaSetting("MEMORY_LIMIT_EXCEEDED something")).toBe("max_memory_usage")
	})

	it("returns undefined on unrelated messages", () => {
		expect(detectQuotaSetting("Resource 'foo' not found")).toBeUndefined()
		expect(detectQuotaSetting(undefined)).toBeUndefined()
	})

	// Regression: production saw an UNKNOWN_IDENTIFIER (code 47) error tagged
	// as TinybirdQuotaExceededError because the old regex matched the bare
	// substring `max_execution_time` inside the SETTINGS clause that ClickHouse
	// echoes back in every error message.
	const PROD_UNKNOWN_IDENTIFIER_MESSAGE =
		"Unknown expression or function identifier 'SampleRate' in scope SELECT toStartOfInterval(Timestamp, toIntervalSecond(3600)) AS bucket FROM service_overview_spans WHERE OrgId = 'org_1' SETTINGS max_execution_time = 30, max_memory_usage = 4000000000."

	it("does not mis-classify UNKNOWN_IDENTIFIER as a quota error (with structured fields)", () => {
		expect(
			detectQuotaSetting(PROD_UNKNOWN_IDENTIFIER_MESSAGE, "47", "UNKNOWN_IDENTIFIER"),
		).toBeUndefined()
	})

	it("does not mis-classify UNKNOWN_IDENTIFIER as a quota error (message only)", () => {
		// Even without structured code/type, the tightened patterns must
		// ignore the echoed `SETTINGS max_execution_time = ...` clause.
		expect(detectQuotaSetting(PROD_UNKNOWN_IDENTIFIER_MESSAGE)).toBeUndefined()
	})

	it("classifies by ClickHouse code first", () => {
		expect(detectQuotaSetting("anything", "159")).toBe("max_execution_time")
		expect(detectQuotaSetting("anything", "241")).toBe("max_memory_usage")
		// Non-quota codes return undefined even when the message looks ambiguous
		expect(detectQuotaSetting("Memory limit (for query) exceeded", "47")).toBeUndefined()
	})

	it("classifies by ClickHouse type when code is missing", () => {
		expect(detectQuotaSetting("anything", undefined, "TIMEOUT_EXCEEDED")).toBe(
			"max_execution_time",
		)
		expect(detectQuotaSetting("anything", undefined, "MEMORY_LIMIT_EXCEEDED")).toBe(
			"max_memory_usage",
		)
		expect(detectQuotaSetting("anything", undefined, "UNKNOWN_IDENTIFIER")).toBeUndefined()
	})
})
