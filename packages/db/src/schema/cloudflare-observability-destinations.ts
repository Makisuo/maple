import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * Persisted state for Cloudflare Workers Observability telemetry destinations that Maple
 * auto-provisions per connected account. One row per (org, dataset). Keeps the Cloudflare-
 * assigned slug so status calls can refresh enabled/lastError without recreating the destination.
 */
export const cloudflareObservabilityDestinations = pgTable(
	"cloudflare_observability_destinations",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		accountId: text("account_id").notNull(),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		dataset: text("dataset").notNull(),
		url: text("url").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		scriptsJson: text("scripts_json"),
		lastError: text("last_error"),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		uniqueIndex("cf_observ_dest_org_dataset_idx").on(table.orgId, table.dataset),
		uniqueIndex("cf_observ_dest_account_slug_idx").on(table.accountId, table.slug),
		index("cf_observ_dest_org_idx").on(table.orgId),
		index("cf_observ_dest_account_idx").on(table.accountId),
	],
)

export type CloudflareObservabilityDestinationRow = typeof cloudflareObservabilityDestinations.$inferSelect
export type CloudflareObservabilityDestinationInsert = typeof cloudflareObservabilityDestinations.$inferInsert
