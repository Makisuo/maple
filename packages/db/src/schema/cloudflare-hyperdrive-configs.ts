import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * The org's Cloudflare Hyperdrive config inventory, refreshed by the analytics
 * poller's hourly discovery pass. Consumed by the service map to resolve which
 * origin database (e.g. a PlanetScale database) sits behind the collapsed
 * Hyperdrive node. Rows whose config disappeared upstream are soft-deleted
 * (`deletedAt`), mirroring `planetscale_databases`.
 */
export const cloudflareHyperdriveConfigs = pgTable(
	"cloudflare_hyperdrive_configs",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		/** Cloudflare's 32-hex Hyperdrive config id (what `db.namespace` collapses from). */
		configId: text("config_id").notNull(),
		name: text("name").notNull(),
		/** Origin host; null for the VPC-origin variant (no public host). */
		originHost: text("origin_host"),
		/** Origin port; null for the Access-client and VPC variants. */
		originPort: integer("origin_port"),
		/** Origin scheme: "mysql" | "postgres" | "postgresql". */
		originScheme: text("origin_scheme").notNull(),
		originDatabase: text("origin_database").notNull(),
		originUser: text("origin_user"),
		deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("cloudflare_hyperdrive_configs_org_config_idx").on(table.orgId, table.configId),
		index("cloudflare_hyperdrive_configs_org_idx").on(table.orgId),
	],
)

export type CloudflareHyperdriveConfigRow = typeof cloudflareHyperdriveConfigs.$inferSelect
export type CloudflareHyperdriveConfigInsert = typeof cloudflareHyperdriveConfigs.$inferInsert
