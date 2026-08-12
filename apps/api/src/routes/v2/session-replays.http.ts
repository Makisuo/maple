import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, SessionId, TraceId } from "@maple/domain/http"
import {
	MAX_REPLAY_CHUNKS_PER_REQUEST,
	MAX_REPLAY_EVENTS_RESPONSE_BYTES,
	MAX_REPLAY_MANIFEST_CHUNKS,
	LIST_LIMIT_DEFAULT,
	MapleApiV2,
	paginateOffsetQuery,
	timestamp,
	toV2Error,
	V2ParameterInvalid,
	V2SessionReplayNotFound,
	V2SessionReplayRangeTooLarge,
} from "@maple/domain/http/v2"
import type { Timestamp } from "@maple/domain/http/v2"
import type { WarehouseError } from "@maple/domain/http"
import type { WarehouseResponseLimitError } from "@maple/query-engine/execution"
import type {
	V2SessionReplay,
	V2SessionReplayChunk,
	V2SessionReplayChunkMeta,
	V2SessionReplayListItem,
	V2SessionReplayManifest,
	V2SessionReplayRef,
	V2SessionTranscriptEvent,
} from "@maple/domain/http/v2"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Effect, Layer, Option, Schema } from "effect"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { ReplayBlobStore, ReplayBlobStoreLive } from "@/platform/ReplayBlobStore"

const decodeSessionId = Schema.decodeSync(SessionId)
const decodeTraceId = Schema.decodeSync(TraceId)

/**
 * Refuse a chunk range whose payload would blow the response budget, before a
 * byte of it is fetched.
 *
 * Once payloads live in R2 the warehouse response is only an index — `Events` is
 * empty — so the `responseLimits` ceiling on that read stops measuring anything
 * that matters, and the memory cost moves to hydration. `ByteSize` is the
 * uncompressed payload size and is right there in the index, so the range can be
 * rejected without touching the blob store at all. Cheaper and more honest than
 * discovering the problem mid-hydration.
 */
const assertRangeFitsBudget = (rows: ReadonlyArray<{ readonly byteSize: number }>) => {
	const total = rows.reduce((sum, row) => sum + Number(row.byteSize), 0)
	return total <= MAX_REPLAY_EVENTS_RESPONSE_BYTES
		? Effect.void
		: Effect.fail(V2SessionReplayRangeTooLarge.make(undefined, { param: "to_chunk_seq" }))
}

/**
 * Warehouse errors → the v2 envelope, plus the bounded-read refusal.
 *
 * `range_too_large` keeps its message verbatim across the public boundary: it
 * carries no database diagnostics — only the range asked for — and unlike the
 * warehouse faults it is entirely actionable, so redacting it would strip the
 * one useful thing it says.
 */
const mapReplayReadError = (error: WarehouseError | WarehouseResponseLimitError) =>
	error._tag === "@maple/query-engine/execution/WarehouseResponseLimitError"
		? V2SessionReplayRangeTooLarge.make(undefined, { param: "to_chunk_seq" })
		: toV2Error(error)

/** ISO-8601 → Tinybird `YYYY-MM-DD HH:mm:ss` (UTC), validated. */
const toTinybird = (value: string, param: string) => {
	const ms = Date.parse(value)
	return Number.isNaN(ms)
		? Effect.fail(V2ParameterInvalid.make(`Invalid ISO-8601 timestamp for ${param}.`, { param }))
		: Effect.succeed(formatWarehouseDateTime(ms))
}

const optTinybird = (value: string | undefined, param: string) =>
	value === undefined ? Effect.succeed(undefined) : toTinybird(value, param)

/** ClickHouse/Tinybird datetime string → ISO-8601 UTC (defensive; UTC wall-clock). */
const chToIso = (value: string): Timestamp => {
	const normalized = value.includes("T") ? value : value.replace(" ", "T")
	const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`
	const ms = Date.parse(zoned)
	return timestamp(Number.isNaN(ms) ? value : new Date(ms).toISOString())
}

const chToIsoOrNull = (value: string | null): Timestamp | null => (value === null ? null : chToIso(value))

const nullableUserId = (value: string | null): string | null => (value ? value : null)

const HttpV2SessionReplaysGroup = HttpApiBuilder.group(MapleApiV2, "sessionReplays", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const blobs = yield* ReplayBlobStore

		const requireSession = Effect.fn("HttpV2SessionReplays.requireSession")(function* (
			tenant: CurrentTenant.TenantSchema,
			sessionId: SessionId,
			windowStart: string | undefined,
			windowEnd: string | undefined,
		) {
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, sessionId })
			const compiled = CH.compile(
				CH.getSessionReplayQuery({ startTime: windowStart, endTime: windowEnd }),
				{ orgId: tenant.orgId, sessionId },
			)
			const replay = yield* warehouse
				.compiledQueryFirst(tenant, compiled, { profile: "discovery", context: "v2RequireReplay" })
				.pipe(Effect.mapError(toV2Error))
			if (Option.isNone(replay)) {
				return yield* Effect.fail(V2SessionReplayNotFound.make())
			}
		})

		return handlers
			.handle("search", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const startTime = yield* toTinybird(payload.start_time, "start_time")
					const endTime = yield* toTinybird(payload.end_time, "end_time")
					const page = yield* paginateOffsetQuery(payload, ({ limit, offset }) => {
						const compiled = CH.compile(
							CH.sessionReplaysListQuery({
								...(payload.service_name !== undefined
									? { serviceName: payload.service_name }
									: {}),
								...(payload.browser !== undefined ? { browser: payload.browser } : {}),
								...(payload.country !== undefined ? { country: payload.country } : {}),
								...(payload.device_type !== undefined
									? { deviceType: payload.device_type }
									: {}),
								...(payload.user_id !== undefined ? { userId: payload.user_id } : {}),
								...(payload.user_search !== undefined
									? { userSearch: payload.user_search }
									: {}),
								...(payload.group_name !== undefined
									? { groupName: payload.group_name }
									: {}),
								...(payload.has_errors !== undefined
									? { hasErrors: payload.has_errors }
									: {}),
								...(payload.search !== undefined ? { search: payload.search } : {}),
								...(payload.duration_min_ms !== undefined
									? { durationMinMs: payload.duration_min_ms }
									: {}),
								...(payload.duration_max_ms !== undefined
									? { durationMaxMs: payload.duration_max_ms }
									: {}),
								...(payload.active_time_min_ms !== undefined
									? { activeTimeMinMs: payload.active_time_min_ms }
									: {}),
								...(payload.active_time_max_ms !== undefined
									? { activeTimeMaxMs: payload.active_time_max_ms }
									: {}),
								limit,
								offset,
							}),
							{ orgId: tenant.orgId, startTime, endTime },
						)
						return warehouse
							.compiledQuery(tenant, compiled, { profile: "list", context: "v2SearchReplays" })
							.pipe(
								Effect.mapError(toV2Error),
								Effect.map(
									(rows): ReadonlyArray<V2SessionReplayListItem> =>
										rows.map((row) => ({
											id: decodeSessionId(row.sessionId),
											object: "session_replay" as const,
											start_time: chToIso(row.startTime),
											end_time: chToIsoOrNull(row.endTime),
											duration_ms: row.durationMs,
											status: row.status,
											user_id: nullableUserId(row.userId),
											user_name: row.userName,
											user_email: row.userEmail,
											group_id: row.groupId,
											group_name: row.groupName,
											url_initial: row.urlInitial,
											browser_name: row.browserName,
											os_name: row.osName,
											device_type: row.deviceType,
											country: row.country,
											service_name: row.serviceName,
											page_views: row.pageViews,
											click_count: row.clickCount,
											error_count: row.errorCount,
											// `length()` is UInt64 — ClickHouse JSON-quotes it as a string.
											trace_count: Number(row.traceCount),
										})),
								),
							)
					})
					return {
						object: "list" as const,
						...page,
					}
				}),
			)
			.handle("retrieve", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const windowStart = yield* optTinybird(query.window_start, "window_start")
					const windowEnd = yield* optTinybird(query.window_end, "window_end")
					const detailCompiled = CH.compile(
						CH.getSessionReplayQuery({ startTime: windowStart, endTime: windowEnd }),
						{ orgId: tenant.orgId, sessionId: params.id },
					)
					const activityCompiled = CH.compile(
						CH.sessionActivityQuery({ startTime: windowStart, endTime: windowEnd }),
						{ orgId: tenant.orgId, sessionId: params.id },
					)
					// Warm the route before fanning out — see the v1 handler for why.
					yield* warehouse.warmRoute(tenant)
					const [maybeData, maybeActivity] = yield* Effect.all(
						[
							warehouse.compiledQueryFirst(tenant, detailCompiled, {
								profile: "discovery",
								context: "v2GetReplay",
							}),
							warehouse.compiledQueryFirst(tenant, activityCompiled, {
								profile: "discovery",
								context: "v2GetReplayActivity",
							}),
						],
						{ concurrency: 2 },
					).pipe(Effect.mapError(toV2Error))
					const data = Option.getOrNull(maybeData)
					if (!data) {
						return yield* Effect.fail(V2SessionReplayNotFound.make())
					}
					const activity = Option.getOrNull(maybeActivity)
					const replay = {
						id: decodeSessionId(data.sessionId),
						object: "session_replay",
						start_time: chToIso(data.startTime),
						end_time: chToIsoOrNull(data.endTime),
						duration_ms: data.durationMs,
						status: data.status,
						user_id: nullableUserId(data.userId),
						user_name: data.userName,
						user_email: data.userEmail,
						group_id: data.groupId,
						group_name: data.groupName,
						url_initial: data.urlInitial,
						browser_name: data.browserName,
						os_name: data.osName,
						device_type: data.deviceType,
						country: data.country,
						service_name: data.serviceName,
						page_views: data.pageViews,
						click_count: data.clickCount,
						error_count: data.errorCount,
						trace_count: data.traceIds.length,
						user_agent: data.userAgent,
						trace_ids: data.traceIds.map((traceId) => decodeTraceId(traceId)),
						resource_attributes: data.resourceAttributes,
						// UInt64 → coerce before Schema.Number validates.
						active_time_ms: activity ? Number(activity.activeTimeMs) : null,
						idle_time_ms: activity ? Number(activity.idleTimeMs) : null,
					} satisfies V2SessionReplay
					return replay
				}),
			)
			.handle("manifest", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const windowStart = yield* optTinybird(query.window_start, "window_start")
					const windowEnd = yield* optTinybird(query.window_end, "window_end")
					const compiled = CH.compile(
						CH.sessionReplayChunkIndexQuery({ startTime: windowStart, endTime: windowEnd }),
						{ orgId: tenant.orgId, sessionId: params.id },
					)
					// `discovery` is enough — this never reads the `Events` column, and
					// with payloads in R2 there is nothing to hydrate here either: the
					// manifest is a pure index read whatever the storage backend.
					const rows = yield* warehouse
						.compiledQuery(tenant, compiled, {
							profile: "discovery",
							context: "v2GetReplayManifest",
						})
						.pipe(Effect.mapError(toV2Error))
					if (rows.length === 0) {
						yield* requireSession(tenant, params.id, windowStart, windowEnd)
					}
					const truncated = rows.length > MAX_REPLAY_MANIFEST_CHUNKS
					// ClickHouse JSON-quotes 64-bit ints on backends that refuse the
					// unquote setting; coerce before Schema.Number validates.
					const chunks = rows.slice(0, MAX_REPLAY_MANIFEST_CHUNKS).map(
						(row) =>
							({
								chunk_seq: Number(row.chunkSeq),
								timestamp: chToIso(row.timestamp),
								duration_ms: Number(row.durationMs),
								event_count: Number(row.eventCount),
								byte_size: Number(row.byteSize),
								is_checkpoint: Number(row.isCheckpoint) !== 0,
							}) satisfies V2SessionReplayChunkMeta,
					)
					yield* Effect.annotateCurrentSpan({
						"maple.replay.chunk_count": chunks.length,
						"maple.replay.truncated": truncated,
					})
					return {
						object: "session_replay.manifest" as const,
						session_id: params.id,
						chunks,
						chunk_count: chunks.length,
						total_byte_size: chunks.reduce((sum, chunk) => sum + chunk.byte_size, 0),
						max_chunks_per_request: MAX_REPLAY_CHUNKS_PER_REQUEST,
						max_bytes_per_request: MAX_REPLAY_EVENTS_RESPONSE_BYTES,
						truncated,
					} satisfies V2SessionReplayManifest
				}),
			)
			.handle("events", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const windowStart = yield* optTinybird(query.window_start, "window_start")
					const windowEnd = yield* optTinybird(query.window_end, "window_end")
					// Clamp rather than reject: asking for a chunk past the cap should
					// still return data. Only a range whose *payload* blows the byte
					// budget is refused, below.
					const fromChunkSeq = query.from_chunk_seq
					const toChunkSeq =
						fromChunkSeq === undefined
							? query.to_chunk_seq
							: Math.min(
									query.to_chunk_seq ?? Number.POSITIVE_INFINITY,
									fromChunkSeq + MAX_REPLAY_CHUNKS_PER_REQUEST - 1,
								)
					yield* Effect.annotateCurrentSpan({
						"maple.session.id": params.id,
						"maple.replay.chunk_from": fromChunkSeq ?? -1,
						"maple.replay.chunk_to": toChunkSeq ?? -1,
					})
					// Pagination is pushed into SQL. It used to be applied to an
					// already-materialized array, so every page paid for the whole
					// session's payload — the read this endpoint could never survive.
					//
					// The page size is clamped to the same cap the SQL enforces. Left
					// unclamped, `limit=100` would ask the lookahead for 101 rows, get
					// the SQL cap of 41, and conclude 41 <= 100 means "no more pages" —
					// silently returning a short page with `has_more: false` and
					// dropping the rest of the recording.
					const pageQuery = {
						...query,
						limit: Math.min(query.limit ?? LIST_LIMIT_DEFAULT, MAX_REPLAY_CHUNKS_PER_REQUEST),
					}
					const page = yield* paginateOffsetQuery(pageQuery, ({ limit, offset }) => {
						const compiled = CH.compile(
							CH.sessionReplayEventsQuery({
								startTime: windowStart,
								endTime: windowEnd,
								fromChunkSeq,
								toChunkSeq: toChunkSeq === Number.POSITIVE_INFINITY ? undefined : toChunkSeq,
								limit: Math.min(limit, MAX_REPLAY_CHUNKS_PER_REQUEST + 1),
								offset,
							}),
							{ orgId: tenant.orgId, sessionId: params.id },
						)
						// Two ceilings, because there are two places the payload can come
						// from. `responseLimits` bounds what the warehouse hands back —
						// the only guard for pre-cutover rows, which still carry `events`
						// inline. Blob-backed rows make that response nearly empty, so it
						// would pass anything; `assertRangeFitsBudget` below bounds the
						// hydration instead, using sizes the index already knows.
						return warehouse
							.compiledQueryBounded(tenant, compiled, {
								profile: "list",
								context: "v2GetReplayEvents",
								responseLimits: {
									maxRows: MAX_REPLAY_CHUNKS_PER_REQUEST + 1,
									maxBytes: MAX_REPLAY_EVENTS_RESPONSE_BYTES,
								},
							})
							.pipe(
								Effect.mapError(mapReplayReadError),
								Effect.tap((rows) =>
									rows.length === 0 && offset === 0
										? requireSession(tenant, params.id, windowStart, windowEnd)
										: Effect.void,
								),
								Effect.tap(assertRangeFitsBudget),
								// Blob-backed rows (empty `events`) get their payload from
								// R2; pre-cutover rows already carry it inline.
								Effect.flatMap((rows) => blobs.hydrate(tenant.orgId, params.id, rows)),
								Effect.map(
									(rows): ReadonlyArray<V2SessionReplayChunk> =>
										rows.map((row) => ({
											object: "session_replay.event_chunk" as const,
											chunk_seq: Number(row.chunkSeq),
											timestamp: chToIso(row.timestamp),
											duration_ms: Number(row.durationMs),
											event_count: Number(row.eventCount),
											byte_size: Number(row.byteSize),
											is_checkpoint: Number(row.isCheckpoint) !== 0,
											events: row.events,
										})),
								),
							)
					})
					return { object: "list" as const, ...page }
				}),
			)
			.handle("transcript", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const windowStart = yield* optTinybird(query.window_start, "window_start")
					const windowEnd = yield* optTinybird(query.window_end, "window_end")
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) => {
						const compiled = CH.compile(
							CH.sessionTranscriptQuery({
								startTime: windowStart,
								endTime: windowEnd,
								limit,
								offset,
							}),
							{ orgId: tenant.orgId, sessionId: params.id },
						)
						return warehouse
							.compiledQuery(tenant, compiled, {
								profile: "list",
								context: "v2SessionTranscript",
							})
							.pipe(
								Effect.mapError(toV2Error),
								Effect.tap((rows) =>
									rows.length === 0 && offset === 0
										? requireSession(tenant, params.id, windowStart, windowEnd)
										: Effect.void,
								),
								Effect.map(
									(rows): ReadonlyArray<V2SessionTranscriptEvent> =>
										rows.map((row) => ({
											object: "session_replay.transcript_event" as const,
											timestamp: chToIso(row.timestamp),
											seq: row.seq,
											type: row.type,
											url: row.url,
											trace_id: row.traceId ? decodeTraceId(row.traceId) : null,
											level: row.level === "" ? null : row.level,
											message: row.message === "" ? null : row.message,
											target_selector:
												row.targetSelector === "" ? null : row.targetSelector,
											target_text: row.targetText === "" ? null : row.targetText,
											net_method:
												row.type === "network" && row.netMethod !== ""
													? row.netMethod
													: null,
											net_url:
												row.type === "network" && row.netUrl !== ""
													? row.netUrl
													: null,
											net_status: row.type === "network" ? row.netStatus : null,
											net_duration_ms:
												row.type === "network" ? row.netDurationMs : null,
											error_stack:
												row.type === "error" && row.errorStack !== ""
													? row.errorStack
													: null,
										})),
								),
							)
					})
					return { object: "list" as const, ...page }
				}),
			)
			.handle("forTrace", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const startTime = yield* toTinybird(payload.start_time, "start_time")
					const endTime = yield* toTinybird(payload.end_time, "end_time")
					const page = yield* paginateOffsetQuery(payload, ({ limit, offset }) => {
						const compiled = CH.compile(
							CH.sessionsForTraceQuery({ traceId: payload.trace_id, limit, offset }),
							{ orgId: tenant.orgId, startTime, endTime },
						)
						return warehouse
							.compiledQuery(tenant, compiled, {
								profile: "list",
								context: "v2ReplaysForTrace",
							})
							.pipe(
								Effect.mapError(toV2Error),
								Effect.map(
									(rows): ReadonlyArray<V2SessionReplayRef> =>
										rows.map((row) => ({
											object: "session_replay.ref" as const,
											id: decodeSessionId(row.sessionId),
											start_time: chToIso(row.startTime),
											duration_ms: row.durationMs,
										})),
								),
							)
					})
					return {
						object: "list" as const,
						...page,
					}
				}),
			)
	}),
)

// Self-contained: the blob store resolves from the worker env (and degrades to
// a no-op hydrator when the R2 binding is absent), so it is provided here
// rather than pushed onto every caller that builds this group — the v2 route
// tests construct their own layer stack and would otherwise have to know about
// a storage detail of one handler.
export const HttpV2SessionReplaysLive = HttpV2SessionReplaysGroup.pipe(Layer.provide(ReplayBlobStoreLive))
