import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const scrapeTargets = pgTable(
	"scrape_targets",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		serviceName: text("service_name"),
		url: text("url").notNull(),
		targetType: text("target_type").notNull().default("prometheus"),
		discoveryConfigJson: jsonb("discovery_config_json").$type<unknown>(),
		scrapeIntervalSeconds: integer("scrape_interval_seconds").notNull().default(15),
		labelsJson: jsonb("labels_json").$type<Record<string, string>>(),
		authType: text("auth_type").notNull().default("none"),
		/**
		 * Integration ownership marker: null for user-created targets;
		 * `"planetscale:{connectionId}"` when auto-provisioned (and torn down) by
		 * the PlanetScale integration. Managed rows are hidden from the generic
		 * scrape-target UI and edited through the integration card instead.
		 */
		managedBy: text("managed_by"),
		authCredentialsCiphertext: text("auth_credentials_ciphertext"),
		authCredentialsIv: text("auth_credentials_iv"),
		authCredentialsTag: text("auth_credentials_tag"),
		enabled: boolean("enabled").notNull().default(true),
		lastScrapeAt: timestamp("last_scrape_at", { withTimezone: true, mode: "date" }),
		lastScrapeError: text("last_scrape_error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("scrape_targets_org_idx").on(table.orgId),
		index("scrape_targets_org_enabled_idx").on(table.orgId, table.enabled),
	],
)

export type ScrapeTargetRow = typeof scrapeTargets.$inferSelect
export type ScrapeTargetInsert = typeof scrapeTargets.$inferInsert

/**
 * One row per scheduled scrape attempt, reported by the scraper via
 * `POST /api/internal/scrape-results`. Durable check history for the
 * connectors UI — pruned to 24h with a per-target row cap.
 */
export const scrapeTargetChecks = pgTable(
	"scrape_target_checks",
	{
		// generatedByDefault (not generatedAlways) so the D1→Postgres import can
		// carry over existing ids; setval() realigns the sequence afterwards.
		id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
		targetId: text("target_id")
			.notNull()
			.references(() => scrapeTargets.id, { onDelete: "cascade" }),
		orgId: text("org_id").notNull(),
		/** Sub-target discriminator (e.g. PlanetScale branch); empty string for plain targets. */
		subTargetKey: text("sub_target_key").notNull().default(""),
		checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }).notNull(),
		/** Null on success; pretty-printed failure otherwise. */
		error: text("error"),
		durationMs: integer("duration_ms"),
		samplesScraped: integer("samples_scraped"),
		samplesPostRelabel: integer("samples_post_relabel"),
	},
	(table) => [index("scrape_target_checks_target_checked_idx").on(table.targetId, table.checkedAt)],
)

export type ScrapeTargetCheckRow = typeof scrapeTargetChecks.$inferSelect
export type ScrapeTargetCheckInsert = typeof scrapeTargetChecks.$inferInsert
