import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import type { AnomalyIncidentId, ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import type {
	AnomalyIncidentSeverity,
	AnomalyIncidentStatus,
	AnomalyResolveReason,
	AnomalySensitivity,
	AnomalySignalType,
	AnomalyTriageStatus,
} from "@maple/domain/http"

/**
 * One row per org. Doubles as the org-level claim lock for the anomaly
 * detector tick (CAS on lastTickAt, mirroring alert_rules.lastScheduledAt).
 * The detector is zero-config: a missing row means defaults (enabled).
 */
export const anomalyDetectorSettings = pgTable("anomaly_detector_settings", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: boolean("enabled").notNull().default(true),
	sensitivity: text("sensitivity").$type<AnomalySensitivity>().notNull().default("normal"),
	mutedSignalsJson: jsonb("muted_signals_json").$type<ReadonlyArray<string>>().notNull().default([]),
	lastTickAt: timestamp("last_tick_at", { withTimezone: true, mode: "date" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedBy: text("updated_by").$type<UserId>(),
})

/**
 * Hysteresis + cooldown state per detector series (clone of the
 * alert_rule_states mechanics, keyed by detectorKey instead of rule/group).
 * detectorKey = `${signalType}:${deploymentEnv}:${serviceName}` or
 * `error_spike:${deploymentEnv}:${fingerprintHash}`.
 */
export const anomalyDetectorStates = pgTable(
	"anomaly_detector_states",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		detectorKey: text("detector_key").notNull(),
		signalType: text("signal_type").$type<AnomalySignalType>().notNull(),
		serviceName: text("service_name").notNull(),
		deploymentEnv: text("deployment_env").notNull().default(""),
		fingerprintHash: text("fingerprint_hash"),
		consecutiveBreaches: integer("consecutive_breaches").notNull().default(0),
		consecutiveHealthy: integer("consecutive_healthy").notNull().default(0),
		lastStatus: text("last_status"),
		lastValue: doublePrecision("last_value"),
		baselineMedian: doublePrecision("baseline_median"),
		lastSampleCount: integer("last_sample_count"),
		lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true, mode: "date" }),
		openIncidentId: text("open_incident_id").$type<AnomalyIncidentId>(),
		lastResolvedAt: timestamp("last_resolved_at", { withTimezone: true, mode: "date" }),
		/** Most recent incident this series opened or fed — reopen target after a resolve. */
		lastIncidentId: text("last_incident_id").$type<AnomalyIncidentId>(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.detectorKey] }),
		// No standalone org_id index: the primary key already leads with org_id,
		// so one was pure write amplification on ~130k upserts a day.
		// Partial: every read of this index either equals a concrete incident id or
		// asks for the open slice, and open rows are a small fraction of the table.
		index("anomaly_detector_states_open_incident_idx")
			.on(table.orgId, table.openIncidentId)
			.where(sql`${table.openIncidentId} is not null`),
		index("anomaly_detector_states_evaluated_idx").on(table.lastEvaluatedAt),
	],
)

/**
 * An anomaly flare-up for one detector series. Self-explaining: carries the
 * observed value, baseline stats, and threshold at open time so the UI and
 * the AI triage prompt can describe the deviation without re-querying.
 */
export const anomalyIncidents = pgTable(
	"anomaly_incidents",
	{
		id: text("id").$type<AnomalyIncidentId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		detectorKey: text("detector_key").notNull(),
		signalType: text("signal_type").$type<AnomalySignalType>().notNull(),
		serviceName: text("service_name").notNull(),
		deploymentEnv: text("deployment_env").notNull().default(""),
		fingerprintHash: text("fingerprint_hash"),
		errorIssueId: text("error_issue_id").$type<ErrorIssueId>(),
		status: text("status").$type<AnomalyIncidentStatus>().notNull(),
		severity: text("severity").$type<AnomalyIncidentSeverity>().notNull(),
		openedValue: doublePrecision("opened_value").notNull(),
		baselineMedian: doublePrecision("baseline_median").notNull(),
		baselineSigma: doublePrecision("baseline_sigma").notNull(),
		thresholdValue: doublePrecision("threshold_value").notNull(),
		lastObservedValue: doublePrecision("last_observed_value").notNull(),
		lastSampleCount: integer("last_sample_count").notNull().default(0),
		firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true, mode: "date" }).notNull(),
		lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true, mode: "date" }).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
		resolveReason: text("resolve_reason").$type<AnomalyResolveReason>(),
		triageStatus: text("triage_status").$type<AnomalyTriageStatus>().notNull().default("none"),
		dedupeKey: text("dedupe_key").notNull(),
		/**
		 * Error-spike consolidation: all fingerprints sharing this incident
		 * (JSON array of IncidentFingerprintEntry; empty for golden signals).
		 */
		fingerprintsJson: jsonb("fingerprints_json").$type<ReadonlyArray<unknown>>().notNull().default([]),
		/** Times this incident re-breached and reopened within the reopen window. */
		reopenCount: integer("reopen_count").notNull().default(0),
		lastReopenedAt: timestamp("last_reopened_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// (org, status) plus the list ordering: listIncidents filters on the
		// first two and orders by (last_triggered_at DESC, id DESC), so a
		// backward index walk answers the page directly — SELECT
		// anomaly_incidents was ~970ms p95 sorting the org's rows by hand.
		// Replaces anomaly_incidents_org_status_idx, whose prefix this carries.
		index("anomaly_incidents_org_status_triggered_idx").on(
			table.orgId,
			table.status,
			table.lastTriggeredAt,
			table.id,
		),
		index("anomaly_incidents_org_triggered_idx").on(table.orgId, table.lastTriggeredAt),
		index("anomaly_incidents_org_detector_idx").on(table.orgId, table.detectorKey),
		index("anomaly_incidents_org_issue_idx").on(table.orgId, table.errorIssueId),
		// One open incident per detector: the org claim is a bare lastTickAt CAS
		// with no renewal, so a tick that outruns ORG_LOCK_TTL_MS can overlap the
		// next one — this turns the duplicate open into a no-op/loud conflict
		// instead of two incidents, two triages, two pages.
		uniqueIndex("anomaly_incidents_open_detector_idx")
			.on(table.orgId, table.detectorKey)
			.where(sql`${table.status} = 'open'`),
	],
)

export type AnomalyDetectorSettingsRow = typeof anomalyDetectorSettings.$inferSelect
export type AnomalyDetectorStateRow = typeof anomalyDetectorStates.$inferSelect
export type AnomalyDetectorStateInsert = typeof anomalyDetectorStates.$inferInsert
export type AnomalyIncidentRow = typeof anomalyIncidents.$inferSelect
export type AnomalyIncidentInsert = typeof anomalyIncidents.$inferInsert
