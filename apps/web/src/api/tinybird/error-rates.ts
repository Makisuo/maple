import { Effect, Schema } from "effect"
import { getTinybird } from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
  type TinybirdApiError,
} from "@/api/tinybird/effect-utils"

export interface ErrorRateByService {
  serviceName: string
  totalLogs: number
  errorLogs: number
  errorRatePercent: number
}

export interface ErrorRateByServiceResponse {
  data: ErrorRateByService[]
}

const GetErrorRateByServiceInput = Schema.Struct({
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetErrorRateByServiceInput = Schema.Schema.Type<typeof GetErrorRateByServiceInput>

export function getErrorRateByService({
  data,
}: {
  data: GetErrorRateByServiceInput
}): Effect.Effect<ErrorRateByServiceResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(
      GetErrorRateByServiceInput,
      data ?? {},
      "getErrorRateByService",
    )

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("error_rate_by_service", () =>
      tinybird.query.error_rate_by_service({
        start_time: input.startTime,
        end_time: input.endTime,
      }),
    )

    return {
      data: result.data.map((row) => ({
        serviceName: row.serviceName,
        totalLogs: Number(row.totalLogs),
        errorLogs: Number(row.errorLogs),
        errorRatePercent: Number(row.errorRatePercent),
      })),
    }
  })
}
