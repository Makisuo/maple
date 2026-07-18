import { describe, expect, it } from "vitest"
import {
	buildRuleCreateParamsV2,
	defaultRuleForm,
	deriveRuleQueryIssues,
	domainThresholdToForm,
	formThresholdToDomain,
	rawSqlHasValueColumn,
	v2CheckToDocument,
	v2PreviewToResponse,
} from "./form-utils"

describe("rule notes", () => {
	it("defaults to an empty note", () => {
		expect(defaultRuleForm().notes).toBe("")
	})

	it("carries a trimmed note onto the create params", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Error rate",
			notes: "  See runbook: https://wiki/incidents  ",
		})

		expect(params.notes).toBe("See runbook: https://wiki/incidents")
	})

	it("sends null when the note is blank or whitespace-only", () => {
		expect(buildRuleCreateParamsV2({ ...defaultRuleForm(), name: "A", notes: "" }).notes).toBeNull()
		expect(buildRuleCreateParamsV2({ ...defaultRuleForm(), name: "A", notes: "   " }).notes).toBeNull()
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

	it("stores error_rate threshold as a ratio on the create params", () => {
		// The default form threshold "5" must round-trip to the 0.05 ratio the
		// MCP tool also uses — so a default error-rate alert can actually fire.
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Error rate",
			signalType: "error_rate",
		})
		expect(params.threshold).toBe(0.05)
	})

	it("keeps latency thresholds in their native units on the create params", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "P95",
			signalType: "p95_latency",
			threshold: "500",
		})
		expect(params.threshold).toBe(500)
	})
})

describe("buildRuleCreateParamsV2", () => {
	it("dedupes destination ids", () => {
		const form = defaultRuleForm()
		const params = buildRuleCreateParamsV2({
			...form,
			name: "A",
			destinationIds: [...form.destinationIds, ...form.destinationIds],
		})
		expect(params.destination_ids).toEqual([...new Set(params.destination_ids)])
	})

	it("empties the rule-level scope for query-owned signals", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Builder",
			signalType: "builder_query",
			serviceNames: ["checkout"],
			excludeServiceNames: ["internal"],
			groupBy: ["service.name"],
		})
		expect(params.service_names).toEqual([])
		expect(params.exclude_service_names).toEqual([])
		expect(params.group_by).toBeNull()
		expect(params.query_builder_draft).not.toBeNull()
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

describe("v2 response mappers", () => {
	it("maps a v2 preview result onto the camelCase domain response", () => {
		const response = v2PreviewToResponse({
			object: "alert_rule.preview",
			bucket_seconds: 300,
			window_minutes: 5,
			threshold: 0.05,
			threshold_upper: null,
			comparator: "gt",
			truncated_to_start: "2026-07-15T00:00:00.000Z",
			series: [
				{
					group_key: "__total__",
					points: [
						{
							bucket: "2026-07-15T09:10:00.000Z",
							value: 0.09,
							sample_count: 132,
							status: "breached",
							provisional: true,
						},
					],
				},
			],
			would_fire: [
				{
					group_key: "__total__",
					start: "2026-07-15T09:10:00.000Z",
					end: "2026-07-15T09:40:00.000Z",
				},
			],
		})

		expect(response.bucketSeconds).toBe(300)
		expect(response.windowMinutes).toBe(5)
		expect(response.truncatedToStart).toBe("2026-07-15T00:00:00.000Z")
		expect(response.series[0]?.groupKey).toBe("__total__")
		expect(response.series[0]?.points[0]).toMatchObject({
			bucket: "2026-07-15T09:10:00.000Z",
			value: 0.09,
			sampleCount: 132,
			status: "breached",
			provisional: true,
		})
		expect(response.wouldFire[0]).toMatchObject({
			groupKey: "__total__",
			start: "2026-07-15T09:10:00.000Z",
			end: "2026-07-15T09:40:00.000Z",
		})
	})

	it("maps a v2 check onto the camelCase domain document", () => {
		const document = v2CheckToDocument({
			object: "alert_check",
			timestamp: "2026-07-15T09:10:00.000Z",
			group_key: "__total__",
			status: "breached",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			threshold_upper: null,
			observed_value: 0.09,
			sample_count: 132,
			window_minutes: 5,
			window_start: "2026-07-15T09:05:00.000Z",
			window_end: "2026-07-15T09:10:00.000Z",
			consecutive_breaches: 2,
			consecutive_healthy: 0,
			incident_id: null,
			incident_transition: "opened",
			evaluation_duration_ms: 412,
			error_message: null,
			error_category: null,
		})

		expect(document).toMatchObject({
			timestamp: "2026-07-15T09:10:00.000Z",
			groupKey: "__total__",
			status: "breached",
			signalType: "error_rate",
			observedValue: 0.09,
			sampleCount: 132,
			windowStart: "2026-07-15T09:05:00.000Z",
			windowEnd: "2026-07-15T09:10:00.000Z",
			consecutiveBreaches: 2,
			consecutiveHealthy: 0,
			incidentId: null,
			incidentTransition: "opened",
			evaluationDurationMs: 412,
		})
	})
})
