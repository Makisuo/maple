import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// Poll-state for the Cloudflare GraphQL Analytics collector. One row per (org, dataset, zone):
// zone-scoped datasets (http_requests) get one row per discovered zone; account-scoped datasets
// (workers_invocations) use zoneId = "" . The table doubles as the org's zone cache — zone
// discovery reconciles rows on every poll tick (soft-disabling rows whose zone disappeared so a
// re-appearing zone resumes from its old watermark instead of re-backfilling).
export const cloudflareAnalyticsState = pgTable(
	"cloudflare_analytics_state",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		dataset: text("dataset").notNull(),
		// "" for account-scoped datasets — kept NOT NULL so the (org, dataset, zone) unique index
		// treats the account row like any other.
		zoneId: text("zone_id").notNull().default(""),
		zoneName: text("zone_name"),
		enabled: boolean("enabled").notNull().default(true),
		// END of the last 5-minute bucket fully ingested; next poll resumes here. Null until the
		// first successful poll (which triggers the bounded backfill).
		watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: "date" }),
		// Cached GraphQL dataset `settings` node (notOlderThan/maxDuration/availableFields) — the
		// only authoritative per-plan limits source; refreshed ~daily.
		settingsJson: text("settings_json"),
		settingsFetchedAt: timestamp("settings_fetched_at", { withTimezone: true, mode: "date" }),
		// False when the tenant's plan lacks the timing quantile fields (free plan) — the poller
		// then omits the quantiles selection and only counters are emitted.
		quantilesAvailable: boolean("quantiles_available").notNull().default(true),
		// When zone discovery (REST listZones) last ran — set on the workers anchor row only.
		// Discovery runs on an hourly TTL; poll ticks in between reuse the known zone rows.
		discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "date" }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
		// Overlap guard: a tick claims an org's rows by bumping this past now; a competing tick
		// that fails to claim skips the org.
		leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("cf_analytics_state_org_dataset_zone_idx").on(table.orgId, table.dataset, table.zoneId),
		index("cf_analytics_state_org_idx").on(table.orgId),
	],
)

export type CloudflareAnalyticsStateRow = typeof cloudflareAnalyticsState.$inferSelect
export type CloudflareAnalyticsStateInsert = typeof cloudflareAnalyticsState.$inferInsert
