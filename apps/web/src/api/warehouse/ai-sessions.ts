import { Clock, Effect, Schema } from "effect"
import {
	AI_SESSION_SPANS_MAX_TRACE_IDS,
	AiSessionSortDir,
	AiSessionSortKey,
	AiSessionSpanCursor,
	AiSessionSpanScope,
	GetAiSessionSpansRequest,
	GetAiSessionSummaryRequest,
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
	offset: Schema.optional(Schema.Number),
	vendorIds: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
	deploymentEnvs: Schema.optional(Schema.Array(Schema.String)),
	models: Schema.optional(Schema.Array(Schema.String)),
	agentNames: Schema.optional(Schema.Array(Schema.String)),
	toolNames: Schema.optional(Schema.Array(Schema.String)),
	search: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	excludeTraceSessions: Schema.optional(Schema.Boolean),
	durationMinMs: Schema.optional(Schema.Number),
	durationMaxMs: Schema.optional(Schema.Number),
	costMin: Schema.optional(Schema.Number),
	costMax: Schema.optional(Schema.Number),
	tokensMin: Schema.optional(Schema.Number),
	tokensMax: Schema.optional(Schema.Number),
	llmCallsMin: Schema.optional(Schema.Number),
	llmCallsMax: Schema.optional(Schema.Number),
	toolCallsMin: Schema.optional(Schema.Number),
	toolCallsMax: Schema.optional(Schema.Number),
	sortBy: Schema.optional(AiSessionSortKey),
	sortDir: Schema.optional(AiSessionSortDir),
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
				// Everything but the window passes through by name; the request
				// schema is where each field's bounds live.
				payload: new ListAiSessionsRequest({
					...input,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
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
	return {
		vendors: result.vendors,
		services: result.services,
		environments: result.environments,
		models: result.models,
		agents: result.agents,
		tools: result.tools,
	}
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
	/** `all` when absent — the first page of a session. */
	scope: Schema.optional(AiSessionSpanScope),
	/** The previous page's `nextCursor`. */
	after: Schema.optional(AiSessionSpanCursor),
	/** A turn's traces, for its `app` spans — needs the window. */
	traceIds: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(AI_SESSION_SPANS_MAX_TRACE_IDS))),
	limit: Schema.optional(Schema.Number),
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
					...(input.scope !== undefined && { scope: input.scope }),
					...(input.after !== undefined && { after: input.after }),
					...(input.traceIds !== undefined && { traceIds: input.traceIds }),
					...(input.limit !== undefined && { limit: input.limit }),
				}),
			})
		}),
	)
	return { data: result.data, nextCursor: result.nextCursor }
})
export type AiSessionSpansPage = Effect.Success<ReturnType<typeof getAiSessionSpans>>

const AiSessionSummaryInput = Schema.Struct({
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})
export type AiSessionSummaryInput = Schema.Schema.Type<typeof AiSessionSummaryInput>

/** The whole session's totals, however many spans it has — see `GetAiSessionSummaryResponse`. */
export const getAiSessionSummary = Effect.fn("AiSessions.aiSessionSummary")(function* ({
	data,
}: {
	data: AiSessionSummaryInput
}) {
	const input = yield* decodeInput(AiSessionSummaryInput, data, "aiSessionSummary")
	yield* Effect.annotateCurrentSpan("sessionId", input.sessionId)
	return yield* runWarehouseQuery("aiSessionSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.aiSessionsInternal.summary({
				payload: new GetAiSessionSummaryRequest({
					sessionId: input.sessionId,
					...(input.startTime !== undefined && input.endTime !== undefined
						? { startTime: input.startTime, endTime: input.endTime }
						: undefined),
				}),
			})
		}),
	)
})
