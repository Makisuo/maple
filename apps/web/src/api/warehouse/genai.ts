import { Clock, Effect, Schema } from "effect"
import {
	AGENT_TRACE_DETAIL_WINDOW_MS,
	AgentTraceFacetsRequest,
	AgentTracePageLimit,
	AgentTracePageOffset,
	AgentTraceSortDirection,
	AgentTraceSortKey,
	AgentTraceSummaryRequest,
	AgentTraceTimelineRequest,
	ListAgentTracesRequest,
	agentTraceFilterFields,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"
import { formatWarehouseDateTime } from "@maple/query-engine"

// ---------------------------------------------------------------------------
// Agent Traces read path
//
// Mirrors `replays.ts`: one `Effect.fn` per endpoint, inputs decoded through an
// Effect Schema, and a default time window applied here rather than in the
// route so a hand-built URL with no `t` param still resolves.
//
// The list and facets share one filter schema on purpose — the sidebar's counts
// and the list's rows must be describing the same population, and two
// hand-maintained copies of the filter set is exactly how that drifts.
// ---------------------------------------------------------------------------

/**
 * The filter vocabulary, imported rather than re-declared. A second copy here
 * is how the sidebar and the list drift into describing different populations —
 * and the copy always looks right until someone adds a dimension to one of them.
 */
const AgentTraceFilters = agentTraceFilterFields

const defaultTimeRange = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - 24 * 60 * 60 * 1000),
	endTime: formatWarehouseDateTime(nowMs),
})

/** Detail reads default wide — an agent trace id alone doesn't bound the scan, and a
 *  deep link that 404s because it lacks a time param is worse than a wide one.
 *  The window itself comes from the domain package so the summary and the
 *  timeline under it can never read different ranges. */
const detailTimeRange = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - AGENT_TRACE_DETAIL_WINDOW_MS),
	endTime: formatWarehouseDateTime(nowMs),
})

// ---------------------------------------------------------------------------
// List agent traces
// ---------------------------------------------------------------------------

const ListAgentTracesInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	...AgentTraceFilters,
	sort: Schema.optional(AgentTraceSortKey),
	sortDirection: Schema.optional(AgentTraceSortDirection),
	// Same guards the request schema enforces — decoding here turns a bad page
	// size into a client-side decode error instead of a throw inside the
	// request constructor on the way out.
	limit: Schema.optional(AgentTracePageLimit),
	offset: Schema.optional(AgentTracePageOffset),
})
export type ListAgentTracesInput = Schema.Schema.Type<typeof ListAgentTracesInput>

export const listAgentTraces = Effect.fn("GenAiAgentTraces.listAgentTraces")(function* ({
	data,
}: {
	data: ListAgentTracesInput
}) {
	const input = yield* decodeInput(ListAgentTracesInput, data ?? {}, "listAgentTraces")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listAgentTraces", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiAgentTraces.listAgentTraces({
				payload: new ListAgentTracesRequest({
					...input,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				}),
			})
		}),
	)
	return { data: result.data }
})

// ---------------------------------------------------------------------------
// Facets (filter sidebar option counts)
// ---------------------------------------------------------------------------

const AgentTraceFacetsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	...AgentTraceFilters,
})
export type AgentTraceFacetsInput = Schema.Schema.Type<typeof AgentTraceFacetsInput>

export const getAgentTraceFacets = Effect.fn("GenAiAgentTraces.facets")(function* ({
	data,
}: {
	data: AgentTraceFacetsInput
}) {
	const input = yield* decodeInput(AgentTraceFacetsInput, data ?? {}, "agentTraceFacets")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("agentTraceFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiAgentTraces.facets({
				payload: new AgentTraceFacetsRequest({
					...input,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)
})

// ---------------------------------------------------------------------------
// Agent trace summary (detail header)
// ---------------------------------------------------------------------------

const AgentTraceSummaryInput = Schema.Struct({
	agentTraceId: Schema.String,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type AgentTraceSummaryInput = (typeof AgentTraceSummaryInput)["Encoded"]

export const getAgentTraceSummary = Effect.fn("GenAiAgentTraces.summary")(function* ({
	data,
}: {
	data: AgentTraceSummaryInput
}) {
	const input = yield* decodeInput(AgentTraceSummaryInput, data ?? {}, "agentTraceSummary")
	const fallback = detailTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("agentTraceSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiAgentTraces.agentTraceSummary({
				payload: new AgentTraceSummaryRequest({
					agentTraceId: input.agentTraceId,
					startTime: input.windowStart ?? fallback.startTime,
					endTime: input.windowEnd ?? fallback.endTime,
				}),
			})
		}),
	)
	return { data: result.data }
})

// ---------------------------------------------------------------------------
// Agent trace timeline (detail body)
//
// The response is already assembled: cumulative `gen_ai.input.messages` are
// deduped server-side and tool calls carry `parentEventId` pointing at the
// assistant message that requested them. Render the list; don't re-derive it.
// ---------------------------------------------------------------------------

const AgentTraceTimelineInput = Schema.Struct({
	agentTraceId: Schema.String,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
	// Same guards the request schema enforces — decoding here turns a bad page
	// size into a client-side decode error instead of a throw inside the
	// request constructor on the way out.
	limit: Schema.optional(AgentTracePageLimit),
	offset: Schema.optional(AgentTracePageOffset),
})
export type AgentTraceTimelineInput = (typeof AgentTraceTimelineInput)["Encoded"]

export const getAgentTraceTimeline = Effect.fn("GenAiAgentTraces.timeline")(function* ({
	data,
}: {
	data: AgentTraceTimelineInput
}) {
	const input = yield* decodeInput(AgentTraceTimelineInput, data ?? {}, "agentTraceTimeline")
	const fallback = detailTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("agentTraceTimeline", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiAgentTraces.agentTraceTimeline({
				payload: new AgentTraceTimelineRequest({
					agentTraceId: input.agentTraceId,
					startTime: input.windowStart ?? fallback.startTime,
					endTime: input.windowEnd ?? fallback.endTime,
					limit: input.limit,
					offset: input.offset,
				}),
			})
		}),
	)
	return { events: result.events, spanCount: result.spanCount, truncated: result.truncated }
})
