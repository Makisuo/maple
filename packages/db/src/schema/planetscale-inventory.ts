import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * Poll-state for the PlanetScale management-API poller (inventory + insights
 * datasets), mirroring `cloudflare_analytics_state`. One row per
 * `(org, dataset, databaseId)`: the inventory dataset uses `databaseId = ""`
 * (the org-wide anchor row that also carries the tick-overlap lease); the
 * insights dataset (Phase 3) gets one row per database.
 */
export const planetscalePollState = pgTable(
	"planetscale_poll_state",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		dataset: text("dataset").notNull(),
		// "" for the org-wide inventory anchor row — kept NOT NULL so the unique
		// index treats it like any other row.
		databaseId: text("database_id").notNull().default(""),
		enabled: boolean("enabled").notNull().default(true),
		/** Frontier of ingested data (insights dataset); null until the first poll. */
		watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: "date" }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
		// Overlap guard: a tick claims an org by bumping this past now; a competing
		// tick that fails to claim skips the org.
		leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("planetscale_poll_state_org_dataset_db_idx").on(
			table.orgId,
			table.dataset,
			table.databaseId,
		),
		index("planetscale_poll_state_org_idx").on(table.orgId),
	],
)

export type PlanetScalePollStateRow = typeof planetscalePollState.$inferSelect
export type PlanetScalePollStateInsert = typeof planetscalePollState.$inferInsert

/** One branch of a PlanetScale database, stored inline on the database row. */
export interface PlanetScaleBranchInfo {
	readonly id: string
	readonly name: string
	readonly production: boolean
	readonly ready: boolean
}

/**
 * The org's PlanetScale database inventory, refreshed hourly from the
 * management API. Consumed by the service map (branding + metric overlay
 * matching) and the /infra/planetscale page. Rows whose database disappeared
 * upstream are soft-deleted (`deletedAt`) so a re-appearing database keeps its
 * identity instead of re-registering.
 */
export const planetscaleDatabases = pgTable(
	"planetscale_databases",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		/** PlanetScale's database id. */
		databaseId: text("database_id").notNull(),
		name: text("name").notNull(),
		/** Product kind: "mysql" (Vitess) or "postgresql". */
		kind: text("kind").notNull().default("mysql"),
		state: text("state"),
		region: text("region"),
		plan: text("plan"),
		branchesJson: jsonb("branches_json").$type<PlanetScaleBranchInfo[]>(),
		deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("planetscale_databases_org_db_idx").on(table.orgId, table.databaseId),
		index("planetscale_databases_org_idx").on(table.orgId),
	],
)

export type PlanetScaleDatabaseRow = typeof planetscaleDatabases.$inferSelect
export type PlanetScaleDatabaseInsert = typeof planetscaleDatabases.$inferInsert
