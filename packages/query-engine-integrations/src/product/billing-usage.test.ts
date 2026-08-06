import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	dailySessionCountQuery,
	dailySessionCountRowSchema,
	dailySignalVolumeQuery,
	dailySignalVolumeRowSchema,
} from "./billing-usage"

const params = {
	orgId: "org_123",
	startTime: "2026-07-01 00:00:00",
	endTime: "2026-07-31 23:59:59",
}

const decodeRows = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(compiled.decodeRows(rows))

describe("dailySignalVolumeQuery", () => {
	it("buckets the hourly usage MV into UTC days, scoped to one org", () => {
		const { sql } = compileCH(dailySignalVolumeQuery(), params)

		expect(sql).toContain("FROM service_usage")
		expect(sql).toContain("OrgId = 'org_123'")
		expect(sql).toContain("toStartOfInterval(Hour, INTERVAL 86400 SECOND) AS day")
		expect(sql).toContain("GROUP BY day")
		expect(sql).toContain("ORDER BY day ASC")
	})

	it("snaps both bounds to the hour, because the MV is keyed on top-of-hour", () => {
		const { sql } = compileCH(dailySignalVolumeQuery(), params)

		// Without the snap, an end bound of 23:59:59 excludes the final hour of
		// the cycle and the last day of the chart reads low.
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2026-07-01 00:00:00'))")
		expect(sql).toContain("Hour <= toStartOfHour(toDateTime('2026-07-31 23:59:59'))")
	})

	it("sums all four metric-type columns into the one billed metrics feature", () => {
		const { sql } = compileCH(dailySignalVolumeQuery(), params)

		expect(sql).toContain("sum(LogSizeBytes) AS logBytes")
		expect(sql).toContain("sum(TraceSizeBytes) AS traceBytes")
		expect(sql).toContain("sum(SumMetricSizeBytes)")
		expect(sql).toContain("sum(GaugeMetricSizeBytes)")
		expect(sql).toContain("sum(HistogramMetricSizeBytes)")
		expect(sql).toContain("sum(ExpHistogramMetricSizeBytes)")
	})

	it("decodes UInt64 byte sums that arrive as strings on BYO-ClickHouse", () => {
		const compiled = compileCH(dailySignalVolumeQuery(), params, {
			rowSchema: dailySignalVolumeRowSchema,
		})

		const [row] = decodeRows(compiled, [
			{
				day: "2026-07-01 00:00:00",
				logBytes: "13421772800",
				traceBytes: "4294967296",
				metricBytes: "1073741824",
			},
		])

		expect(row).toEqual({
			day: "2026-07-01 00:00:00",
			logBytes: 13_421_772_800,
			traceBytes: 4_294_967_296,
			metricBytes: 1_073_741_824,
		})
	})
})

describe("dailySessionCountQuery", () => {
	it("counts sessions per UTC day from the replay table, scoped to one org", () => {
		const { sql } = compileCH(dailySessionCountQuery(), params)

		expect(sql).toContain("FROM session_replays")
		expect(sql).toContain("OrgId = 'org_123'")
		expect(sql).toContain("toStartOfInterval(StartTime, INTERVAL 86400 SECOND) AS day")
		expect(sql).toContain("GROUP BY day")
	})

	it("counts distinct session ids, not rows", () => {
		const { sql } = compileCH(dailySessionCountQuery(), params)

		// The SDK posts a row at session start, one per 60s heartbeat, and one at
		// unload. This is a ReplacingMergeTree read without FINAL, so count() bills
		// the chart for every row a merge has not collapsed yet — a 10-minute
		// session rendered as ~12.
		expect(sql).toContain("uniq(SessionId) AS sessions")
		expect(sql).not.toContain("count()")
	})

	it("filters on StartTime so the partition key prunes", () => {
		const { sql } = compileCH(dailySessionCountQuery(), params)

		expect(sql).toContain("StartTime >= toDateTime('2026-07-01 00:00:00')")
		expect(sql).toContain("StartTime <= toDateTime('2026-07-31 23:59:59')")
	})

	it("decodes a string session count", () => {
		const compiled = compileCH(dailySessionCountQuery(), params, {
			rowSchema: dailySessionCountRowSchema,
		})

		const [row] = decodeRows(compiled, [{ day: "2026-07-01 00:00:00", sessions: "1284" }])

		expect(row).toEqual({ day: "2026-07-01 00:00:00", sessions: 1284 })
	})
})
