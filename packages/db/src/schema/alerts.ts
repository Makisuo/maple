import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

export const alertDestinations = sqliteTable(
  "alert_destinations",
  {
    id: text("id").notNull().primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    enabled: integer("enabled", { mode: "number" }).notNull().default(1),
    configJson: text("config_json").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    lastTestedAt: integer("last_tested_at", { mode: "number" }),
    lastTestError: text("last_test_error"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    index("alert_destinations_org_idx").on(table.orgId),
    index("alert_destinations_org_enabled_idx").on(table.orgId, table.enabled),
    uniqueIndex("alert_destinations_org_name_idx").on(table.orgId, table.name),
  ],
)

export const alertRules = sqliteTable(
  "alert_rules",
  {
    id: text("id").notNull().primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "number" }).notNull().default(1),
    severity: text("severity").notNull(),
    serviceName: text("service_name"),
    serviceNamesJson: text("service_names_json"),
    signalType: text("signal_type").notNull(),
    comparator: text("comparator").notNull(),
    threshold: real("threshold").notNull(),
    windowMinutes: integer("window_minutes", { mode: "number" }).notNull(),
    minimumSampleCount: integer("minimum_sample_count", { mode: "number" })
      .notNull()
      .default(0),
    consecutiveBreachesRequired: integer(
      "consecutive_breaches_required",
      { mode: "number" },
    )
      .notNull()
      .default(2),
    consecutiveHealthyRequired: integer(
      "consecutive_healthy_required",
      { mode: "number" },
    )
      .notNull()
      .default(2),
    renotifyIntervalMinutes: integer("renotify_interval_minutes", {
      mode: "number",
    })
      .notNull()
      .default(30),
    metricName: text("metric_name"),
    metricType: text("metric_type"),
    metricAggregation: text("metric_aggregation"),
    apdexThresholdMs: real("apdex_threshold_ms"),
    queryDataSource: text("query_data_source"),
    queryAggregation: text("query_aggregation"),
    queryWhereClause: text("query_where_clause"),
    groupBy: text("group_by"),
    destinationIdsJson: text("destination_ids_json").notNull(),
    querySpecJson: text("query_spec_json").notNull(),
    reducer: text("reducer").notNull(),
    sampleCountStrategy: text("sample_count_strategy").notNull(),
    noDataBehavior: text("no_data_behavior").notNull(),
    lastScheduledAt: integer("last_scheduled_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    index("alert_rules_org_idx").on(table.orgId),
    index("alert_rules_org_enabled_idx").on(table.orgId, table.enabled),
    index("alert_rules_org_service_idx").on(table.orgId, table.serviceName),
    uniqueIndex("alert_rules_org_name_idx").on(table.orgId, table.name),
  ],
)

export const alertRuleStates = sqliteTable(
  "alert_rule_states",
  {
    orgId: text("org_id").notNull(),
    ruleId: text("rule_id").notNull(),
    groupKey: text("group_key").notNull().default("__total__"),
    consecutiveBreaches: integer("consecutive_breaches", { mode: "number" })
      .notNull()
      .default(0),
    consecutiveHealthy: integer("consecutive_healthy", { mode: "number" })
      .notNull()
      .default(0),
    lastStatus: text("last_status"),
    lastValue: real("last_value"),
    lastSampleCount: integer("last_sample_count", { mode: "number" }),
    lastEvaluatedAt: integer("last_evaluated_at", { mode: "number" }),
    lastError: text("last_error"),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.ruleId, table.groupKey] }),
    index("alert_rule_states_org_idx").on(table.orgId),
  ],
)

export const alertIncidents = sqliteTable(
  "alert_incidents",
  {
    id: text("id").notNull().primaryKey(),
    orgId: text("org_id").notNull(),
    ruleId: text("rule_id").notNull(),
    incidentKey: text("incident_key").notNull(),
    ruleName: text("rule_name").notNull(),
    serviceName: text("service_name"),
    signalType: text("signal_type").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull(),
    comparator: text("comparator").notNull(),
    threshold: real("threshold").notNull(),
    firstTriggeredAt: integer("first_triggered_at", { mode: "number" }).notNull(),
    lastTriggeredAt: integer("last_triggered_at", { mode: "number" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "number" }),
    lastObservedValue: real("last_observed_value"),
    lastSampleCount: integer("last_sample_count", { mode: "number" }),
    lastEvaluatedAt: integer("last_evaluated_at", { mode: "number" }),
    dedupeKey: text("dedupe_key").notNull(),
    lastDeliveredEventType: text("last_delivered_event_type"),
    lastNotifiedAt: integer("last_notified_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("alert_incidents_org_idx").on(table.orgId),
    index("alert_incidents_org_status_idx").on(table.orgId, table.status),
    index("alert_incidents_org_rule_idx").on(table.orgId, table.ruleId),
    uniqueIndex("alert_incidents_incident_key_idx").on(table.incidentKey),
  ],
)

export const alertDeliveryEvents = sqliteTable(
  "alert_delivery_events",
  {
    id: text("id").notNull().primaryKey(),
    orgId: text("org_id").notNull(),
    incidentId: text("incident_id"),
    ruleId: text("rule_id").notNull(),
    destinationId: text("destination_id").notNull(),
    deliveryKey: text("delivery_key").notNull(),
    eventType: text("event_type").notNull(),
    attemptNumber: integer("attempt_number", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    scheduledAt: integer("scheduled_at", { mode: "number" }).notNull(),
    claimedAt: integer("claimed_at", { mode: "number" }),
    claimExpiresAt: integer("claim_expires_at", { mode: "number" }),
    claimedBy: text("claimed_by"),
    attemptedAt: integer("attempted_at", { mode: "number" }),
    providerMessage: text("provider_message"),
    providerReference: text("provider_reference"),
    responseCode: integer("response_code", { mode: "number" }),
    errorMessage: text("error_message"),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("alert_delivery_events_org_idx").on(table.orgId),
    index("alert_delivery_events_org_incident_idx").on(
      table.orgId,
      table.incidentId,
    ),
    index("alert_delivery_events_due_idx").on(table.status, table.scheduledAt),
    index("alert_delivery_events_claim_idx").on(
      table.status,
      table.claimExpiresAt,
      table.scheduledAt,
    ),
    uniqueIndex("alert_delivery_events_delivery_attempt_idx").on(
      table.deliveryKey,
      table.attemptNumber,
    ),
  ],
)

export type AlertDestinationRow = typeof alertDestinations.$inferSelect
export type AlertRuleRow = typeof alertRules.$inferSelect
export type AlertRuleStateRow = typeof alertRuleStates.$inferSelect
export type AlertIncidentRow = typeof alertIncidents.$inferSelect
export type AlertDeliveryEventRow = typeof alertDeliveryEvents.$inferSelect
