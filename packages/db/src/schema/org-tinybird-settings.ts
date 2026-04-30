import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const orgTinybirdSettings = sqliteTable(
	"org_tinybird_settings",
	{
		orgId: text("org_id").notNull(),
		// Backend selector: "tinybird" (BYO Tinybird workspace) or "clickhouse"
		// (BYO vanilla ClickHouse server). Existing rows default to "tinybird".
		backend: text("backend").notNull().default("tinybird"),
		// Tinybird-specific columns (populated when backend = "tinybird")
		host: text("host"),
		tokenCiphertext: text("token_ciphertext"),
		tokenIv: text("token_iv"),
		tokenTag: text("token_tag"),
		// ClickHouse-specific columns (populated when backend = "clickhouse")
		chUrl: text("ch_url"),
		chUser: text("ch_user"),
		chPasswordCiphertext: text("ch_password_ciphertext"),
		chPasswordIv: text("ch_password_iv"),
		chPasswordTag: text("ch_password_tag"),
		chDatabase: text("ch_database"),
		// Shared bookkeeping
		syncStatus: text("sync_status").notNull(),
		lastSyncAt: integer("last_sync_at", { mode: "number" }),
		lastSyncError: text("last_sync_error"),
		// `projectRevision` only meaningful for Tinybird backend (tracks which
		// version of the maple Tinybird project has been deployed). For
		// ClickHouse backend it's a fixed sentinel string — there's no project
		// to push, just a schema operators apply via `clickhouse:schema:apply`.
		projectRevision: text("project_revision").notNull(),
		lastDeploymentId: text("last_deployment_id"),
		logsRetentionDays: integer("logs_retention_days", { mode: "number" }),
		tracesRetentionDays: integer("traces_retention_days", { mode: "number" }),
		metricsRetentionDays: integer("metrics_retention_days", { mode: "number" }),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgTinybirdSettingsRow = typeof orgTinybirdSettings.$inferSelect
export type OrgTinybirdSettingsInsert = typeof orgTinybirdSettings.$inferInsert
