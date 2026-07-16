import { AlertRuleDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { deriveRuleStatus, needsAttention, staleThresholdMs, worstState } from "./rule-status"

const decodeRuleDoc = Schema.decodeUnknownSync(AlertRuleDocument)

const NOW = Date.parse("2026-07-06T12:00:00.000Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

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

const incident = { status: "open" } as never

const derive = (
	overrides: {
		rule?: AlertRuleDocument
		states?: AlertRuleStateRow[]
		openIncidents?: ReadonlyArray<never>
		deliveryEvents?: ReadonlyArray<{ status: string }>
	} = {},
) =>
	deriveRuleStatus({
		rule: overrides.rule ?? makeRule(),
		states: overrides.states ?? [makeState()],
		openIncidents: overrides.openIncidents ?? [],
		deliveryEvents: (overrides.deliveryEvents ?? []) as never,
		now: NOW,
	})

describe("deriveRuleStatus", () => {
	it("is healthy for a recently evaluated clean rule", () => {
		expect(derive().status).toBe("healthy")
	})

	it("disabled outranks everything", () => {
		const result = derive({
			rule: makeRule({ enabled: false, lastEvaluationError: "boom" }),
			openIncidents: [incident],
		})
		expect(result.status).toBe("disabled")
	})

	it("firing outranks error", () => {
		const result = derive({
			states: [makeState({ last_error: "query failed" })],
			openIncidents: [incident],
		})
		expect(result.status).toBe("firing")
	})

	it("surfaces evaluation errors from state rows with the message as reason", () => {
		const result = derive({ states: [makeState({ last_error: "Unknown column Foo" })] })
		expect(result.status).toBe("error")
		expect(result.reason).toBe("Unknown column Foo")
	})

	it("falls back to the rule document error when states are unavailable (non-Electric)", () => {
		const result = derive({ rule: makeRule({ lastEvaluationError: "boom" }), states: [] })
		expect(result.status).toBe("error")
	})

	it("marks never-evaluated rules stale", () => {
		const result = derive({
			rule: makeRule({ lastEvaluatedAt: null }),
			states: [makeState({ last_evaluated_at: null })],
		})
		expect(result.status).toBe("stale")
		expect(result.reason).toBe("Never evaluated")
	})

	it("marks rules stale past 3x max(window, cadence)", () => {
		const rule = makeRule({ lastEvaluatedAt: iso(staleThresholdMs(makeRule()) + 60_000) })
		const result = derive({
			rule,
			states: [makeState({ last_evaluated_at: rule.lastEvaluatedAt })],
		})
		expect(result.status).toBe("stale")
	})

	it("reports no-data only when every group last skipped", () => {
		expect(derive({ states: [makeState({ last_status: "skipped" })] }).status).toBe("no-data")
		expect(
			derive({
				states: [makeState({ last_status: "skipped" }), makeState({ group_key: "svc-b" })],
			}).status,
		).toBe("healthy")
	})

	it("flags missing destinations and delivery failures as attention", () => {
		const result = derive({
			rule: makeRule({ destinationIds: [] }),
			deliveryEvents: [{ status: "failed" }],
		})
		expect(result.status).toBe("healthy")
		expect(result.attention.noDestinations).toBe(true)
		expect(result.attention.recentDeliveryFailure).toBe(true)
		expect(needsAttention(result)).toBe(true)
	})
})

describe("worstState", () => {
	it("prefers breached over error over skipped over healthy", () => {
		const healthy = makeState()
		const skipped = makeState({ group_key: "a", last_status: "skipped" })
		const errored = makeState({ group_key: "b", last_error: "boom" })
		const breached = makeState({ group_key: "c", last_status: "breached" })
		expect(worstState([healthy, skipped, errored, breached])).toBe(breached)
		expect(worstState([healthy, skipped, errored])).toBe(errored)
		expect(worstState([healthy, skipped])).toBe(skipped)
		expect(worstState([])).toBeNull()
	})

	it("breaks ties by most recent evaluation", () => {
		const older = makeState({ group_key: "a", last_evaluated_at: iso(600_000) })
		const newer = makeState({ group_key: "b", last_evaluated_at: iso(30_000) })
		expect(worstState([older, newer])).toBe(newer)
	})
})
