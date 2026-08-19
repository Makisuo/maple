import { Clock, Effect, Schema } from "effect"
import { ListAiSessionsRequest } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"

const ListAiSessionsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	limit: Schema.optional(Schema.Number),
})
export type ListAiSessionsInput = Schema.Schema.Type<typeof ListAiSessionsInput>

const defaultTimeRange = (nowMs: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMs - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMs),
	}
}

export const listAiSessions = Effect.fn("AiSessions.listAiSessions")(function* ({
	data,
}: {
	data: ListAiSessionsInput
}) {
	const input = yield* decodeInput(ListAiSessionsInput, data ?? {}, "listAiSessions")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listAiSessions", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.list({
				payload: new ListAiSessionsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					limit: input.limit ?? 50,
				}),
			})
		}),
	)
	return { data: result.data }
})
