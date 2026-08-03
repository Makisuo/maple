import { Clock, Effect, Schema } from "effect"
import { ServiceName, ServiceUsageRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"
interface ServiceUsage {
	serviceName: string
	totalLogs: number
	totalTraces: number
	totalMetrics: number
	dataSizeBytes: number
	logSizeBytes: number
	traceSizeBytes: number
	metricSizeBytes: number
}

export interface ServiceUsageTotals {
	logs: number
	traces: number
	metrics: number
	dataSize: number
}

export interface ServiceUsageResponse {
	data: ServiceUsage[]
	/** Aggregate totals for the previous comparison window, present only when the
	 *  caller passed `previousStartTime`/`previousEndTime` (delta chips). */
	previousTotals?: ServiceUsageTotals
}

const GetServiceUsageInput = Schema.Struct({
	service: Schema.optional(ServiceName),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	previousStartTime: Schema.optional(WarehouseDateTimeString),
	previousEndTime: Schema.optional(WarehouseDateTimeString),
})

export type GetServiceUsageInput = (typeof GetServiceUsageInput)["Encoded"]

const defaultTimeRange = (nowMillis: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
}

export const getServiceUsage = Effect.fn("QueryEngine.getServiceUsage")(function* ({
	data,
}: {
	data: GetServiceUsageInput
}) {
	const input = yield* decodeInput(GetServiceUsageInput, data ?? {}, "getServiceUsage")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceUsage", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceUsage({
				payload: new ServiceUsageRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					service: input.service,
					previousStartTime: input.previousStartTime,
					previousEndTime: input.previousEndTime,
				}),
			})
		}),
	)

	if (!result.data || result.data.length === 0) {
		return { data: [] }
	}

	// When a previous window was requested, the rows carry `previous*` columns;
	// fold them into a single aggregate for the delta chips so the caller doesn't
	// need a second request.
	const wantsPrevious = input.previousStartTime != null && input.previousEndTime != null
	const previousTotals: ServiceUsageTotals | undefined = wantsPrevious
		? result.data.reduce<ServiceUsageTotals>(
				(acc, row: Record<string, unknown>) => ({
					logs: acc.logs + Number(row.previousLogCount ?? 0),
					traces: acc.traces + Number(row.previousTraceCount ?? 0),
					metrics:
						acc.metrics +
						Number(row.previousSumMetricCount ?? 0) +
						Number(row.previousGaugeMetricCount ?? 0) +
						Number(row.previousHistogramMetricCount ?? 0) +
						Number(row.previousExpHistogramMetricCount ?? 0),
					dataSize: acc.dataSize + Number(row.previousSizeBytes ?? 0),
				}),
				{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
			)
		: undefined

	return {
		previousTotals,
		data: result.data.map((row: Record<string, unknown>) => ({
			serviceName: String(row.serviceName ?? ""),
			totalLogs: Number(row.totalLogCount ?? 0),
			totalTraces: Number(row.totalTraceCount ?? 0),
			totalMetrics:
				Number(row.totalSumMetricCount ?? 0) +
				Number(row.totalGaugeMetricCount ?? 0) +
				Number(row.totalHistogramMetricCount ?? 0) +
				Number(row.totalExpHistogramMetricCount ?? 0),
			dataSizeBytes: Number(row.totalSizeBytes ?? 0),
			logSizeBytes: Number(row.totalLogSizeBytes ?? 0),
			traceSizeBytes: Number(row.totalTraceSizeBytes ?? 0),
			metricSizeBytes:
				Number(row.totalSumMetricSizeBytes ?? 0) +
				Number(row.totalGaugeMetricSizeBytes ?? 0) +
				Number(row.totalHistogramMetricSizeBytes ?? 0) +
				Number(row.totalExpHistogramMetricSizeBytes ?? 0),
		})),
	}
})
