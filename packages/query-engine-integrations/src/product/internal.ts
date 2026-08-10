// Internal observability queries
//
// Queries that read Maple's own self-instrumentation. These run against the
// `internal` org's Traces stream and are used by developer tooling — not
// product code. Keeping them out of the user-facing query modules makes
// their scope explicit.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from } from "@maple-dev/clickhouse-builder"
import { Traces } from "@maple/query-engine/ch/tables"

// db.statement samples

/**
 * Pull the recent SQL we ran in production, grouped by fingerprint and ranked
 * by p95 duration. Drives the `bench fetch` step of the query benchmarking
 * CLI: each row carries one representative `sampleSql` that the replay step
 * can re-run verbatim, plus the perf shape (count, p50/p95/p99) we observed
 * in production for that fingerprint.
 *
 * Reads the attributes that `WarehouseQueryService.executeSql` emits
 * (canonical `db.query.*` keys, with the legacy `db.statement*` spellings
 * coalesced in for spans recorded before the rename):
 *   db.query.text             — full SQL (truncated to 16KB upstream)
 *   db.query.fingerprint      — FNV-1a hash with literals/numbers normalized
 *   query.context             — semantic label (`errorsByType`, etc.)
 *   query.profile             — `discovery` | `list` | `aggregation` | …
 *
 * Required params: `orgId`, `startTime`, `endTime`. Optional `topN` defaults
 * to 20.
 */
export interface DbStatementSamplesOpts {
	contextFilter?: string
	profileFilter?: string
	limit?: number
}

export interface DbStatementSamplesOutput {
	readonly fingerprint: string
	readonly context: string
	readonly profile: string
	readonly sampleSql: string
	readonly sampleCount: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
	readonly maxDurationMs: number
}

export function dbStatementSamplesQuery(opts: DbStatementSamplesOpts) {
	return from(Traces)
		.select(($) => ({
			fingerprint: CH.coalesce(
				CH.nullIf($.SpanAttributes.get("db.query.fingerprint"), ""),
				$.SpanAttributes.get("db.statement.fingerprint"),
			),
			context: CH.any_($.SpanAttributes.get("query.context")),
			profile: CH.any_($.SpanAttributes.get("query.profile")),
			// Pick any representative SQL for this fingerprint — they're
			// equivalent modulo literals by construction.
			sampleSql: CH.any_(
				CH.coalesce(
					CH.nullIf($.SpanAttributes.get("db.query.text"), ""),
					$.SpanAttributes.get("db.statement"),
				),
			),
			sampleCount: CH.count(),
			// Duration is microseconds (uint64) — convert to ms for display.
			p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
			p99DurationMs: CH.quantile(0.99)($.Duration).div(1000000),
			maxDurationMs: CH.max_($.Duration).div(1000000),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SpanName.eq("WarehouseQueryService.executeSql"),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			// Spans without a fingerprint pre-date this attribute or come from
			// the in-process `EXPLAIN` calls the bench itself makes — neither
			// is interesting for ranking.
			CH.coalesce(
				CH.nullIf($.SpanAttributes.get("db.query.fingerprint"), ""),
				$.SpanAttributes.get("db.statement.fingerprint"),
			).neq(""),
			opts.contextFilter ? $.SpanAttributes.get("query.context").eq(opts.contextFilter) : undefined,
			opts.profileFilter ? $.SpanAttributes.get("query.profile").eq(opts.profileFilter) : undefined,
		])
		.groupBy("fingerprint")
		.orderBy(["p95DurationMs", "desc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}
