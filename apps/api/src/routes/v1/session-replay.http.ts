import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	GetReplayResponse,
	ListReplaysResponse,
	MapleApi,
	ReplaysForTraceResponse,
	SessionTranscriptResponse,
	SessionId,
	TraceId,
	UserId,
} from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

const decodeSessionId = Schema.decodeSync(SessionId)
const decodeTraceId = Schema.decodeSync(TraceId)
const decodeUserId = Schema.decodeSync(UserId)

export const HttpSessionReplaysLive = HttpApiBuilder.group(MapleApi, "sessionReplays", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		return handlers
			.handle("listReplays", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compile(
						CH.sessionReplaysListQuery({
							serviceName: payload.serviceName,
							browser: payload.browser,
							country: payload.country,
							deviceType: payload.deviceType,
							userId: payload.userId,
							userSearch: payload.userSearch,
							groupName: payload.groupName,
							visitorId: payload.visitorId,
							hasErrors: payload.hasErrors,
							search: payload.search,
							cursor: payload.cursor,
							durationMinMs: payload.durationMinMs,
							durationMaxMs: payload.durationMaxMs,
							activeTimeMinMs: payload.activeTimeMinMs,
							activeTimeMaxMs: payload.activeTimeMaxMs,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "listReplays",
					})
					return new ListReplaysResponse({
						data: rows.map((row) => ({
							...row,
							sessionId: decodeSessionId(row.sessionId),
							userId: row.userId ? decodeUserId(row.userId) : null,
							// `length()` is UInt64; the ClickHouse path JSON-quotes it as a
							// string while the Tinybird path returns a number. Coerce before
							// Schema.Number validates the response (see the facets handler).
							traceCount: Number(row.traceCount),
						})),
					})
				}),
			)
			.handle("getReplay", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.session.id": payload.sessionId,
					})
					const compiled = CH.compile(
						CH.getSessionReplayQuery({
							startTime: payload.windowStart,
							endTime: payload.windowEnd,
						}),
						{
							orgId: tenant.orgId,
							sessionId: payload.sessionId,
						},
					)
					// Active/idle breakdown from session_events gaps. Both reads are
					// single-session sort-key seeks (`(OrgId, SessionId)` prefix) sharing
					// the partition-pruning window, so they're cheap and independent — run
					// them concurrently to keep the detail page to one round-trip of
					// latency rather than two.
					const activityCompiled = CH.compile(
						CH.sessionActivityQuery({
							startTime: payload.windowStart,
							endTime: payload.windowEnd,
						}),
						{ orgId: tenant.orgId, sessionId: payload.sessionId },
					)
					// Resolve the org's route before fanning out, so the config read lands
					// on an empty connection pool instead of queueing behind a sibling's
					// warehouse fetch. No-op once the in-isolate memo is warm.
					yield* warehouse.warmRoute(tenant)
					const [maybeData, maybeActivity] = yield* Effect.all(
						[
							warehouse.compiledQueryFirst(tenant, compiled, {
								profile: "discovery",
								context: "getReplay",
							}),
							warehouse.compiledQueryFirst(tenant, activityCompiled, {
								profile: "discovery",
								context: "getReplayActivity",
							}),
						],
						{ concurrency: 2 },
					)
					const data = Option.getOrNull(maybeData)
					if (!data) {
						return new GetReplayResponse({ data: null })
					}
					const activity = Option.getOrNull(maybeActivity)

					return new GetReplayResponse({
						data: {
							...data,
							sessionId: decodeSessionId(data.sessionId),
							userId: data.userId ? decodeUserId(data.userId) : null,
							traceIds: data.traceIds.map((traceId) => decodeTraceId(traceId)),
							// UInt8 on the wire (and a JSON-quoted "1" on backends that
							// refuse the unquote setting) — the response schema is Boolean.
							visitorIsNew: Number(data.visitorIsNew) === 1,
							// ClickHouse JSON-quotes 64-bit ints as strings; coerce before
							// Schema.Number validates (see the facets handler).
							activeTimeMs: activity ? Number(activity.activeTimeMs) : null,
							idleTimeMs: activity ? Number(activity.idleTimeMs) : null,
						},
					})
				}),
			)
			.handle("replaysForTrace", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.trace.id": payload.traceId,
					})
					const compiled = CH.compile(CH.sessionsForTraceQuery({ traceId: payload.traceId }), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "replaysForTrace",
					})
					return new ReplaysForTraceResponse({
						data: rows.map((row) => ({
							...row,
							sessionId: decodeSessionId(row.sessionId),
						})),
					})
				}),
			)
			.handle("sessionTranscript", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.session.id": payload.sessionId,
					})
					const compiled = CH.compile(
						CH.sessionTranscriptQuery({
							startTime: payload.windowStart,
							endTime: payload.windowEnd,
						}),
						{
							orgId: tenant.orgId,
							sessionId: payload.sessionId,
						},
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "sessionTranscript",
					})
					return new SessionTranscriptResponse({
						data: rows.map((row) => ({
							...row,
							traceId: row.traceId ? decodeTraceId(row.traceId) : null,
						})),
					})
				}),
			)
	}),
)
