import { describe, expect, it, vi } from "vitest"

// The mappers are pure; stub the registry so importing the collection module
// doesn't spin up the ManagedRuntime / atom-registry side effects.
vi.mock("@/lib/registry", () => ({ mapleRuntime: {} }))

import {
	type AlertIncidentRow,
	type AlertRuleRow,
	type AlertRuleStateRow,
	buildRuleStatesByRuleId,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "./alerts"

const RULE_ID = "99999999-8888-4777-8666-555544443333"
const INCIDENT_ID = "aaaa1111-2222-4333-8444-555566667777"
const DEST_ID = "abababab-cdcd-4efe-8aba-121212121212"

const ruleRow: AlertRuleRow = {
	id: RULE_ID,
	org_id: "org_1",
	name: "High error rate",
	notes: null,
	notification_template_json: null,
	enabled: true,
	severity: "warning",
	service_names_json: ["checkout", "api"],
	exclude_service_names_json: null,
	tags_json: ["prod"],
	signal_type: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	threshold_upper: null,
	window_minutes: 5,
	minimum_sample_count: 10,
	consecutive_breaches_required: 2,
	consecutive_healthy_required: 2,
	renotify_interval_minutes: 30,
	metric_name: null,
	metric_type: null,
	metric_aggregation: null,
	apdex_threshold_ms: null,
	query_builder_draft_json: null,
	raw_query_sql: null,
	reducer: "avg",
	group_by: null,
	destination_ids_json: [DEST_ID],
	query_spec_json: null,
	sample_count_strategy: null,
	no_data_behavior: "ignore",
	last_scheduled_at: null,
	created_at: "2026-06-01T00:00:00.000Z",
	updated_at: "2026-07-04T00:00:00.000Z",
	created_by: "user_1",
	updated_by: "user_2",
}

describe("buildRuleStatesByRuleId", () => {
	const base: AlertRuleStateRow = {
		org_id: "org_1",
		rule_id: RULE_ID,
		group_key: "__total__",
		consecutive_breaches: 0,
		consecutive_healthy: 0,
		last_status: null,
		last_value: null,
		last_sample_count: null,
		last_evaluated_at: "2026-07-04T00:00:00.000Z",
		last_error: null,
		updated_at: "2026-07-04T00:00:00.000Z",
	}

	it("prefers the state row carrying a non-null last_error", () => {
		const withError: AlertRuleStateRow = { ...base, group_key: "svc:a", last_error: "boom" }
		const map = buildRuleStatesByRuleId([base, withError])
		expect(map.get(RULE_ID)?.last_error).toBe("boom")
	})

	it("keeps the first-seen state when none carry an error", () => {
		const map = buildRuleStatesByRuleId([base, { ...base, group_key: "svc:a" }])
		expect(map.get(RULE_ID)?.group_key).toBe("__total__")
	})
})

describe("rowToAlertRuleDocument", () => {
	it("maps snake_case columns, decodes json arrays, and joins evaluation state", () => {
		const states = buildRuleStatesByRuleId([
			{
				org_id: "org_1",
				rule_id: RULE_ID,
				group_key: "__total__",
				consecutive_breaches: 1,
				consecutive_healthy: 0,
				last_status: "breaching",
				last_value: 0.2,
				last_sample_count: 100,
				last_evaluated_at: "2026-07-04T01:00:00.000Z",
				last_error: "evaluation failed",
				updated_at: "2026-07-04T01:00:00.000Z",
			},
		])
		const doc = rowToAlertRuleDocument(ruleRow, states)
		expect(doc.id).toBe(RULE_ID)
		expect(doc.name).toBe("High error rate")
		expect(doc.enabled).toBe(true)
		expect(doc.severity).toBe("warning")
		expect(doc.signalType).toBe("error_rate")
		expect(doc.comparator).toBe("gt")
		expect(doc.threshold).toBe(0.05)
		expect(doc.windowMinutes).toBe(5)
		expect(doc.serviceNames).toEqual(["checkout", "api"])
		expect(doc.excludeServiceNames).toEqual([])
		expect(doc.tags).toEqual(["prod"])
		expect(doc.destinationIds).toEqual([DEST_ID])
		expect(doc.groupBy).toBeNull()
		expect(doc.rawQueryReducer).toBeNull() // signal_type !== "raw_query"
		expect(doc.notificationTemplate).toBeNull()
		expect(doc.createdBy).toBe("user_1")
		expect(doc.updatedBy).toBe("user_2")
		expect(doc.createdAt).toBe("2026-06-01T00:00:00.000Z")
		expect(doc.lastEvaluationError).toBe("evaluation failed")
		expect(doc.lastEvaluatedAt).toBe("2026-07-04T01:00:00.000Z")
	})

	it("leaves evaluation fields null when the rule has no state row", () => {
		const doc = rowToAlertRuleDocument(ruleRow, new Map())
		expect(doc.lastEvaluationError).toBeNull()
		expect(doc.lastEvaluatedAt).toBeNull()
	})

	it("decodes the raw_query reducer only for raw_query rules", () => {
		const doc = rowToAlertRuleDocument(
			{ ...ruleRow, signal_type: "raw_query", reducer: "sum" },
			new Map(),
		)
		expect(doc.signalType).toBe("raw_query")
		expect(doc.rawQueryReducer).toBe("sum")
	})
})

describe("rowToAlertIncidentDocument", () => {
	it("maps a raw alert_incidents row", () => {
		const row: AlertIncidentRow = {
			id: INCIDENT_ID,
			org_id: "org_1",
			rule_id: RULE_ID,
			incident_key: "key-1",
			rule_name: "High error rate",
			group_key: null,
			signal_type: "error_rate",
			severity: "critical",
			status: "open",
			comparator: "gt",
			threshold: 0.05,
			threshold_upper: null,
			first_triggered_at: "2026-07-04T00:00:00.000Z",
			last_triggered_at: "2026-07-04T01:00:00.000Z",
			resolved_at: null,
			last_observed_value: 0.3,
			last_sample_count: 200,
			last_evaluated_at: "2026-07-04T01:00:00.000Z",
			dedupe_key: "dk-1",
			last_delivered_event_type: "trigger",
			last_notified_at: "2026-07-04T01:00:00.000Z",
			error_issue_id: null,
			created_at: "2026-07-04T00:00:00.000Z",
			updated_at: "2026-07-04T01:00:00.000Z",
		}
		const doc = rowToAlertIncidentDocument(row)
		expect(doc.id).toBe(INCIDENT_ID)
		expect(doc.ruleId).toBe(RULE_ID)
		expect(doc.status).toBe("open")
		expect(doc.severity).toBe("critical")
		expect(doc.lastDeliveredEventType).toBe("trigger")
		expect(doc.resolvedAt).toBeNull()
		expect(doc.errorIssueId).toBeNull()
		expect(doc.firstTriggeredAt).toBe("2026-07-04T00:00:00.000Z")
	})
})
