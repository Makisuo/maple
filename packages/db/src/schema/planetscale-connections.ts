import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * First-class PlanetScale integration connections — one per Maple org. Holds the
 * PlanetScale service token (AES-256-GCM encrypted, same key as scrape-target
 * credentials) plus integration-owned state: the managed scrape target it
 * auto-provisioned, the per-connection webhook HMAC secret, and the token
 * permissions detected at connect time.
 *
 * Deliberately NOT `oauth_connections`: the credential is a static composite
 * (token id + secret + org slug) with no refresh/expiry semantics, and the
 * integration needs columns that table has no home for.
 */
export const planetscaleConnections = pgTable(
	"planetscale_connections",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		/** PlanetScale organization slug the token is scoped to. */
		psOrganization: text("ps_organization").notNull(),
		/** Service token id — not secret; kept plaintext for display ("token abc…"). */
		tokenId: text("token_id").notNull(),
		tokenSecretCiphertext: text("token_secret_ciphertext").notNull(),
		tokenSecretIv: text("token_secret_iv").notNull(),
		tokenSecretTag: text("token_secret_tag").notNull(),
		connectedByUserId: text("connected_by_user_id").notNull(),
		/** The managed `scrape_targets` row this connection auto-provisioned. */
		scrapeTargetId: text("scrape_target_id"),
		/** Per-connection HMAC secret for inbound PlanetScale webhooks. */
		webhookSecretCiphertext: text("webhook_secret_ciphertext"),
		webhookSecretIv: text("webhook_secret_iv"),
		webhookSecretTag: text("webhook_secret_tag"),
		/** Token permissions probed at connect time (e.g. read_databases, read_metrics_endpoints). */
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
