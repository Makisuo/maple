import { Clock, Effect, Schema } from "effect"
import {
	GetReplayRequest,
	ListReplaysRequest,
	ReplaysFacetsRequest,
	ReplaysForTraceRequest,
	SessionId,
	SessionTranscriptRequest,
	SessionTraceSummariesRequest,
	TraceId,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	runWarehouseQuery,
	runWarehouseQueryV2,
} from "@/api/warehouse/effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"

const ListReplaysInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	/** Substring match on the identified user's name or email. */
	userSearch: Schema.optional(Schema.String),
	/** Identified group (company / team) name. */
	groupName: Schema.optional(Schema.String),
	/** Every session from one browser — the marketing-visit → signup join. */
	visitorId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	// Session-time range filters (ms) — duration is the stored wall-clock time,
	// activeTime is computed server-side from session_events gaps.
	durationMinMs: Schema.optional(Schema.Number),
	durationMaxMs: Schema.optional(Schema.Number),
	activeTimeMinMs: Schema.optional(Schema.Number),
	activeTimeMaxMs: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
})
export type ListReplaysInput = Schema.Schema.Type<typeof ListReplaysInput>

const defaultTimeRange = (nowMs: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMs - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMs),
	}
}

export const listReplays = Effect.fn("SessionReplays.listReplays")(function* ({
	data,
}: {
	data: ListReplaysInput
}) {
	const input = yield* decodeInput(ListReplaysInput, data ?? {}, "listReplays")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listReplays", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.listReplays({
				payload: new ListReplaysRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					serviceName: input.serviceName,
					browser: input.browser,
					country: input.country,
					deviceType: input.deviceType,
					userId: input.userId,
					userSearch: input.userSearch,
					groupName: input.groupName,
					visitorId: input.visitorId,
					hasErrors: input.hasErrors,
					search: input.search,
					cursor: input.cursor,
					durationMinMs: input.durationMinMs,
					durationMaxMs: input.durationMaxMs,
					activeTimeMinMs: input.activeTimeMinMs,
					activeTimeMaxMs: input.activeTimeMaxMs,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				}),
			})
		}),
	)
	return { data: result.data }
})

// List facets (filter sidebar option counts)

const ReplaysFacetsInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	userSearch: Schema.optional(Schema.String),
	groupName: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
})
export type ReplaysFacetsInput = Schema.Schema.Type<typeof ReplaysFacetsInput>

export const getReplaysFacets = Effect.fn("SessionReplays.facets")(function* ({
	data,
}: {
	data: ReplaysFacetsInput
}) {
	const input = yield* decodeInput(ReplaysFacetsInput, data ?? {}, "replaysFacets")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("replaysFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.facets({
				payload: new ReplaysFacetsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					serviceName: input.serviceName,
					browser: input.browser,
					country: input.country,
					deviceType: input.deviceType,
					userId: input.userId,
					userSearch: input.userSearch,
					groupName: input.groupName,
					hasErrors: input.hasErrors,
					search: input.search,
				}),
			})
		}),
	)
	return {
		services: result.services,
		browsers: result.browsers,
		countries: result.countries,
		devices: result.devices,
		groups: result.groups,
		errorCount: result.errorCount,
		durationBuckets: result.durationBuckets,
		durationP50: result.durationP50,
		durationP95: result.durationP95,
	}
})

const GetReplayInput = Schema.Struct({
	sessionId: SessionId,
	// Optional session time window (derived from the `t` navigation hint) so the
	// warehouse prunes daily partitions instead of scanning the 30-day retention.
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
// Encoded shape (plain strings) — callers pass raw route params; decodeInput brands them.
export type GetReplayInput = (typeof GetReplayInput)["Encoded"]

export const getReplay = Effect.fn("SessionReplays.getReplay")(function* ({
	data,
}: {
	data: GetReplayInput
}) {
	const input = yield* decodeInput(GetReplayInput, data ?? {}, "getReplay")
	const result = yield* runWarehouseQuery("getReplay", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.getReplay({
				payload: new GetReplayRequest({
					sessionId: input.sessionId,
					windowStart: input.windowStart,
					windowEnd: input.windowEnd,
				}),
			})
		}),
	)
	return { data: result.data }
})

// Session event chunks — manifest first, then bounded ranges (v2)
//
// A session's rrweb payload is unbounded by construction: ingest accepts up to
// 1 GiB and the p99 session is ~594 MB. Fetching all of it in one response
// buffered the whole thing into a 128 MB Worker and surfaced as a 503 that
// blamed the database. So the player pulls the cheap manifest (timeline and
// sizes, no payloads), then pulls payloads a range at a time.
//
// These are the only replay reads on v2 — the v1 group has no payload endpoint
// precisely so the unbounded read cannot come back.

/** Warehouse `YYYY-MM-DD HH:mm:ss` → the ISO-8601 the v2 query params take. */
const toIsoWindow = (value: string | undefined) =>
	value === undefined ? undefined : new Date(`${value.replace(" ", "T")}Z`).toISOString()

const GetReplayManifestInput = Schema.Struct({
	sessionId: SessionId,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type GetReplayManifestInput = (typeof GetReplayManifestInput)["Encoded"]

export const getReplayManifest = Effect.fn("SessionReplays.getReplayManifest")(function* ({
	data,
}: {
	data: GetReplayManifestInput
}) {
	const input = yield* decodeInput(GetReplayManifestInput, data ?? {}, "getReplayManifest")
	return yield* runWarehouseQueryV2("getReplayManifest", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			// The `srep_…` public-ID codec lives in the client's param encoder, so
			// the internal SessionId goes in as-is.
			return yield* client.sessionReplays.manifest({
				params: { id: input.sessionId },
				query: {
					...(toIsoWindow(input.windowStart) !== undefined
						? { window_start: toIsoWindow(input.windowStart)! }
						: {}),
					...(toIsoWindow(input.windowEnd) !== undefined
						? { window_end: toIsoWindow(input.windowEnd)! }
						: {}),
				},
			})
		}),
	)
})

const GetReplayEventsInput = Schema.Struct({
	sessionId: SessionId,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
	/**
	 * Inclusive chunk range from the manifest. Required: an optional range would
	 * leave the unbounded read reachable from the client, and something would
	 * eventually reach it.
	 */
	fromChunkSeq: Schema.Number,
	toChunkSeq: Schema.Number,
})
export type GetReplayEventsInput = (typeof GetReplayEventsInput)["Encoded"]

export const getReplayEvents = Effect.fn("SessionReplays.getReplayEvents")(function* ({
	data,
}: {
	data: GetReplayEventsInput
}) {
	const input = yield* decodeInput(GetReplayEventsInput, data ?? {}, "getReplayEvents")
	const result = yield* runWarehouseQueryV2("getReplayEvents", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.sessionReplays.events({
				params: { id: input.sessionId },
				query: {
					from_chunk_seq: input.fromChunkSeq,
					to_chunk_seq: input.toChunkSeq,
					// One page covers the whole range: ranges are sized by the caller
					// against the server's advertised cap, so paging within one would
					// only add round-trips.
					limit: Math.max(1, input.toChunkSeq - input.fromChunkSeq + 1),
					...(toIsoWindow(input.windowStart) !== undefined
						? { window_start: toIsoWindow(input.windowStart)! }
						: {}),
					...(toIsoWindow(input.windowEnd) !== undefined
						? { window_end: toIsoWindow(input.windowEnd)! }
						: {}),
				},
			})
		}),
	)
	return { chunks: result.data }
})

// Distilled session transcript (console / network / errors / nav / clicks)

const SessionTranscriptInput = Schema.Struct({
	sessionId: SessionId,
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type SessionTranscriptInput = (typeof SessionTranscriptInput)["Encoded"]

export const getSessionTranscript = Effect.fn("SessionReplays.sessionTranscript")(function* ({
	data,
}: {
	data: SessionTranscriptInput
}) {
	const input = yield* decodeInput(SessionTranscriptInput, data ?? {}, "sessionTranscript")
	const result = yield* runWarehouseQuery("sessionTranscript", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.sessionTranscript({
				payload: new SessionTranscriptRequest({
					sessionId: input.sessionId,
					windowStart: input.windowStart,
					windowEnd: input.windowEnd,
				}),
			})
		}),
	)
	return { data: result.data }
})

// Reverse correlation: replays observing a trace

const ReplaysForTraceInput = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})
export type ReplaysForTraceInput = (typeof ReplaysForTraceInput)["Encoded"]

export const getReplaysForTrace = Effect.fn("SessionReplays.replaysForTrace")(function* ({
	data,
}: {
	data: ReplaysForTraceInput
}) {
	const input = yield* decodeInput(ReplaysForTraceInput, data ?? {}, "replaysForTrace")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("replaysForTrace", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.replaysForTrace({
				payload: new ReplaysForTraceRequest({
					traceId: input.traceId,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)
	return { data: result.data }
})

// Per-trace summaries for a session's correlated traces (timeline bars)

const SessionTraceSummariesInput = Schema.Struct({
	traceIds: Schema.Array(TraceId),
	windowStart: Schema.optional(WarehouseDateTimeString),
	windowEnd: Schema.optional(WarehouseDateTimeString),
})
export type SessionTraceSummariesInput = (typeof SessionTraceSummariesInput)["Encoded"]

export const getSessionTraceSummaries = Effect.fn("SessionReplays.traceSummaries")(function* ({
	data,
}: {
	data: SessionTraceSummariesInput
}) {
	const input = yield* decodeInput(SessionTraceSummariesInput, data ?? { traceIds: [] }, "traceSummaries")
	const result = yield* runWarehouseQuery("traceSummaries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.sessionReplays.traceSummaries({
				payload: new SessionTraceSummariesRequest({
					traceIds: input.traceIds,
					windowStart: input.windowStart,
					windowEnd: input.windowEnd,
				}),
			})
		}),
	)
	return { data: result.data }
})
