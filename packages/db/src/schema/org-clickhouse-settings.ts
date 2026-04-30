import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const orgClickHouseSettings = sqliteTable(
	"org_clickhouse_settings",
	{
		orgId: text("org_id").notNull(),
		chUrl: text("ch_url").notNull(),
		chUser: text("ch_user").notNull(),
		chPasswordCiphertext: text("ch_password_ciphertext"),
		chPasswordIv: text("ch_password_iv"),
		chPasswordTag: text("ch_password_tag"),
		chDatabase: text("ch_database").notNull(),
		// Connection-level health: "connected" once we've successfully talked to
		// the cluster, "error" if the most recent introspection or apply failed.
		// Schema drift is tracked separately by the diff endpoint.
		syncStatus: text("sync_status").notNull(),
		lastSyncAt: integer("last_sync_at", { mode: "number" }),
		lastSyncError: text("last_sync_error"),
		// Hash of the bundled CH snapshot (`clickHouseProjectRevision`) at the
		// time of the last successful schema apply, or null before first apply.
		schemaVersion: text("schema_version"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgClickHouseSettingsRow = typeof orgClickHouseSettings.$inferSelect
export type OrgClickHouseSettingsInsert = typeof orgClickHouseSettings.$inferInsert
