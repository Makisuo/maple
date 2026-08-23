import { Clock, Effect, Schema } from "effect"
import {
	GetAiSessionSpansRequest,
	ListAiSessionsFacetsRequest,
	ListAiSessionsRequest,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"

const ListAiSessionsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	limit: Schema.optional(Schema.Number),
	vendorIds: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
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
	const input = yield* decodeInput(ListAiSessionsInput, data, "listAiSessions")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listAiSessions", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.list({
				payload: new ListAiSessionsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					limit: input.limit,
					vendorIds: input.vendorIds,
					serviceNames: input.serviceNames,
				}),
			})
		}),
	)
	return { data: result.data }
})

// List facets (filter sidebar option counts)

const AiSessionsFacetsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})
export type AiSessionsFacetsInput = Schema.Schema.Type<typeof AiSessionsFacetsInput>

export const getAiSessionsFacets = Effect.fn("AiSessions.aiSessionsFacets")(function* ({
	data,
}: {
	data: AiSessionsFacetsInput
}) {
	const input = yield* decodeInput(AiSessionsFacetsInput, data, "aiSessionsFacets")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("aiSessionsFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.facets({
				payload: new ListAiSessionsFacetsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)
	return { vendors: result.vendors, services: result.services }
})

// Session spans (detail page)

const AiSessionSpansInput = Schema.Struct({
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	// Optional, and sent as a pair. A caller that knows the session's bounds —
	// anything opened from the list, and any link the detail page has already
	// stamped — gets the partition-pruned read; one that does not lets the
	// warehouse find the session by id across retention.
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})
export type AiSessionSpansInput = Schema.Schema.Type<typeof AiSessionSpansInput>

export const getAiSessionSpans = Effect.fn("AiSessions.aiSessionSpans")(function* ({
	data,
}: {
	data: AiSessionSpansInput
}) {
	const input = yield* decodeInput(AiSessionSpansInput, data, "aiSessionSpans")
	yield* Effect.annotateCurrentSpan("sessionId", input.sessionId)
	const result = yield* runWarehouseQuery("aiSessionSpans", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.spans({
				payload: new GetAiSessionSpansRequest({
					sessionId: input.sessionId,
					// Spread rather than assigned: the payload keys are `optionalKey`,
					// so an explicit `undefined` is not the same as an absent key.
					...(input.startTime !== undefined && input.endTime !== undefined
						? { startTime: input.startTime, endTime: input.endTime }
						: undefined),
				}),
			})
		}),
	)
	return { data: result.data, truncated: result.truncated }
})
