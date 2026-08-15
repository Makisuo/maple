import { sql } from "drizzle-orm"
import { foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { DashboardId, DashboardShareId, OrgId, UserId } from "@maple/domain/primitives"
import { dashboards } from "./dashboards"

/**
 * Share links for a dashboard. At most one live row per dashboard, enforced by
 * the partial unique index below.
 *
 * `mode` rather than one row per mode: toggling public <-> org-only has to keep
 * the same URL working, or a link already pasted into a chat silently changes
 * meaning. Two rows would also mean two live URLs for one dashboard and no
 * answer to "which one did I share".
 *
 * Revoke and rotate are the same operation — stamp `revoked_at` on the current
 * row, and (for rotate) insert a fresh one in the same transaction. Revoked
 * rows are kept for audit and can never resurrect, because every resolution
 * filters `revoked_at is null`.
 */
export const dashboardShares = pgTable(
	"dashboard_shares",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		id: text("id").$type<DashboardShareId>().notNull(),
		dashboardId: text("dashboard_id").$type<DashboardId>().notNull(),
		// "public" = anyone with the link. "org" = any signed-in member of orgId.
		mode: text("mode", { enum: ["public", "org"] }).notNull(),
		// HMAC-SHA256 of the raw token (see share-token-hash.ts). The raw token is
		// shown once at create/rotate and is not recoverable from this row.
		tokenHash: text("token_hash").notNull(),
		// Last few characters of the raw token, so the dialog can identify a link
		// it can no longer read back in full.
		tokenSuffix: text("token_suffix").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").$type<UserId>().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedBy: text("updated_by").$type<UserId>().notNull(),
		// Null = live. Set = this token no longer resolves, for any reason.
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.id] }),
		// The resolution path: one indexed equality, no scan.
		uniqueIndex("dashboard_shares_token_hash_unq").on(table.tokenHash),
		// At most one live share per dashboard. Two concurrent rotates collide here
		// rather than leaving two working links behind.
		uniqueIndex("dashboard_shares_live_unq")
			.on(table.orgId, table.dashboardId)
			.where(sql`revoked_at is null`),
		index("dashboard_shares_org_dashboard_idx").on(table.orgId, table.dashboardId),
		// Deliberate exception to this repo's no-foreign-key convention (see
		// dashboard_versions, which has none). Everywhere else a dangling row is a
		// cosmetic problem; here it is a security one — a deleted dashboard whose
		// share row survives is a link that still resolves. The resolver also loads
		// the dashboard through DashboardPersistenceService and 404s when it is
		// gone, so this is the second of two locks, not the only one.
		foreignKey({
			columns: [table.orgId, table.dashboardId],
			foreignColumns: [dashboards.orgId, dashboards.id],
			name: "dashboard_shares_dashboard_fk",
		}).onDelete("cascade"),
	],
)

export type DashboardShareRow = typeof dashboardShares.$inferSelect
export type DashboardShareInsert = typeof dashboardShares.$inferInsert
export type DashboardShareMode = DashboardShareRow["mode"]
