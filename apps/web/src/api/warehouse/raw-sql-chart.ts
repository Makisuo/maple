import { Effect, Schema } from "effect"
import { RawSqlExecuteRequest, RawSqlDisplayType } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"
import { rawSqlRowsForDisplay } from "@maple/query-engine"

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

const GetRawSqlChartInputSchema = Schema.Struct({
	sql: Schema.String,
	displayType: RawSqlDisplayType,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	granularitySeconds: Schema.optional(Schema.Number),
})

export type GetRawSqlChartInput = Schema.Schema.Type<typeof GetRawSqlChartInputSchema>

interface RawSqlChartResponse {
	data: Array<Record<string, unknown>>
	meta: {
		rowCount: number
		columns: ReadonlyArray<string>
		granularitySeconds: number
		displayType: Schema.Schema.Type<typeof RawSqlDisplayType>
	}
}

export const getRawSqlChart = Effect.fn("QueryEngine.getRawSqlChart")(function* ({
	data,
}: {
	data: GetRawSqlChartInput
}) {
	const input = yield* decodeInput(GetRawSqlChartInputSchema, data, "getRawSqlChart")

	const result = yield* runWarehouseQuery("rawSqlChart", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
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

	// The same reshaping the share API applies server-side, so a raw-SQL line
	// chart draws identically on a board and on its share link.
	const chartRows = rawSqlRowsForDisplay(rows, input.displayType)

	return {
		data: chartRows,
		meta: {
			rowCount: result.meta.rowCount,
			columns: result.meta.columns,
			granularitySeconds: result.meta.granularitySeconds,
			displayType: input.displayType,
		},
	} satisfies RawSqlChartResponse
})
