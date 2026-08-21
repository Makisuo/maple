import { Clock, Effect, Schema } from "effect"
import { ServiceName, ServiceUsageRequest } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

import {
	coerceServiceUsageRows,
	formatWarehouseDateTime,
	serviceUsagePreviousTotals,
	type ServiceUsage,
	type ServiceUsageTotals,
} from "@maple/query-engine"
export type { ServiceUsageTotals }

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
			const client = yield* MapleInternalAtomClient
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
	// need a second request. Row shaping is shared with the share API's plan.
	const wantsPrevious = input.previousStartTime != null && input.previousEndTime != null
	return {
		previousTotals: wantsPrevious ? serviceUsagePreviousTotals(result.data) : undefined,
		data: coerceServiceUsageRows(result.data),
	}
})
