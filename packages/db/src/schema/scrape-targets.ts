import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const scrapeTargets = sqliteTable(
	"scrape_targets",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		serviceName: text("service_name"),
		url: text("url").notNull(),
		scrapeIntervalSeconds: integer("scrape_interval_seconds", { mode: "number" }).notNull().default(15),
		labelsJson: text("labels_json"),
		authType: text("auth_type").notNull().default("none"),
		authCredentialsCiphertext: text("auth_credentials_ciphertext"),
		authCredentialsIv: text("auth_credentials_iv"),
		authCredentialsTag: text("auth_credentials_tag"),
		enabled: integer("enabled", { mode: "number" }).notNull().default(1),
		lastScrapeAt: integer("last_scrape_at", { mode: "number" }),
		lastScrapeError: text("last_scrape_error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("scrape_targets_org_idx").on(table.orgId),
		index("scrape_targets_org_enabled_idx").on(table.orgId, table.enabled),
	],
)

export type ScrapeTargetRow = typeof scrapeTargets.$inferSelect
export type ScrapeTargetInsert = typeof scrapeTargets.$inferInsert
