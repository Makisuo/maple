import {
	latestSnapshotStatements,
	projectRevision,
} from "../../generated/clickhouse-schema"

/**
 * Migration 0001 — initial schema.
 *
 * Re-exports the generated snapshot of every datasource and materialized view
 * defined in `packages/domain/src/tinybird/{datasources,materializations}.ts`.
 *
 * Future schema changes append `0002_*.ts`, `0003_*.ts`, etc. — each migration
 * lists only the *delta* statements (ALTER TABLE, ADD INDEX, MATERIALIZE COLUMN
 * for `forwardQuery`-style backfills, CREATE MATERIALIZED VIEW for new MVs).
 *
 * The generator script keeps `latestSnapshotStatements` (used here) in sync
 * with the current TS source. CI guards drift via `clickhouse:schema:check`.
 */
export const migration_0001_initial = {
	version: 1,
	description: `Initial schema (revision ${projectRevision})`,
	statements: latestSnapshotStatements,
} as const
