import { Effect, Schema } from "effect"
import { RawSqlExecuteRequest, RawSqlDisplayType } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { TinybirdDateTimeString, decodeInput, runTinybirdQuery } from "@/api/tinybird/effect-utils"

// ---------------------------------------------------------------------------
// Raw SQL chart server function (widget data source `raw_sql_chart`).
//
// Widget params shape:
//   { sql, displayType, granularitySeconds?, startTime, endTime, ... }
//   displayType ∈ "line" | "area" | "bar" | "table" | "stat" | "pie" | "histogram" | "heatmap"
//
// Returns rows in a renderer-friendly shape:
//   - line / area / bar  → flattens to `{ bucket, [series]: number }` using the
//     first DateTime-like column as `bucket` and the remaining numeric columns
//     as series values (matches custom_query_builder_timeseries).
//   - table              → raw rows.
//   - stat               → raw rows; consumers usually pair with
//     `transform.reduceToValue: { field, aggregate }` on the widget data source
//     to extract a scalar value.
//   - pie                → raw rows; chart picks the first numeric column as
//     the value field and uses the `name` column for labels.
//   - histogram          → raw rows; histogram chart accepts a value-per-row
//     shape and buckets client-side.
//   - heatmap            → raw rows; chart accepts `{ x, y, value }` or wide
//     `{ name, …numeric }` formats.
// ---------------------------------------------------------------------------

const TIME_SERIES_DISPLAY_TYPES: ReadonlyArray<"line" | "area" | "bar"> = ["line", "area", "bar"]

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
		displayType: Schema.Schema.Type<typeof RawSqlDisplayType>
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

	const shaped = TIME_SERIES_DISPLAY_TYPES.includes(
		input.displayType as (typeof TIME_SERIES_DISPLAY_TYPES)[number],
	)
		? reshapeForLineChart(rows)
		: (rows as Array<Record<string, unknown>>)

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
