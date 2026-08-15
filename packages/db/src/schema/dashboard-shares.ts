import { sql } from "drizzle-orm"
import { foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { DashboardId, DashboardShareId, OrgId, UserId } from "@maple/domain/primitives"
import { dashboards } from "./dashboards"

/**
 * Share links for a dashboard, or for a single widget on one.
 *
 * `widget_id` is the scope: null means the whole board, set means exactly that
 * one chart. A widget share is a first-class link with its own token, mode and
 * revocation — not a view of the dashboard's share — so a public embed of one
 * chart survives its dashboard being flipped to org-only or unshared entirely.
 *
 * At most one live row per (dashboard, widget) scope, enforced by the partial
 * unique index below. A dashboard may therefore have its own link plus one per
 * widget, all live at once, which is the point.
 *
 * `mode` rather than one row per mode: toggling public <-> org-only has to keep
 * the same URL working, or a link already pasted into a chat silently changes
 * meaning. Two rows would also mean two live URLs for one scope and no answer
 * to "which one did I share".
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
		// Null = the whole dashboard. Set = this one widget, and only this one:
		// the resolver refuses any other widget id presented against the token.
		widgetId: text("widget_id"),
		// "public" = anyone with the link. "org" = any signed-in member of orgId.
		mode: text("mode", { enum: ["public", "org"] }).notNull(),
		// HMAC-SHA256 of the raw token (see share-token-hash.ts). This is what
		// resolution looks up — deterministic, so it stays one indexed equality.
		tokenHash: text("token_hash").notNull(),
		// The raw token, AES-256-GCM encrypted under MAPLE_INGEST_KEY_ENCRYPTION_KEY
		// with an AAD binding it to this row (see SharedDashboardService).
		//
		// Stored recoverably on purpose: a share link nobody can read back is a
		// link you have to destroy in order to see, and rotating just to re-copy
		// breaks every URL already pasted somewhere. The key lives in the Worker's
		// secrets and never in Postgres, so the original property holds — a
		// database dump on its own is still not a set of working links.
		tokenCiphertext: text("token_ciphertext").notNull(),
		tokenIv: text("token_iv").notNull(),
		tokenTag: text("token_tag").notNull(),
		// Last few characters in plaintext, so a link can be named in a list or an
		// audit trail without decrypting anything.
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
		// At most one live share per (dashboard, widget) scope. Two concurrent
		// rotates collide here rather than leaving two working links behind.
		//
		// `coalesce` rather than indexing `widget_id` directly: in Postgres NULLs
		// are distinct in a unique index, so a bare three-column index would let a
		// dashboard accumulate unlimited whole-board shares while still constraining
		// the per-widget ones. Folding null to '' makes "the whole board" a single
		// value that collides with itself.
		uniqueIndex("dashboard_shares_live_unq")
			.on(table.orgId, table.dashboardId, sql`coalesce(widget_id, '')`)
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
