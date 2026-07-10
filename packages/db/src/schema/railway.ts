import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// One Railway API connection per org (v1). The pasted workspace/account token is stored with the
// same AES-256-GCM envelope convention as oauth_connections; it is only ever decrypted for the
// GraphQL discovery calls in the api and for the internal railway-connector work list.
export const railwayConnections = pgTable(
	"railway_connections",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		// "account" | "workspace" ("project" reserved for a later version — project tokens use a
		// different auth header and cannot enumerate projects).
		tokenType: text("token_type").notNull(),
		tokenCiphertext: text("token_ciphertext").notNull(),
		tokenIv: text("token_iv").notNull(),
		tokenTag: text("token_tag").notNull(),
		externalAccountName: text("external_account_name"),
		connectedByUserId: text("connected_by_user_id").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: "date" }),
		// Set when Railway rejects the token (401) — surfaced on the integration card as a
		// "reconnect" prompt since Railway tokens have no refresh flow.
		lastValidationError: text("last_validation_error"),
		lastValidationErrorAt: timestamp("last_validation_error_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [uniqueIndex("railway_connections_org_idx").on(table.orgId)],
)

// One row per (project, environment) the org chose to ingest. Logs use a single environment-wide
// GraphQL subscription; metrics are polled per service from the cached services_json list. The
// watermark columns anchor gap backfill after a subscription reconnect and the next metrics
// window; health columns feed the integration card.
export const railwayTargets = pgTable(
	"railway_targets",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		connectionId: text("connection_id").notNull(),
		projectId: text("project_id").notNull(),
		projectName: text("project_name"),
		environmentId: text("environment_id").notNull(),
		environmentName: text("environment_name"),
		enabled: boolean("enabled").notNull().default(true),
		logsEnabled: boolean("logs_enabled").notNull().default(true),
		metricsEnabled: boolean("metrics_enabled").notNull().default(true),
		metricsIntervalSeconds: integer("metrics_interval_seconds").notNull().default(300),
		// JSON array of { id, name } for the environment's services, discovered by the api and
		// refreshed on a TTL — the connector polls metrics per service from this list.
		servicesJson: text("services_json"),
		servicesDiscoveredAt: timestamp("services_discovered_at", { withTimezone: true, mode: "date" }),
		// Newest log timestamp delivered — reconnect backfill anchor.
		logWatermarkAt: timestamp("log_watermark_at", { withTimezone: true, mode: "date" }),
		// End of the newest metrics window ingested.
		metricsWatermarkAt: timestamp("metrics_watermark_at", { withTimezone: true, mode: "date" }),
		lastLogAt: timestamp("last_log_at", { withTimezone: true, mode: "date" }),
		lastMetricsAt: timestamp("last_metrics_at", { withTimezone: true, mode: "date" }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("railway_targets_org_project_env_idx").on(table.orgId, table.projectId, table.environmentId),
		index("railway_targets_org_idx").on(table.orgId),
		index("railway_targets_connection_idx").on(table.connectionId),
	],
)

export type RailwayConnectionRow = typeof railwayConnections.$inferSelect
export type RailwayConnectionInsert = typeof railwayConnections.$inferInsert
export type RailwayTargetRow = typeof railwayTargets.$inferSelect
export type RailwayTargetInsert = typeof railwayTargets.$inferInsert
