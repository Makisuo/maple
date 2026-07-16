import { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { deriveOverview } from "./alerts-overview-model"

const decodeRuleDoc = Schema.decodeUnknownSync(AlertRuleDocument)
const decodeIncidentDoc = Schema.decodeUnknownSync(AlertIncidentDocument)

const NOW = Date.parse("2026-07-06T12:00:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const RULE_A = "00000000-0000-4000-8000-00000000000a"
const RULE_B = "00000000-0000-4000-8000-00000000000b"

function makeRule(overrides: Record<string, unknown> = {}): AlertRuleDocument {
	return decodeRuleDoc({
		id: RULE_A,
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
		destinationIds: ["00000000-0000-4000-8000-00000000dddd"],
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

function makeIncident(overrides: Record<string, unknown> = {}): AlertIncidentDocument {
	return decodeIncidentDoc({
		id: "00000000-0000-4000-8000-0000000000f1",
		ruleId: RULE_A,
		ruleName: "My rule",
		groupKey: null,
		signalType: "error_rate",
		severity: "warning",
		status: "open",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		firstTriggeredAt: iso(10 * 60_000),
		lastTriggeredAt: iso(60_000),
		resolvedAt: null,
		lastObservedValue: 0.2,
		lastSampleCount: 100,
		dedupeKey: "dedupe",
		lastDeliveredEventType: null,
		lastNotifiedAt: null,
		errorIssueId: null,
		...overrides,
	})
}

function makeState(overrides: Partial<AlertRuleStateRow> = {}): AlertRuleStateRow {
	return {
		org_id: "org_test",
		rule_id: RULE_A,
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

describe("deriveOverview", () => {
	it("orders rules newest-updated first and incidents newest-triggered first", () => {
		const overview = deriveOverview({
			rules: [
				makeRule({ id: RULE_A, updatedAt: iso(2 * DAY_MS) }),
				makeRule({ id: RULE_B, updatedAt: iso(60_000) }),
			],
			incidents: [
				makeIncident({ id: "00000000-0000-4000-8000-0000000000f1", lastTriggeredAt: iso(3 * 60_000) }),
				makeIncident({ id: "00000000-0000-4000-8000-0000000000f2", lastTriggeredAt: iso(60_000) }),
			],
			states: [],
			deliveryEvents: [],
			now: NOW,
		})
		expect(overview.rules.map((r) => r.id)).toEqual([RULE_B, RULE_A])
		expect(overview.incidents.map((i) => i.id)).toEqual([
			"00000000-0000-4000-8000-0000000000f2",
			"00000000-0000-4000-8000-0000000000f1",
		])
	})

	it("derives per-rule statuses and tallies health counts", () => {
		const overview = deriveOverview({
			rules: [
				makeRule({ id: RULE_A }),
				makeRule({ id: RULE_B, enabled: false }),
			],
			incidents: [makeIncident({ ruleId: RULE_A })],
			states: [makeState({ rule_id: RULE_A })],
			deliveryEvents: [],
			now: NOW,
		})
		expect(overview.derivedByRuleId.get(RULE_A)?.status).toBe("firing")
		expect(overview.derivedByRuleId.get(RULE_B)?.status).toBe("disabled")
		// Firing-with-destinations and disabled rules don't need attention.
		expect(overview.healthCounts).toEqual({ firing: 1, attention: 0, healthy: 0, disabled: 1 })
		expect(overview.openIncidents).toHaveLength(1)
		expect(overview.incidentsByRule.get(RULE_A)).toHaveLength(1)
	})

	it("only counts open incidents toward firing", () => {
		const overview = deriveOverview({
			rules: [makeRule({ id: RULE_A })],
			incidents: [makeIncident({ ruleId: RULE_A, status: "resolved", resolvedAt: iso(30_000) })],
			states: [makeState({ rule_id: RULE_A })],
			deliveryEvents: [],
			now: NOW,
		})
		expect(overview.derivedByRuleId.get(RULE_A)?.status).toBe("healthy")
		expect(overview.openIncidents).toHaveLength(0)
		// Resolved incidents still show in the per-rule history map.
		expect(overview.incidentsByRule.get(RULE_A)).toHaveLength(1)
	})

	it("spans a 24h timeline ending at now", () => {
		const overview = deriveOverview({ rules: [], incidents: [], states: [], deliveryEvents: [], now: NOW })
		expect(overview.timelineRange).toEqual({ min: NOW - DAY_MS, max: NOW })
	})
})
