import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * Poll-state for the PlanetScale management-API poller, mirroring
 * `cloudflare_analytics_state`. One row per `(org, dataset, databaseId)`:
 *
 *  - `inventory` uses `databaseId = ""` — the org-wide anchor row that also
 *    carries the tick-overlap lease.
 *  - `deploy_requests` uses the PlanetScale database id; `watermarkAt` tracks
 *    the newest `updated_at` already fanned into `planetscale_events`.
 *  - `insights` is branch-scoped, so its key is `"{databaseId}:{branchName}"` —
 *    query insights are reported per branch and one row per database would
 *    collapse them.
 *
 * There is deliberately no `backfillAt`: unlike Cloudflare analytics, none of
 * these datasets walks history downward.
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

/**
 * The PlanetScale lifecycle timeline: deploy-request state transitions and
 * branch lifecycle events, which the charts render as markers and the drill-in
 * renders as an activity feed.
 *
 * Two convergent sources write here — the webhook queue (live) and the
 * deploy-request REST backfill (history, and orgs that connected after the
 * fact) — so idempotency is the load-bearing requirement, not volume. The
 * dedupe index plus `onConflictDoNothing` makes queue redelivery and repeated
 * backfills no-ops. That is also why this is Postgres and not the warehouse:
 * ClickHouse would need ReplacingMergeTree + FINAL to say the same thing, for a
 * dataset of tens of rows per org per day whose only read is "the last N for
 * database X in [start, end]".
 *
 * Health events (OOM, storage, anomaly) land here *as well as* creating their
 * `kind="integration"` issue, so the timeline is the whole story.
 *
 * Not a generic annotation store: that needs a source registry, cross-source
 * ordering and per-source ACLs, and has no second consumer yet. Extract one
 * when a second provider (Cloudflare deploys, GitHub releases) arrives.
 * `service_releases_timeline` is the other marker source and stays separate
 * because it is trace-derived rather than delivered.
 */
export const planetscaleEvents = pgTable(
	"planetscale_events",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		/** PlanetScale's database id when resolvable; "" for webhooks that carry only the name. */
		databaseId: text("database_id").notNull().default(""),
		databaseName: text("database_name").notNull(),
		branchName: text("branch_name").notNull().default(""),
		/** "deploy_request" | "branch" | "database" | "cluster" | "keyspace" */
		category: text("category").notNull(),
		/** Raw PlanetScale event string, e.g. "deploy_request.schema_applied". */
		eventType: text("event_type").notNull(),
		/** Normalized lifecycle state; null for events that aren't state transitions. */
		state: text("state"),
		/** Upstream identity — deploy-request number, branch id. "" when the event has none. */
		externalId: text("external_id").notNull().default(""),
		title: text("title").notNull(),
		/** "webhook" | "backfill" */
		source: text("source").notNull(),
		actorLogin: text("actor_login"),
		url: text("url"),
		payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
		/**
		 * Truncated to whole seconds. PlanetScale's webhook `timestamp` is epoch
		 * SECONDS while the REST backfill carries millisecond precision; without
		 * truncation the same transition inserts twice under the dedupe index.
		 */
		occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("planetscale_events_dedupe_idx").on(
			table.orgId,
			table.databaseName,
			table.eventType,
			table.externalId,
			table.occurredAt,
		),
		index("planetscale_events_org_db_time_idx").on(table.orgId, table.databaseName, table.occurredAt),
		index("planetscale_events_org_time_idx").on(table.orgId, table.occurredAt),
	],
)

export type PlanetScaleEventRow = typeof planetscaleEvents.$inferSelect
export type PlanetScaleEventInsert = typeof planetscaleEvents.$inferInsert
