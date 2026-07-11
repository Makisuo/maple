import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"

// The mappers are pure; stub the registry so importing the collection module
// doesn't spin up the ManagedRuntime / atom-registry side effects.
vi.mock("@/lib/registry", () => ({ mapleRuntime: {} }))

import {
	type AlertDestinationRow,
	type AlertIncidentRow,
	type AlertRuleRow,
	type AlertRuleStateRow,
	buildRuleStatesByRuleId,
	rowToAlertDestinationDocument,
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
	no_data_behavior: "skip",
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
		assert.strictEqual(map.get(RULE_ID)?.last_error, "boom")
	})

	it("keeps the first-seen state when none carry an error", () => {
		const map = buildRuleStatesByRuleId([base, { ...base, group_key: "svc:a" }])
		assert.strictEqual(map.get(RULE_ID)?.group_key, "__total__")
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
		assert.strictEqual(doc.id, RULE_ID)
		assert.strictEqual(doc.name, "High error rate")
		assert.strictEqual(doc.enabled, true)
		assert.strictEqual(doc.severity, "warning")
		assert.strictEqual(doc.signalType, "error_rate")
		assert.strictEqual(doc.comparator, "gt")
		assert.strictEqual(doc.threshold, 0.05)
		assert.strictEqual(doc.windowMinutes, 5)
		assert.deepStrictEqual(doc.serviceNames, ["checkout", "api"])
		assert.deepStrictEqual(doc.excludeServiceNames, [])
		assert.deepStrictEqual(doc.tags, ["prod"])
		assert.deepStrictEqual(doc.destinationIds.map(String), [DEST_ID])
		assert.strictEqual(doc.groupBy, null)
		assert.strictEqual(doc.rawQueryReducer, null) // signal_type !== "raw_query"
		assert.strictEqual(doc.notificationTemplate, null)
		assert.strictEqual(doc.createdBy, "user_1")
		assert.strictEqual(doc.updatedBy, "user_2")
		assert.strictEqual(doc.createdAt, "2026-06-01T00:00:00.000Z")
		assert.strictEqual(doc.lastEvaluationError, "evaluation failed")
		assert.strictEqual(doc.lastEvaluatedAt, "2026-07-04T01:00:00.000Z")
	})

	it("leaves evaluation fields null when the rule has no state row", () => {
		const doc = rowToAlertRuleDocument(ruleRow, new Map())
		assert.strictEqual(doc.lastEvaluationError, null)
		assert.strictEqual(doc.lastEvaluatedAt, null)
	})

	it("decodes the raw_query reducer only for raw_query rules", () => {
		const doc = rowToAlertRuleDocument(
			{ ...ruleRow, signal_type: "raw_query", reducer: "sum" },
			new Map(),
		)
		assert.strictEqual(doc.signalType, "raw_query")
		assert.strictEqual(doc.rawQueryReducer, "sum")
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
		assert.strictEqual(doc.id, INCIDENT_ID)
		assert.strictEqual(doc.ruleId, RULE_ID)
		assert.strictEqual(doc.status, "open")
		assert.strictEqual(doc.severity, "critical")
		assert.strictEqual(doc.lastDeliveredEventType, "trigger")
		assert.strictEqual(doc.resolvedAt, null)
		assert.strictEqual(doc.errorIssueId, null)
		assert.strictEqual(doc.firstTriggeredAt, "2026-07-04T00:00:00.000Z")
	})
})

describe("rowToAlertDestinationDocument", () => {
	const base: AlertDestinationRow = {
		id: DEST_ID,
		org_id: "org_1",
		name: "Ops Slack",
		type: "slack",
		enabled: true,
		// Only the public config the browser renders — no secrets (those live in
		// the excluded encrypted columns, which the shape never projects).
		config_json: { summary: "Slack incoming webhook", channelLabel: "#ops" },
		last_tested_at: "2026-07-04T00:00:00.000Z",
		last_test_error: null,
		created_at: "2026-06-01T00:00:00.000Z",
		updated_at: "2026-07-04T00:00:00.000Z",
	}

	it("maps a raw alert_destinations row and derives the public config", () => {
		const doc = rowToAlertDestinationDocument(base)
		assert.strictEqual(doc.id, DEST_ID)
		assert.strictEqual(doc.name, "Ops Slack")
		assert.strictEqual(doc.type, "slack")
		assert.strictEqual(doc.enabled, true)
		assert.strictEqual(doc.summary, "Slack incoming webhook")
		assert.strictEqual(doc.channelLabel, "#ops")
		assert.strictEqual(doc.lastTestedAt, "2026-07-04T00:00:00.000Z")
		assert.strictEqual(doc.lastTestError, null)
		assert.strictEqual(doc.createdAt, "2026-06-01T00:00:00.000Z")
	})

	it("falls back to the server's invalid-config summary when config_json is unusable", () => {
		const doc = rowToAlertDestinationDocument({ ...base, config_json: { nope: true } })
		assert.strictEqual(doc.summary, "Invalid destination config")
		assert.strictEqual(doc.channelLabel, null)
	})

	it("leaves lastTestedAt null when the destination was never tested", () => {
		const doc = rowToAlertDestinationDocument({ ...base, last_tested_at: null })
		assert.strictEqual(doc.lastTestedAt, null)
	})
})
