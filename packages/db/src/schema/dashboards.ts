import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { DashboardId, DashboardVersionId, OrgId, UserId } from "@maple/domain/primitives"

export const dashboards = pgTable(
	"dashboards",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		id: text("id").$type<DashboardId>().notNull(),
		name: text("name").notNull(),
		payloadJson: jsonb("payload_json").$type<unknown>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").$type<UserId>().notNull(),
		updatedBy: text("updated_by").$type<UserId>().notNull(),
		// Optimistic-concurrency token. Bumped on every upsert; mutations use a
		// compare-and-swap on (id, version) and retry on conflict so concurrent
		// writers can no longer silently clobber each other.
		version: integer("version").notNull().default(0),
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
export const dashboardVersions = pgTable(
	"dashboard_versions",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		id: text("id").$type<DashboardVersionId>().notNull(),
		dashboardId: text("dashboard_id").$type<DashboardId>().notNull(),
		versionNumber: integer("version_number").notNull(),
		snapshotJson: jsonb("snapshot_json").$type<unknown>().notNull(),
		changeKind: text("change_kind").notNull(),
		changeSummary: text("change_summary"),
		sourceVersionId: text("source_version_id").$type<DashboardVersionId>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").$type<UserId>().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.id] }),
		index("dashboard_versions_org_dashboard_idx").on(table.orgId, table.dashboardId, table.versionNumber),
		// Prevents two concurrent saves from stamping the same version_number for
		// the same dashboard. Insert collisions surface as a unique-constraint
		// error which the persistence layer maps to a concurrency conflict.
		uniqueIndex("dashboard_versions_org_dashboard_version_unq").on(
			table.orgId,
			table.dashboardId,
			table.versionNumber,
		),
	],
)

export type DashboardVersionRow = typeof dashboardVersions.$inferSelect
export type DashboardVersionInsert = typeof dashboardVersions.$inferInsert
