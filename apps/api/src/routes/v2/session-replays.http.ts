import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, SessionId, TraceId } from "@maple/domain/http"
import {
	MapleApiV2,
	dependencyUnavailable,
	invalidRequest,
	paginateArray,
	paginateOffsetQuery,
	resourceNotFound,
	timestamp,
} from "@maple/domain/http/v2"
import type { Timestamp } from "@maple/domain/http/v2"
import type {
	V2SessionReplay,
	V2SessionReplayChunk,
	V2SessionReplayListItem,
	V2SessionReplayRef,
	V2SessionTranscriptEvent,
} from "@maple/domain/http/v2"
import { CH } from "@maple/query-engine"
import { Effect, Option, Schema } from "effect"
import { WarehouseQueryService } from "../../lib/WarehouseQueryService"

const decodeSessionId = Schema.decodeSync(SessionId)
const decodeTraceId = Schema.decodeSync(TraceId)

/** Warehouse/query-engine errors → a uniform 503 (all reads). */
const mapWarehouseError = () => dependencyUnavailable("session_replay_query_unavailable")

/** ISO-8601 → Tinybird `YYYY-MM-DD HH:mm:ss` (UTC), validated. */
const toTinybird = (value: string, param: string) => {
	const ms = Date.parse(value)
	return Number.isNaN(ms)
		? Effect.fail(invalidRequest("parameter_invalid", `Invalid ISO-8601 timestamp for ${param}.`, param))
		: Effect.succeed(new Date(ms).toISOString().slice(0, 19).replace("T", " "))
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

export const HttpV2SessionReplaysLive = HttpApiBuilder.group(MapleApiV2, "sessionReplays", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

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
				.pipe(Effect.mapError(mapWarehouseError))
			if (Option.isNone(replay)) {
				return yield* resourceNotFound("session_replay", "No such session replay.")
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
								Effect.mapError(mapWarehouseError),
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
					).pipe(Effect.mapError(mapWarehouseError))
					const data = Option.getOrNull(maybeData)
					if (!data) {
						return yield* Effect.fail(
							resourceNotFound("session_replay", "No such session replay."),
						)
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
			.handle("events", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const windowStart = yield* optTinybird(query.window_start, "window_start")
					const windowEnd = yield* optTinybird(query.window_end, "window_end")
					const compiled = CH.compile(
						CH.sessionReplayEventsQuery({ startTime: windowStart, endTime: windowEnd }),
						{ orgId: tenant.orgId, sessionId: params.id },
					)
					const rows = yield* warehouse
						.compiledQuery(tenant, compiled, { profile: "list", context: "v2GetReplayEvents" })
						.pipe(Effect.mapError(mapWarehouseError))
					if (rows.length === 0) {
						yield* requireSession(tenant, params.id, windowStart, windowEnd)
					}
					const chunks = rows.map(
						(row) =>
							({
								object: "session_replay.event_chunk" as const,
								chunk_seq: row.chunkSeq,
								timestamp: chToIso(row.timestamp),
								duration_ms: row.durationMs,
								event_count: row.eventCount,
								byte_size: row.byteSize,
								is_checkpoint: Number(row.isCheckpoint) !== 0,
								events: row.events,
							}) satisfies V2SessionReplayChunk,
					)
					const page = yield* paginateArray(chunks, query)
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
								Effect.mapError(mapWarehouseError),
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
								Effect.mapError(mapWarehouseError),
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
