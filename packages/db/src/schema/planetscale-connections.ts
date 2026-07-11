import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * First-class PlanetScale integration state — one row per Maple org, created
 * when the OAuth grant is bound to a PlanetScale organization. The OAuth
 * tokens themselves live in `oauth_connections` (provider "planetscale");
 * this table holds the integration-owned state that table has no home for:
 * the org binding, the managed scrape target it auto-provisioned, the
 * per-connection webhook HMAC secret, and the API permissions detected at
 * binding time. An `oauth_connections` row with no row here means the grant
 * is pending org selection.
 */
export const planetscaleConnections = pgTable(
	"planetscale_connections",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		/** PlanetScale organization slug the connection is bound to. */
		psOrganization: text("ps_organization").notNull(),
		connectedByUserId: text("connected_by_user_id").notNull(),
		/** The managed `scrape_targets` row this connection auto-provisioned. */
		scrapeTargetId: text("scrape_target_id"),
		/** Per-connection HMAC secret for inbound PlanetScale webhooks. */
		webhookSecretCiphertext: text("webhook_secret_ciphertext"),
		webhookSecretIv: text("webhook_secret_iv"),
		webhookSecretTag: text("webhook_secret_tag"),
		/** API permissions probed at org-binding time (e.g. read_databases, read_metrics_endpoints). */
		detectedPermissionsJson: jsonb("detected_permissions_json").$type<Record<string, boolean>>(),
		lastInventoryAt: timestamp("last_inventory_at", { withTimezone: true, mode: "date" }),
		lastInventoryError: text("last_inventory_error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [uniqueIndex("planetscale_connections_org_idx").on(table.orgId)],
)

export type PlanetScaleConnectionRow = typeof planetscaleConnections.$inferSelect
export type PlanetScaleConnectionInsert = typeof planetscaleConnections.$inferInsert
