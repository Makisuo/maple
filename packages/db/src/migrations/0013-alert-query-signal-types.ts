// ---------------------------------------------------------------------------
// Data migration 0013 — replace the constrained `query` alert signal type with
// `builder_query` (full query-builder draft) and `raw_query` (raw SQL).
//
// Recreates `alert_rules`:
//   - drops `query_data_source` / `query_aggregation` / `query_where_clause`
//   - adds `query_builder_draft_json` / `raw_query_sql`
//   - makes `query_spec_json` / `sample_count_strategy` nullable (raw_query
//     rows carry no compiled QuerySpec)
//   - converts existing `signal_type = 'query'` rows to `builder_query`,
//     building a query-builder draft from the old triplet
//
// Idempotent: guarded by the `_maple_data_migrations` bookkeeping table and an
// `alert_rules` shape probe, so it is safe on every libSQL startup / D1 boot
// and a no-op once the table already has the new shape (e.g. after `db:push`).
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm"
import type { MapleLibsqlClient } from "../client"

const MIGRATION_ID = "0013-alert-query-signal-types"

export async function migrateAlertQuerySignalTypes(db: MapleLibsqlClient): Promise<void> {
	await db.run(
		sql`CREATE TABLE IF NOT EXISTS _maple_data_migrations (id text PRIMARY KEY, applied_at integer NOT NULL)`,
	)

	const applied = await db.all<{ id: string }>(
		sql`SELECT id FROM _maple_data_migrations WHERE id = ${MIGRATION_ID}`,
	)
	if (applied.length > 0) return

	const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(alert_rules)`)
	const columnNames = new Set(columns.map((column) => column.name))
	const alreadyNewShape =
		columnNames.has("raw_query_sql") && !columnNames.has("query_data_source")

	if (!alreadyNewShape && columnNames.has("query_data_source")) {
		await db.run(sql`DROP TABLE IF EXISTS alert_rules_old`)
		await db.run(sql`ALTER TABLE alert_rules RENAME TO alert_rules_old`)
		await db.run(sql`
			CREATE TABLE alert_rules (
				id text PRIMARY KEY NOT NULL,
				org_id text NOT NULL,
				name text NOT NULL,
				enabled integer DEFAULT 1 NOT NULL,
				severity text NOT NULL,
				service_names_json text,
				exclude_service_names_json text,
				signal_type text NOT NULL,
				comparator text NOT NULL,
				threshold real NOT NULL,
				threshold_upper real,
				window_minutes integer NOT NULL,
				minimum_sample_count integer DEFAULT 0 NOT NULL,
				consecutive_breaches_required integer DEFAULT 2 NOT NULL,
				consecutive_healthy_required integer DEFAULT 2 NOT NULL,
				renotify_interval_minutes integer DEFAULT 30 NOT NULL,
				metric_name text,
				metric_type text,
				metric_aggregation text,
				apdex_threshold_ms real,
				query_builder_draft_json text,
				raw_query_sql text,
				group_by text,
				destination_ids_json text NOT NULL,
				query_spec_json text,
				reducer text NOT NULL,
				sample_count_strategy text,
				no_data_behavior text NOT NULL,
				last_scheduled_at integer,
				created_at integer NOT NULL,
				updated_at integer NOT NULL,
				created_by text NOT NULL,
				updated_by text NOT NULL
			)
		`)
		await db.run(sql`
			INSERT INTO alert_rules (
				id, org_id, name, enabled, severity, service_names_json, exclude_service_names_json,
				signal_type, comparator, threshold, threshold_upper, window_minutes, minimum_sample_count,
				consecutive_breaches_required, consecutive_healthy_required, renotify_interval_minutes,
				metric_name, metric_type, metric_aggregation, apdex_threshold_ms,
				query_builder_draft_json, raw_query_sql, group_by, destination_ids_json,
				query_spec_json, reducer, sample_count_strategy, no_data_behavior,
				last_scheduled_at, created_at, updated_at, created_by, updated_by
			)
			SELECT
				id, org_id, name, enabled, severity, service_names_json, exclude_service_names_json,
				CASE WHEN signal_type = 'query' THEN 'builder_query' ELSE signal_type END,
				comparator, threshold, threshold_upper, window_minutes, minimum_sample_count,
				consecutive_breaches_required, consecutive_healthy_required, renotify_interval_minutes,
				metric_name, metric_type, metric_aggregation, apdex_threshold_ms,
				CASE
					WHEN signal_type = 'query' AND query_data_source = 'metrics'
						THEN json_object(
							'id', 'q', 'name', 'A', 'dataSource', 'metrics',
							'aggregation', COALESCE(query_aggregation, 'avg'),
							'whereClause', COALESCE(query_where_clause, ''),
							'metricName', COALESCE(metric_name, ''),
							'metricType', COALESCE(metric_type, 'gauge')
						)
					WHEN signal_type = 'query'
						THEN json_object(
							'id', 'q', 'name', 'A',
							'dataSource', COALESCE(query_data_source, 'traces'),
							'aggregation', COALESCE(query_aggregation, 'count'),
							'whereClause', COALESCE(query_where_clause, '')
						)
					ELSE NULL
				END,
				NULL,
				group_by, destination_ids_json,
				query_spec_json, reducer, sample_count_strategy, no_data_behavior,
				last_scheduled_at, created_at, updated_at, created_by, updated_by
			FROM alert_rules_old
		`)
		await db.run(sql`DROP TABLE alert_rules_old`)
		await db.run(sql`CREATE INDEX alert_rules_org_idx ON alert_rules (org_id)`)
		await db.run(
			sql`CREATE INDEX alert_rules_org_enabled_idx ON alert_rules (org_id, enabled)`,
		)
		await db.run(
			sql`CREATE UNIQUE INDEX alert_rules_org_name_idx ON alert_rules (org_id, name)`,
		)
	}

	await db.run(
		sql`INSERT INTO _maple_data_migrations (id, applied_at) VALUES (${MIGRATION_ID}, ${Date.now()})`,
	)
}
