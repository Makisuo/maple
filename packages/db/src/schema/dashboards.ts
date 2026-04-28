import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const dashboards = sqliteTable(
	"dashboards",
	{
		orgId: text("org_id").notNull(),
		id: text("id").notNull(),
		name: text("name").notNull(),
		payloadJson: text("payload_json").notNull(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.id] }),
		index("dashboards_org_updated_idx").on(table.orgId, table.updatedAt),
		index("dashboards_org_name_idx").on(table.orgId, table.name),
	],
)

export type DashboardRow = typeof dashboards.$inferSelect
export type DashboardInsert = typeof dashboards.$inferInsert

/**
 * Append-only history of dashboard snapshots. One row per save, with
 * coalescing — back-to-back edits by the same actor of the same kind within
 * a short window update the latest row in place rather than appending.
 */
export const dashboardVersions = sqliteTable(
	"dashboard_versions",
	{
		orgId: text("org_id").notNull(),
		id: text("id").notNull(),
		dashboardId: text("dashboard_id").notNull(),
		versionNumber: integer("version_number", { mode: "number" }).notNull(),
		snapshotJson: text("snapshot_json").notNull(),
		changeKind: text("change_kind").notNull(),
		changeSummary: text("change_summary"),
		sourceVersionId: text("source_version_id"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		createdBy: text("created_by").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.id] }),
		index("dashboard_versions_org_dashboard_idx").on(table.orgId, table.dashboardId, table.versionNumber),
	],
)

export type DashboardVersionRow = typeof dashboardVersions.$inferSelect
export type DashboardVersionInsert = typeof dashboardVersions.$inferInsert
