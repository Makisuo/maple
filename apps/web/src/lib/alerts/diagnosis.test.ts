import { AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { buildDiagnosis, diagnosisVerdict, type DiagnosisInput } from "./diagnosis"

const decodeRuleDoc = Schema.decodeUnknownSync(AlertRuleDocument)

const NOW = Date.parse("2026-07-06T12:00:00.000Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const DEST_ID = "00000000-0000-4000-8000-00000000dddd"

function makeRule(overrides: Record<string, unknown> = {}): AlertRuleDocument {
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
		consecutiveBreachesRequired: 3,
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 30,
		metricName: null,
		metricType: null,
		metricAggregation: null,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: [DEST_ID],
		noDataBehavior: "skip",
		lastEvaluationError: null,
		lastEvaluatedAt: iso(60_000),
		lastScheduledAt: iso(60_000),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "user_test",
		updatedBy: "user_test",
		...overrides,
	})
}

function makeState(overrides: Partial<AlertRuleStateRow> = {}): AlertRuleStateRow {
	return {
		org_id: "org_test",
		rule_id: "00000000-0000-4000-8000-000000000000",
		group_key: "__total__",
		consecutive_breaches: 0,
		consecutive_healthy: 2,
		last_status: "healthy",
		last_value: 0.01,
		last_sample_count: 100,
		last_evaluated_at: iso(60_000),
		last_error: null,
		updated_at: iso(60_000),
		...overrides,
	}
}

const diagnose = (overrides: Partial<DiagnosisInput> = {}) =>
	buildDiagnosis({
		rule: makeRule(),
		states: [makeState()],
		checks: [],
		openIncidents: [],
		destinations: [],
		deliveryEvents: [],
		now: NOW,
		...overrides,
	})

const stage = (stages: ReturnType<typeof buildDiagnosis>, id: string) =>
	stages.find((s) => s.id === id)!

describe("buildDiagnosis", () => {
	it("passes all stages for a healthy delivering rule", () => {
		const stages = diagnose()
		expect(stage(stages, "enabled").status).toBe("pass")
		expect(stage(stages, "evaluated").status).toBe("pass")
		expect(stage(stages, "query").status).toBe("pass")
		expect(stage(stages, "threshold").status).toBe("pass")
		expect(stage(stages, "incident").status).toBe("pass")
	})

	it("fails the enabled stage with an enable action when disabled", () => {
		const stages = diagnose({ rule: makeRule({ enabled: false }) })
		const enabled = stage(stages, "enabled")
		expect(enabled.status).toBe("fail")
		expect(enabled.action?.kind).toBe("enable")
		expect(diagnosisVerdict(stages).summary).toContain("disabled")
	})

	it("fails the query stage with the error message when the state carries lastError", () => {
		const stages = diagnose({ states: [makeState({ last_error: "Unknown column Foo" })] })
		const query = stage(stages, "query")
		expect(query.status).toBe("fail")
		expect(query.evidence).toContain("Unknown column Foo")
		expect(diagnosisVerdict(stages).status).toBe("fail")
	})

	it("marks never-evaluated rules failing on the evaluated stage", () => {
		const stages = diagnose({
			rule: makeRule({ lastEvaluatedAt: null, lastScheduledAt: null }),
			states: [],
		})
		expect(stage(stages, "evaluated").status).toBe("fail")
	})

	it("reports consecutive-breach progress while breaching but not yet firing", () => {
		const stages = diagnose({
			states: [makeState({ last_status: "breached", last_value: 0.5, consecutive_breaches: 1 })],
		})
		const threshold = stage(stages, "threshold")
		expect(threshold.status).toBe("warn")
		expect(threshold.summary).toContain("1 of 3 consecutive breaches")
	})

	it("fails the notification stage when an enabled rule has no destinations", () => {
		const stages = diagnose({ rule: makeRule({ destinationIds: [] }) })
		const notification = stage(stages, "notification")
		expect(notification.status).toBe("fail")
		expect(notification.action?.kind).toBe("destinations")
	})

	it("surfaces per-destination delivery failures with the provider error", () => {
		const stages = diagnose({
			destinations: [
				{
					id: DEST_ID,
					name: "Ops Slack",
					enabled: true,
				} as never,
			],
			deliveryEvents: [
				{
					destinationId: DEST_ID,
					status: "failed",
					responseCode: 404,
					errorMessage: "channel_not_found",
					attemptedAt: iso(120_000),
				} as never,
			],
		})
		const notification = stage(stages, "notification")
		expect(notification.status).toBe("fail")
		expect(notification.evidence[0]).toContain("Ops Slack")
		expect(notification.evidence[0]).toContain("channel_not_found")
	})

	it("fails the data stage when every check in the window was skipped", () => {
		const skippedCheck = { status: "skipped", groupKey: "__total__", sampleCount: 0 } as never
		const stages = diagnose({
			states: [],
			checks: [skippedCheck, skippedCheck],
		})
		expect(stage(stages, "data").status).toBe("fail")
	})
})
