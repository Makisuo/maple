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
		// HEAD frontier: END of the newest 5-minute bucket ingested. The poll fetches the newest
		// window first (live-first) so a freshly-connected integration shows near-now data within one
		// tick; in steady state this is just the small [watermark, horizon] delta. Null until the
		// first head poll.
		watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: "date" }),
		// BACKFILL frontier: OLDEST bucket boundary the background history fill has reached, walking
		// DOWN toward the 24h floor (further bounded by the plan's `notOlderThan`). Seeded to the first
		// head window's start on the first head poll; backfill is complete once it reaches the floor.
		// Split from watermarkAt so history fills in behind live data instead of delaying it.
		backfillAt: timestamp("backfill_at", { withTimezone: true, mode: "date" }),
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
		// JSON array of live Worker script names (REST listScripts), cached on the workers anchor
		// row alongside discoveredAt. Used to drop invocation groups for deleted scripts; null means
		// enumeration is unavailable (e.g. token lacks workers-scripts.read) → no filtering.
		liveScriptsJson: text("live_scripts_json"),
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
