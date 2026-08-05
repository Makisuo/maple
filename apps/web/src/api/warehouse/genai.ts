import { Clock, Effect, Schema } from "effect"
import {
	JOURNEY_DETAIL_WINDOW_MS,
	JourneyFacetsRequest,
	JourneyPageLimit,
	JourneyPageOffset,
	JourneySortDirection,
	JourneySortKey,
	JourneySummaryRequest,
	JourneyTimelineRequest,
	ListJourneysRequest,
	journeyFilterFields,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"
import { formatWarehouseDateTime } from "@maple/query-engine"

// ---------------------------------------------------------------------------
// Agentic Journeys read path
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
const JourneyFilters = journeyFilterFields

const defaultTimeRange = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - 24 * 60 * 60 * 1000),
	endTime: formatWarehouseDateTime(nowMs),
})

/** Detail reads default wide — a journey id alone doesn't bound the scan, and a
 *  deep link that 404s because it lacks a time param is worse than a wide one.
 *  The window itself comes from the domain package so the summary and the
 *  timeline under it can never read different ranges. */
const detailTimeRange = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - JOURNEY_DETAIL_WINDOW_MS),
	endTime: formatWarehouseDateTime(nowMs),
})

// ---------------------------------------------------------------------------
// List journeys
// ---------------------------------------------------------------------------

const ListJourneysInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	...JourneyFilters,
	sort: Schema.optional(JourneySortKey),
	sortDirection: Schema.optional(JourneySortDirection),
	// Same guards the request schema enforces — decoding here turns a bad page
	// size into a client-side decode error instead of a throw inside the
	// request constructor on the way out.
	limit: Schema.optional(JourneyPageLimit),
	offset: Schema.optional(JourneyPageOffset),
})
export type ListJourneysInput = Schema.Schema.Type<typeof ListJourneysInput>

export const listJourneys = Effect.fn("GenAiJourneys.listJourneys")(function* ({
	data,
}: {
	data: ListJourneysInput
}) {
	const input = yield* decodeInput(ListJourneysInput, data ?? {}, "listJourneys")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listJourneys", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiJourneys.listJourneys({
				payload: new ListJourneysRequest({
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

const JourneyFacetsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	...JourneyFilters,
})
export type JourneyFacetsInput = Schema.Schema.Type<typeof JourneyFacetsInput>

export const getJourneyFacets = Effect.fn("GenAiJourneys.facets")(function* ({
	data,
}: {
	data: JourneyFacetsInput
}) {
	const input = yield* decodeInput(JourneyFacetsInput, data ?? {}, "journeyFacets")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("journeyFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiJourneys.facets({
				payload: new JourneyFacetsRequest({
					...input,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)
})

// ---------------------------------------------------------------------------
// Journey summary (detail header)
// ---------------------------------------------------------------------------

const JourneySummaryInput = Schema.Struct({
	journeyId: Schema.String,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type JourneySummaryInput = (typeof JourneySummaryInput)["Encoded"]

export const getJourneySummary = Effect.fn("GenAiJourneys.summary")(function* ({
	data,
}: {
	data: JourneySummaryInput
}) {
	const input = yield* decodeInput(JourneySummaryInput, data ?? {}, "journeySummary")
	const fallback = detailTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("journeySummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiJourneys.journeySummary({
				payload: new JourneySummaryRequest({
					journeyId: input.journeyId,
					startTime: input.windowStart ?? fallback.startTime,
					endTime: input.windowEnd ?? fallback.endTime,
				}),
			})
		}),
	)
	return { data: result.data }
})

// ---------------------------------------------------------------------------
// Journey timeline (detail body)
//
// The response is already assembled: cumulative `gen_ai.input.messages` are
// deduped server-side and tool calls carry `parentEventId` pointing at the
// assistant message that requested them. Render the list; don't re-derive it.
// ---------------------------------------------------------------------------

const JourneyTimelineInput = Schema.Struct({
	journeyId: Schema.String,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
	// Same guards the request schema enforces — decoding here turns a bad page
	// size into a client-side decode error instead of a throw inside the
	// request constructor on the way out.
	limit: Schema.optional(JourneyPageLimit),
	offset: Schema.optional(JourneyPageOffset),
})
export type JourneyTimelineInput = (typeof JourneyTimelineInput)["Encoded"]

export const getJourneyTimeline = Effect.fn("GenAiJourneys.timeline")(function* ({
	data,
}: {
	data: JourneyTimelineInput
}) {
	const input = yield* decodeInput(JourneyTimelineInput, data ?? {}, "journeyTimeline")
	const fallback = detailTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("journeyTimeline", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.genaiJourneys.journeyTimeline({
				payload: new JourneyTimelineRequest({
					journeyId: input.journeyId,
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
