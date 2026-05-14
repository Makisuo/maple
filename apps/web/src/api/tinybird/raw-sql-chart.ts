import { Effect, Schema } from "effect"
import { RawSqlExecuteRequest, RawSqlDisplayType } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { TinybirdDateTimeString, decodeInput, runTinybirdQuery } from "@/api/tinybird/effect-utils"

// ---------------------------------------------------------------------------
// Raw SQL chart server function (widget data source `raw_sql_chart`).
//
// Widget params shape:
//   { sql, displayType: "line" | "table", granularitySeconds?, startTime, endTime, ... }
//
// Returns rows in a renderer-friendly shape:
//   - displayType: "table"  → returns raw rows as-is
//   - displayType: "line"   → flattens to `{ bucket, [seriesName]: number }`
//     using the first DateTime-like column as `bucket` and the remaining
//     numeric columns as series values. Mirrors the convention used by
//     custom_query_builder_timeseries so existing line/area chart renderers
//     can consume the data without configuration.
// ---------------------------------------------------------------------------

const ISO_OR_TINYBIRD_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})/

export const GetRawSqlChartInputSchema = Schema.Struct({
	sql: Schema.String,
	displayType: RawSqlDisplayType,
	startTime: TinybirdDateTimeString,
	endTime: TinybirdDateTimeString,
	granularitySeconds: Schema.optional(Schema.Number),
})

export type GetRawSqlChartInput = Schema.Schema.Type<typeof GetRawSqlChartInputSchema>

export interface RawSqlChartResponse {
	data: Array<Record<string, unknown>>
	meta: {
		rowCount: number
		columns: ReadonlyArray<string>
		granularitySeconds: number
		displayType: "line" | "table"
	}
}

function looksLikeDateTime(value: unknown): boolean {
	if (value instanceof Date) return true
	if (typeof value !== "string") return false
	return ISO_OR_TINYBIRD_DATETIME_RE.test(value)
}

function pickBucketColumn(columns: ReadonlyArray<string>, firstRow: Record<string, unknown>): string | null {
	// 1. Explicit `bucket` column (matches the rest of the codebase convention).
	if (columns.includes("bucket") && looksLikeDateTime(firstRow.bucket)) {
		return "bucket"
	}
	// 2. First column whose value looks like a datetime.
	for (const col of columns) {
		if (looksLikeDateTime(firstRow[col])) {
			return col
		}
	}
	return null
}

function reshapeForLineChart(
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, string | number>> {
	if (rows.length === 0) return []
	const columns = Object.keys(rows[0])
	const bucketCol = pickBucketColumn(columns, rows[0])
	if (!bucketCol) {
		// Couldn't infer a time axis — return rows untouched so the user can debug
		// in the table view. The chart renderer will simply render an empty plot.
		return rows as Array<Record<string, string | number>>
	}

	const seriesCols = columns.filter((c) => c !== bucketCol)

	return rows.map((row) => {
		const out: Record<string, string | number> = {
			bucket: String(row[bucketCol] instanceof Date ? (row[bucketCol] as Date).toISOString() : row[bucketCol]),
		}
		for (const col of seriesCols) {
			const value = row[col]
			const num = typeof value === "number" ? value : Number(value)
			if (Number.isFinite(num)) {
				out[col] = num
			}
		}
		return out
	})
}

export const getRawSqlChart = Effect.fn("QueryEngine.getRawSqlChart")(function* ({
	data,
}: {
	data: GetRawSqlChartInput
}) {
	const input = yield* decodeInput(GetRawSqlChartInputSchema, data, "getRawSqlChart")

	const result = yield* runTinybirdQuery("rawSqlChart", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.executeRawSql({
				payload: new RawSqlExecuteRequest({
					sql: input.sql,
					displayType: input.displayType,
					startTime: input.startTime,
					endTime: input.endTime,
					granularitySeconds: input.granularitySeconds,
				}),
			})
		}),
	)

	const rows = result.data as ReadonlyArray<Record<string, unknown>>

	const shaped =
		input.displayType === "line" ? reshapeForLineChart(rows) : (rows as Array<Record<string, unknown>>)

	return {
		data: shaped,
		meta: {
			rowCount: result.meta.rowCount,
			columns: result.meta.columns,
			granularitySeconds: result.meta.granularitySeconds,
			displayType: input.displayType,
		},
	} satisfies RawSqlChartResponse
})
