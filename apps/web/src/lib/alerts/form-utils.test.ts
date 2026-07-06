import { AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	buildRuleRequest,
	buildRuleToggleRequest,
	defaultRuleForm,
	deriveRuleQueryIssues,
	domainThresholdToForm,
	formThresholdToDomain,
	rawSqlHasValueColumn,
} from "./form-utils"

describe("rule notes", () => {
	it("defaults to an empty note", () => {
		expect(defaultRuleForm().notes).toBe("")
	})

	it("carries a trimmed note onto the upsert request", () => {
		const request = buildRuleRequest({
			...defaultRuleForm(),
			name: "Error rate",
			notes: "  See runbook: https://wiki/incidents  ",
		})

		expect(request.notes).toBe("See runbook: https://wiki/incidents")
	})

	it("sends null when the note is blank or whitespace-only", () => {
		expect(buildRuleRequest({ ...defaultRuleForm(), name: "A", notes: "" }).notes).toBeNull()
		expect(buildRuleRequest({ ...defaultRuleForm(), name: "A", notes: "   " }).notes).toBeNull()
	})
})

describe("threshold unit conversion", () => {
	it("converts error_rate thresholds between percent (form) and ratio (domain)", () => {
		// User enters 5 (%), domain stores 0.05 (ratio) — the unit the query
		// engine emits and AlertsService compares against.
		expect(formThresholdToDomain("error_rate", "5")).toBe(0.05)
		expect(formThresholdToDomain("error_rate", "50")).toBe(0.5)
		expect(domainThresholdToForm("error_rate", 0.05)).toBe("5")
		expect(domainThresholdToForm("error_rate", 0.5)).toBe("50")
	})

	it("passes non-error_rate thresholds through unchanged", () => {
		expect(formThresholdToDomain("p95_latency", "500")).toBe(500)
		expect(domainThresholdToForm("p95_latency", 500)).toBe("500")
		expect(formThresholdToDomain("throughput", "1000")).toBe(1000)
	})

	it("stores error_rate threshold as a ratio on the upsert request", () => {
		// The default form threshold "5" must round-trip to the 0.05 ratio the
		// MCP tool also uses — so a default error-rate alert can actually fire.
		const request = buildRuleRequest({
			...defaultRuleForm(),
			name: "Error rate",
			signalType: "error_rate",
		})
		expect(request.threshold).toBe(0.05)
	})

	it("keeps latency thresholds in their native units on the upsert request", () => {
		const request = buildRuleRequest({
			...defaultRuleForm(),
			name: "P95",
			signalType: "p95_latency",
			threshold: "500",
		})
		expect(request.threshold).toBe(500)
	})
})

describe("raw SQL alert query validation", () => {
	it("recognizes explicit value aliases and value columns", () => {
		expect(rawSqlHasValueColumn("SELECT count() AS value FROM traces WHERE $__orgFilter")).toBe(true)
		expect(rawSqlHasValueColumn('SELECT "value" FROM traces WHERE $__orgFilter')).toBe(true)
		expect(rawSqlHasValueColumn("SELECT group, value FROM traces WHERE $__orgFilter")).toBe(true)
	})

	it("flags chart-shaped SQL without an alert value column", () => {
		const sql =
			"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS errors FROM traces WHERE $__orgFilter GROUP BY bucket"

		expect(rawSqlHasValueColumn(sql)).toBe(false)
		expect(
			deriveRuleQueryIssues({
				...defaultRuleForm(),
				signalType: "raw_query",
				rawQuerySql: sql,
			}),
		).toEqual(["SQL value column"])
	})
})

// Decode a plain object into a branded `AlertRuleDocument` (as `listRules` would),
// so fixtures pass plain strings/UUIDs and Schema does the branding — no casts.
const decodeRuleDoc = Schema.decodeUnknownSync(AlertRuleDocument)

function makeRuleDoc(
	overrides: Partial<{ enabled: boolean; serviceNames: string[]; excludeServiceNames: string[] }> = {},
): AlertRuleDocument {
	return decodeRuleDoc({
		id: "00000000-0000-4000-8000-000000000000",
		name: "My rule",
		notes: null,
		notificationTemplate: null,
		enabled: true,
		severity: "warning",
		serviceNames: [],
		excludeServiceNames: [],
		tags: [],
		groupBy: null,
		signalType: "error_rate",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		windowMinutes: 5,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 2,
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 30,
		metricName: null,
		metricType: null,
		metricAggregation: null,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: [],
		noDataBehavior: "skip",
		lastEvaluationError: null,
		lastEvaluatedAt: null,
		lastScheduledAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "user_test",
		updatedBy: "user_test",
		...overrides,
	})
}

describe("buildRuleToggleRequest", () => {
	// Regression: `optionalKey(Array)` rejects an explicit `undefined`, so coercing
	// empty service arrays to `undefined` made `new AlertRuleUpsertRequest({...})`
	// throw synchronously — the toggle silently no-op'd and the Switch never moved.
	it("does not throw when serviceNames/excludeServiceNames are empty", () => {
		const rule = makeRuleDoc({ enabled: true, serviceNames: [], excludeServiceNames: [] })
		const request = buildRuleToggleRequest(rule)
		expect(request.enabled).toBe(false)
		expect(request.serviceNames).toEqual([])
		expect(request.excludeServiceNames).toEqual([])
	})

	it("flips enabled in both directions", () => {
		expect(buildRuleToggleRequest(makeRuleDoc({ enabled: false })).enabled).toBe(true)
		expect(buildRuleToggleRequest(makeRuleDoc({ enabled: true })).enabled).toBe(false)
	})

	it("preserves the rule's service scoping", () => {
		const rule = makeRuleDoc({ serviceNames: ["svc-a", "svc-b"], excludeServiceNames: [] })
		const request = buildRuleToggleRequest(rule)
		expect(request.serviceNames).toEqual(["svc-a", "svc-b"])
	})
})
