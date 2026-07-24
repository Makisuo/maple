import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	anomalyErrorSpikeBaselineQuery,
	anomalyErrorSpikeCurrentQuery,
	anomalyErrorSpikeTimeseriesQuery,
	anomalyLogVolumeQuery,
	anomalyLogVolumeTimeseriesQuery,
	anomalyTraceSignalsQuery,
	anomalyTraceSignalTimeseriesQuery,
	matchedHoursOfDay,
} from "./anomaly"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-08 00:00:00",
}

describe("matchedHoursOfDay", () => {
	it("returns hour ±1", () => {
		expect(matchedHoursOfDay(14)).toEqual([13, 14, 15])
	})

	it("wraps at midnight", () => {
		expect(matchedHoursOfDay(0)).toEqual([23, 0, 1])
		expect(matchedHoursOfDay(23)).toEqual([22, 23, 0])
	})
})

describe("anomalyTraceSignalsQuery", () => {
	it("reads the hourly MV with entry-point + matched-hour filters", () => {
		const q = anomalyTraceSignalsQuery({ hoursOfDay: matchedHoursOfDay(14) })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).toContain("toHour(Hour) IN (13, 14, 15)")
		expect(sql).toContain("sum(WeightedCount) AS requestCount")
		expect(sql).toContain("sum(WeightedErrorCount) AS errorCount")
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.95)(DurationQuantiles)")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY serviceName, deploymentEnv, hour")
		expect(sql).toContain("LIMIT 25000")
	})
})

describe("anomalyLogVolumeQuery", () => {
	it("reads logs_aggregates_hourly with severity-class sums", () => {
		const q = anomalyLogVolumeQuery({ hoursOfDay: matchedHoursOfDay(0) })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("toHour(Hour) IN (23, 0, 1)")
		expect(sql).toContain("sumIf(Count, lower(SeverityText) IN ('error', 'fatal', 'critical'))")
		expect(sql).toContain("sumIf(Count, lower(SeverityText) IN ('warn', 'warning'))")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyErrorSpikeCurrentQuery", () => {
	it("reads the time-ordered error events sibling grouped by fingerprint", () => {
		const q = anomalyErrorSpikeCurrentQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("GROUP BY fingerprintHash, deploymentEnv")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 500")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyErrorSpikeBaselineQuery", () => {
	it("compiles a two-level hourly aggregate", () => {
		const q = anomalyErrorSpikeBaselineQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toStartOfHour(Timestamp)")
		expect(sql).toContain("count() AS hourCount")
		expect(sql).toContain("sum(hourCount) AS totalCount")
		expect(sql).toContain("quantile(0.5)(hourCount)")
		expect(sql).toContain("max(hourCount) AS maxHourly")
		expect(sql).toContain("GROUP BY fingerprintHash, deploymentEnv")
		expect(sql).toContain("LIMIT 5000")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

const seriesParams = {
	...baseParams,
	serviceName: "checkout",
	deploymentEnv: "prod",
}

describe("anomalyTraceSignalTimeseriesQuery", () => {
	it("returns a continuous hourly window for one service/env series", () => {
		const q = anomalyTraceSignalTimeseriesQuery()
		const { sql } = compileCH(q, seriesParams)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).toContain("ServiceName = 'checkout'")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("sum(WeightedCount) AS requestCount")
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.95)(DurationQuantiles)")
		expect(sql).toContain("OrgId = 'org_1'")
		// No matched-hours filter — the chart wants every bucket in the window.
		expect(sql).not.toContain("toHour(Hour)")
		expect(sql).toContain("GROUP BY hour")
		expect(sql).toContain("ORDER BY hour ASC")
		expect(sql).toContain("LIMIT 200")
	})
})

describe("anomalyLogVolumeTimeseriesQuery", () => {
	it("returns hourly error-log volume for one service/env series", () => {
		const q = anomalyLogVolumeTimeseriesQuery()
		const { sql } = compileCH(q, seriesParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("sumIf(Count, lower(SeverityText) IN ('error', 'fatal', 'critical'))")
		expect(sql).toContain("ServiceName = 'checkout'")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).not.toContain("toHour(Hour)")
		expect(sql).toContain("ORDER BY hour ASC")
	})
})

describe("anomalyErrorSpikeTimeseriesQuery", () => {
	it("buckets one fingerprint/env series by interval", () => {
		const q = anomalyErrorSpikeTimeseriesQuery()
		const { sql } = compileCH(q, {
			...baseParams,
			fingerprintHash: "12345",
			deploymentEnv: "prod",
			bucketSeconds: 300,
		})
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toStartOfInterval(Timestamp, INTERVAL 300 SECOND)")
		expect(sql).toContain("FingerprintHash = toUInt64('12345')")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("LIMIT 2500")
	})
})
