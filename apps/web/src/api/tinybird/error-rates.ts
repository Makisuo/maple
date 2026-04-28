import { Effect, Schema } from "effect"
import { ErrorRateByServiceRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { TinybirdDateTimeString, decodeInput, runTinybirdQuery } from "@/api/tinybird/effect-utils"

export interface ErrorRateByService {
	serviceName: string
	totalLogs: number
	errorLogs: number
	errorRate: number
}

export interface ErrorRateByServiceResponse {
	data: ErrorRateByService[]
}

const GetErrorRateByServiceInput = Schema.Struct({
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetErrorRateByServiceInput = Schema.Schema.Type<typeof GetErrorRateByServiceInput>

const defaultTimeRange = () => {
	const now = new Date()
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

export const getErrorRateByService = Effect.fn("QueryEngine.getErrorRateByService")(function* ({
	data,
}: {
	data: GetErrorRateByServiceInput
}) {
	const input = yield* decodeInput(GetErrorRateByServiceInput, data ?? {}, "getErrorRateByService")

	const fallback = defaultTimeRange()
	const result = yield* runTinybirdQuery("errorRateByService", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
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
