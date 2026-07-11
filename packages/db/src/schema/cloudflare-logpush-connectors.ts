import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// NOTE: the manual connector CRUD (CloudflareLogpushService + UI) was removed in favor of the
// account OAuth integration, but this table intentionally stays: the Rust ingest gateway's
// `/v1/logpush/cloudflare/...` receiver resolves connector secrets from it (existing jobs keep
// flowing), OrganizationService purges it on org deletion, and the upcoming OAuth-driven Logpush
// auto-provisioning will create rows here programmatically instead of via manual setup.
export const cloudflareLogpushConnectors = pgTable(
	"cloudflare_logpush_connectors",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		zoneName: text("zone_name").notNull(),
		serviceName: text("service_name").notNull(),
		dataset: text("dataset").notNull().default("http_requests"),
		secretCiphertext: text("secret_ciphertext").notNull(),
		secretIv: text("secret_iv").notNull(),
		secretTag: text("secret_tag").notNull(),
		secretHash: text("secret_hash").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		lastReceivedAt: timestamp("last_received_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		index("cloudflare_logpush_connectors_org_idx").on(table.orgId),
		index("cloudflare_logpush_connectors_org_enabled_idx").on(table.orgId, table.enabled),
		uniqueIndex("cloudflare_logpush_connectors_secret_hash_unique").on(table.secretHash),
	],
)

export type CloudflareLogpushConnectorRow = typeof cloudflareLogpushConnectors.$inferSelect
export type CloudflareLogpushConnectorInsert = typeof cloudflareLogpushConnectors.$inferInsert
