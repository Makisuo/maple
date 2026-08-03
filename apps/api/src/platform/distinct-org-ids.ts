import { sql } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import type { DatabaseClient } from "./DatabaseLive"

/**
 * `SELECT DISTINCT org_id FROM <table>` via a loose index scan.
 *
 * Postgres has no skip scan, so a plain `SELECT DISTINCT` reads every row — or
 * every entry of a covering index — just to return a handful of values. In
 * production that cost 270k rows per call on `error_issues` and 160k on
 * `error_issue_states`, together ~36% of all database CPU and 620M rows read a
 * day, and it grew with table size rather than with workload.
 *
 * The recursive CTE below walks the btree one value at a time: an index descent
 * per distinct org instead of a full scan. It requires an index whose LEADING
 * column is `column` — every table this is used on has one, either the primary
 * key or an `(org_id, …)` composite.
 *
 * Pattern: https://wiki.postgresql.org/wiki/Loose_indexscan
 */
export const selectDistinctOrgIds = async (
	db: DatabaseClient,
	table: PgTable,
	column: PgColumn,
): Promise<ReadonlyArray<string>> => {
	const result = await db.execute(sql`
		with recursive t as (
			(
				select ${column} as org_id
				from ${table}
				where ${column} is not null
				order by ${column}
				limit 1
			)
			union all
			select (
				select ${column}
				from ${table}
				where ${column} > t.org_id
				order by ${column}
				limit 1
			)
			from t
			where t.org_id is not null
		)
		select org_id from t where org_id is not null
	`)
	return toOrgIds(result)
}

/**
 * `db.execute` hands back driver-shaped results: postgres.js yields a row array,
 * PGlite yields `{ rows }`. `MapleDatabaseClient` is typed as the postgres.js
 * client and the PGlite layer casts into it, so the declared array type is a lie
 * under test — normalize both shapes instead of trusting it.
 */
const toOrgIds = (result: unknown): ReadonlyArray<string> => {
	const rows: ReadonlyArray<unknown> = Array.isArray(result) ? result : hasRows(result) ? result.rows : []
	return rows.flatMap((row) =>
		typeof row === "object" && row !== null && "org_id" in row && typeof row.org_id === "string"
			? [row.org_id]
			: [],
	)
}

const hasRows = (value: unknown): value is { readonly rows: ReadonlyArray<unknown> } =>
	typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows)
