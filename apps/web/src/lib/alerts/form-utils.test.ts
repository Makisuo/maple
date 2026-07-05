import { AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	buildRuleRequest,
	buildRuleToggleRequest,
	defaultRuleForm,
	deriveRuleQueryIssues,
	domainThresholdToForm,
	flattenAlertChartData,
	formThresholdToDomain,
	rawSqlHasValueColumn,
	signalToQueryParams,
	type RuleFormState,
} from "./form-utils"

const makePoint = (bucket: string, series: Record<string, number>) => ({ bucket, series })

function queryRuleForm(overrides: Partial<RuleFormState["queryBuilderDraft"]>): RuleFormState {
	const base = defaultRuleForm()
	const groupBy = "groupBy" in overrides ? (overrides.groupBy ?? []) : []
	const queryBuilderDraft = {
		...base.queryBuilderDraft,
		...overrides,
		addOns: {
			groupBy: groupBy.length > 0,
			having: false,
			orderBy: false,
			limit: false,
			legend: false,
			...overrides.addOns,
		},
		groupBy,
	} as RuleFormState["queryBuilderDraft"]
	return {
		...base,
		signalType: "builder_query" as const,
		queryBuilderDraft,
	}
}

describe("flattenAlertChartData", () => {
	it("filters to only selected services when multiple are specified", () => {
		const points = [
			makePoint("2026-03-25 10:00:00", { "svc-a": 1.5, "svc-b": 2.0, "svc-c": 3.0 }),
			makePoint("2026-03-25 10:05:00", { "svc-a": 1.8, "svc-b": 2.5, "svc-c": 0.5 }),
		]

		const result = flattenAlertChartData(points, ["svc-a", "svc-b"])

		expect(result).toEqual([
			{ bucket: "2026-03-25 10:00:00", "svc-a": 1.5, "svc-b": 2.0 },
			{ bucket: "2026-03-25 10:05:00", "svc-a": 1.8, "svc-b": 2.5 },
		])
	})

	it("remaps series key to the service name for single service", () => {
		const points = [
			makePoint("2026-03-25 10:00:00", { "svc-a": 4.2 }),
			makePoint("2026-03-25 10:05:00", { "svc-a": 3.1 }),
		]

		const result = flattenAlertChartData(points, ["svc-a"])

		expect(result).toEqual([
			{ bucket: "2026-03-25 10:00:00", "svc-a": 4.2 },
			{ bucket: "2026-03-25 10:05:00", "svc-a": 3.1 },
		])
	})

	it("defaults to 0 when single service is missing from series", () => {
		const points = [makePoint("2026-03-25 10:00:00", { all: 5.0 })]

		const result = flattenAlertChartData(points, ["svc-a"])

		expect(result).toEqual([{ bucket: "2026-03-25 10:00:00", "svc-a": 0 }])
	})

	it("passes through all series keys when no services specified", () => {
		const points = [makePoint("2026-03-25 10:00:00", { "svc-a": 1.0, "svc-b": 2.0, "svc-c": 3.0 })]

		const result = flattenAlertChartData(points, [])

		expect(result).toEqual([{ bucket: "2026-03-25 10:00:00", "svc-a": 1.0, "svc-b": 2.0, "svc-c": 3.0 }])
	})

	it("skips selected services not present in series data", () => {
		const points = [makePoint("2026-03-25 10:00:00", { "svc-a": 1.0 })]

		const result = flattenAlertChartData(points, ["svc-a", "svc-missing"])

		expect(result).toEqual([{ bucket: "2026-03-25 10:00:00", "svc-a": 1.0 }])
	})

	it("handles empty points array", () => {
		expect(flattenAlertChartData([], ["svc-a"])).toEqual([])
		expect(flattenAlertChartData([], [])).toEqual([])
	})
})

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

describe("signalToQueryParams", () => {
	it("returns null for builder_query — the preview runs the draft through the query-builder path", () => {
		const form = queryRuleForm({
			dataSource: "traces",
			aggregation: "count",
			whereClause: 'service.name = "checkout"',
		})

		expect(signalToQueryParams(form)).toBeNull()
	})

	it("returns null for raw_query — raw SQL has no structured preview", () => {
		const form: RuleFormState = { ...defaultRuleForm(), signalType: "raw_query" }

		expect(signalToQueryParams(form)).toBeNull()
	})

	it("maps built-in signals to the custom-chart preview params", () => {
		const form: RuleFormState = {
			...defaultRuleForm(),
			signalType: "error_rate",
			serviceNames: ["checkout"],
		}

		expect(signalToQueryParams(form)).toEqual({
			source: "traces",
			metric: "error_rate",
			filters: { serviceName: "checkout", rootSpansOnly: true },
		})
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
		lastEvaluationError: null,
		lastEvaluatedAt: null,
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
