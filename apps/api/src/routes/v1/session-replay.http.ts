import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	GetReplayEventsResponse,
	GetReplayResponse,
	ListReplaysResponse,
	ReplaysFacetsResponse,
	MapleApi,
	ReplaysForTraceResponse,
	SessionTranscriptResponse,
	SessionTraceSummariesResponse,
	SessionId,
	TraceId,
	UserId,
} from "@maple/domain/http"
import { Effect, Layer, Option, Schema } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { ReplayBlobStore, ReplayBlobStoreLive } from "@/platform/ReplayBlobStore"

const decodeSessionId = Schema.decodeSync(SessionId)
const decodeTraceId = Schema.decodeSync(TraceId)
const decodeUserId = Schema.decodeSync(UserId)

const HttpSessionReplaysGroup = HttpApiBuilder.group(MapleApi, "sessionReplays", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const blobs = yield* ReplayBlobStore

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
			.handle("facets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compileUnion(
						CH.sessionReplaysFacetsQuery({
							serviceName: payload.serviceName,
							browser: payload.browser,
							country: payload.country,
							deviceType: payload.deviceType,
							userId: payload.userId,
							hasErrors: payload.hasErrors,
							search: payload.search,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "replaysFacets",
					})
					// ClickHouse serializes integer aggregates (`uniq(...)`) as JSON strings,
					// while the Tinybird path returns numbers; this query declares no row
					// schema, so coerce at the edge before the Schema.Number response validates.
					const pick = (facetType: string) =>
						rows
							.filter((row) => row.facetType === facetType)
							.map((row) => ({ name: row.name, count: Number(row.count) }))
					// The percentile branches ride the same {name, count} shape as the
					// facets, with the quantile in `count` — read them back by label.
					const stat = (name: string) =>
						Number(
							rows.find((row) => row.facetType === "durationStat" && row.name === name)
								?.count ?? 0,
						)
					return new ReplaysFacetsResponse({
						services: pick("service"),
						browsers: pick("browser"),
						countries: pick("country"),
						devices: pick("device"),
						errorCount: Number(rows.find((row) => row.facetType === "error")?.count ?? 0),
						durationBuckets: pick("durationBucket"),
						durationP50: stat("p50"),
						durationP95: stat("p95"),
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
			.handle("getReplayEvents", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.session.id": payload.sessionId,
					})
					const compiled = CH.compile(
						CH.sessionReplayEventsQuery({
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
						context: "getReplayEvents",
					})
					// Each chunk's `events` is the rrweb array JSON the player parses.
					// Rows written since the R2 cutover carry an empty `events` and the
					// payload comes from the blob store; older rows carry it inline and
					// pass through untouched.
					const chunks = yield* blobs.hydrate(tenant.orgId, payload.sessionId, rows)
					return new GetReplayEventsResponse({ chunks })
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
			.handle("traceSummaries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.trace.count": payload.traceIds.length,
					})
					// `TraceId IN ()` is invalid SQL; a session with no correlated traces
					// short-circuits to an empty result without touching the warehouse.
					if (payload.traceIds.length === 0) {
						return new SessionTraceSummariesResponse({ data: [] })
					}
					const compiled = CH.compile(
						CH.sessionTraceSummariesQuery({
							traceIds: payload.traceIds,
							startTime: payload.windowStart,
							endTime: payload.windowEnd,
						}),
						{ orgId: tenant.orgId },
					)
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "sessionTraceSummaries",
					})
					return new SessionTraceSummariesResponse({
						data: rows.map((row) => ({
							...row,
							traceId: decodeTraceId(row.traceId),
							// `count()` is UInt64 — same ClickHouse JSON-string coercion as
							// listReplays' traceCount; coerce before Schema.Number validates.
							spanCount: Number(row.spanCount),
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

// Self-contained: the blob store resolves from the worker env (and degrades to
// a no-op hydrator when the R2 binding is absent), so it is provided here
// rather than pushed onto every caller that builds this group — the v2 route
// tests construct their own layer stack and would otherwise have to know about
// a storage detail of one handler.
export const HttpSessionReplaysLive = HttpSessionReplaysGroup.pipe(Layer.provide(ReplayBlobStoreLive))
