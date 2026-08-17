import { Clock, Effect, Schema } from "effect"
import { ErrorRateByServiceRequest } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"
const GetErrorRateByServiceInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetErrorRateByServiceInput = Schema.Schema.Type<typeof GetErrorRateByServiceInput>

const defaultTimeRange = (nowMillis: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
}

export const getErrorRateByService = Effect.fn("QueryEngine.getErrorRateByService")(function* ({
	data,
}: {
	data: GetErrorRateByServiceInput
}) {
	const input = yield* decodeInput(GetErrorRateByServiceInput, data ?? {}, "getErrorRateByService")

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("errorRateByService", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.errorRateByService({
				payload: new ErrorRateByServiceRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)

	return {
		data: result.data.map((row) => ({
			serviceName: row.serviceName,
			totalLogs: Number(row.totalLogs),
			errorLogs: Number(row.errorLogs),
			errorRate: Number(row.errorRate),
		})),
	}
})
