import type { OrgId } from "@maple/domain"
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

export const orgClickHouseSettings = pgTable(
	"org_clickhouse_settings",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
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
		lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
		lastSyncError: text("last_sync_error"),
		// ClickHouse schema identity at the time of the last successful apply (or
		// null before first apply). Holds `clickHouseSchemaVersion` — the bundled
		// migration version, NOT the Tinybird-coupled `clickHouseProjectRevision`
		// hash — so the ingest gateway's readiness gate doesn't trip on unrelated
		// Tinybird schema changes. The ingest gateway compares against it.
		schemaVersion: text("schema_version"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgClickHouseSettingsRow = typeof orgClickHouseSettings.$inferSelect
export type OrgClickHouseSettingsInsert = typeof orgClickHouseSettings.$inferInsert
