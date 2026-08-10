// ---------------------------------------------------------------------------
// Fixtures for query builders that never pass through the pipe registry or the
// QuerySpec lowering — the ~125 exports reached only via direct
// `warehouse.compiledQuery` call sites in apps/api. Without a fixture here a
// builder never meets the ClickHouse analyzer until production.
//
// Each fixture calls the REAL exported builder with parameters shaped like its
// production call site (file:line noted per fixture), so the catalog sweeps the
// SQL the app actually emits. `sql-catalog.test.ts`'s `uncoveredBuilders`
// anti-rot test enforces that every module export is either fixtured here or
// explicitly exempted there — adding a builder without either breaks the build.
//
// Batch ① (2026-08): session-replays, session-events, and the errors builders
// only reachable from ErrorsService/telemetry. Remaining modules live on the
// exemption list and shrink batch by batch.
// ---------------------------------------------------------------------------

import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import * as CH from "./index"

export interface BuilderFixture {
	/** Module basename under `src/ch/queries/`, e.g. `"session-replays"`. */
	readonly module: string
	/** The exported builder this fixture covers — must match the export name. */
	readonly name: string
	/** Distinguishes fixtures for one builder; appears in failure output. */
	readonly label: string
	readonly compile: () => CompiledQuery<unknown>
	/**
	 * Sample values for output columns whose row schema narrows what the ClickHouse
	 * column type allows.
	 *
	 * The E2E sweep decodes a synthetic row to prove the schema accepts both 64-bit
	 * wire shapes, and it builds that row from the DESCRIBEd column *types* alone —
	 * so every `String` column gets `""`. A schema that legitimately narrows a
	 * String (a literal union over a column the SQL itself guarantees, like
	 * `serviceExternalEdges.targetType`) rejects `""` and fails a check that is
	 * about integer quoting, with a message telling the author to reach for
	 * `CH.CHNumber` on a string field.
	 *
	 * The narrowing is worth keeping — `service-map.test.ts` asserts an unexpected
	 * `targetType` is rejected — so the fixture names the value instead. Keyed by
	 * output column name.
	 */
	readonly sampleValues?: Readonly<Record<string, unknown>>
}

const ORG_ID = "org_sql_catalog"
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"
const SESSION_ID = "sess_0af7651916cd43dd"
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const FINGERPRINT = "11640393269246331608"

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

// ----- web-analytics (routes/v1/query-engine.http.ts, via registry/queries.ts) -----
//
// Two fixtures per page-view builder: unfiltered, and with a
// session_replays-only filter set. The second is the one that matters — it
// forces the `SessionId IN (SELECT …)` semi-join branch, which is a whole
// second SQL shape that no unfiltered fixture reaches.
//
// Every one is emitted TWICE, once per page-view source. `useWebEvents` is a
// routing predicate, and `routeCoverage()` in sql-catalog.ts requires a
// predicate to be exercised both ways — but the stronger reason is that the two
// paths are required to return identical numbers, so both SQL shapes belong in
// the reviewable baseline side by side. Generated rather than written out so a
// fixture cannot exist for one source and not the other.
const WEB_ANALYTICS_ALL_FILTERS = {
	host: "maple.dev",
	pagePath: "/pricing",
	referrerHost: "t.co",
	country: "DE",
	deviceType: "desktop",
	browserName: "Chrome",
	osName: "macOS",
	language: "en-US",
	utmSource: "twitter",
	utmMedium: "social",
	utmCampaign: "launch",
	visitorType: "new",
} as const

const webAnalyticsVariants = (
	name: string,
	label: string,
	compile: (useWebEvents: boolean) => CompiledQuery<unknown>,
): ReadonlyArray<BuilderFixture> => [
	{ module: "web-analytics", name, label, compile: () => compile(false) },
	{ module: "web-analytics", name, label: `${label}-rollup`, compile: () => compile(true) },
]

const webAnalyticsFixtures: ReadonlyArray<BuilderFixture> = [
	...webAnalyticsVariants("webAnalyticsSummaryQuery", "default", (useWebEvents) =>
		CH.compile(CH.webAnalyticsSummaryQuery({ useWebEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsSummaryQuery", "filtered", (useWebEvents) =>
		CH.compile(CH.webAnalyticsSummaryQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useWebEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsTimeseriesQuery", "default", (useWebEvents) =>
		CH.compile(CH.webAnalyticsTimeseriesQuery({ bucketSeconds: 3600, useWebEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsPageviewsTimeseriesQuery", "default", (useWebEvents) =>
		CH.compile(CH.webAnalyticsPageviewsTimeseriesQuery({ bucketSeconds: 3600, useWebEvents }), window),
	),
	// Forces the semi-join: `referrerHost` is a session_replays-only dimension,
	// so the page-view source has to narrow through a subquery to honour it.
	...webAnalyticsVariants("webAnalyticsPageviewsTimeseriesQuery", "semi-joined", (useWebEvents) =>
		CH.compile(
			CH.webAnalyticsPageviewsTimeseriesQuery({
				bucketSeconds: 3600,
				referrerHost: "t.co",
				visitorType: "returning",
				useWebEvents,
			}),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsPagesQuery", "default", (useWebEvents) =>
		CH.compile(CH.webAnalyticsPagesQuery({ limit: 100, useWebEvents }), window),
	),
	// host/pagePath filter directly off the page-view source — deliberately NOT
	// through the semi-join, so the 82% of sessions with no analytics block still count.
	...webAnalyticsVariants("webAnalyticsPagesQuery", "url-filtered", (useWebEvents) =>
		CH.compile(CH.webAnalyticsPagesQuery({ limit: 100, host: "maple.dev", useWebEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsPagesQuery", "semi-joined", (useWebEvents) =>
		CH.compile(CH.webAnalyticsPagesQuery({ limit: 100, country: "DE", useWebEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsBreakdownsQuery", "default", (useWebEvents) =>
		CH.compileUnion(CH.webAnalyticsBreakdownsQuery({ useWebEvents }), window),
	),
	// Every dimension selected at once: each branch must exclude its own filter,
	// so this is the fixture that would catch a branch that forgot to. On the
	// rollup variant it is also the one that shows the navigation semi-join being
	// inlined into all twelve branches — the shape the rollup exists to make cheap.
	...webAnalyticsVariants("webAnalyticsBreakdownsQuery", "all-dimensions-filtered", (useWebEvents) =>
		CH.compileUnion(
			CH.webAnalyticsBreakdownsQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useWebEvents }),
			window,
		),
	),
]

export const builderFixtures: ReadonlyArray<BuilderFixture> = [
	// ----- session-replays (routes/session-replay.http.ts, routes/v2/session-replays.http.ts) -----
	{
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "default",
		compile: () => CH.compile(CH.sessionReplaysListQuery({}), window),
	},
	{
		// Filters force the session_events semi-join + activity join branches.
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "filtered",
		compile: () =>
			CH.compile(
				CH.sessionReplaysListQuery({
					serviceName: "web",
					hasErrors: true,
					search: "checkout",
					userSearch: "ada",
					groupName: "Acme Inc",
					durationMinMs: 1_000,
					activeTimeMinMs: 500,
					limit: 50,
				}),
				window,
			),
	},
	{
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "default",
		compile: () => CH.compileUnion(CH.sessionReplaysFacetsQuery({}), window),
	},
	{
		// Covers the identity predicates, which are excluded from their own branch
		// (group) or narrow every branch (userSearch).
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "identity-filtered",
		compile: () =>
			CH.compileUnion(
				CH.sessionReplaysFacetsQuery({ userSearch: "ada", groupName: "Acme Inc" }),
				window,
			),
	},
	{
		module: "session-replays",
		name: "getSessionReplayQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.getSessionReplayQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-replays",
		name: "sessionReplayChunkIndexQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.sessionReplayChunkIndexQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-replays",
		name: "sessionReplayEventsQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.sessionReplayEventsQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		// The shape playback actually emits: a bounded chunk window. Distinct SQL
		// from "default" (ChunkSeq predicates + LIMIT), so it needs its own sweep.
		module: "session-replays",
		name: "sessionReplayEventsQuery",
		label: "ranged",
		compile: () =>
			CH.compile(
				CH.sessionReplayEventsQuery({
					startTime: START_TIME,
					endTime: END_TIME,
					fromChunkSeq: 16,
					toChunkSeq: 31,
					limit: 40,
				}),
				{ orgId: ORG_ID, sessionId: SESSION_ID },
			),
	},
	{
		module: "session-replays",
		name: "sessionsForTraceQuery",
		label: "default",
		compile: () => CH.compile(CH.sessionsForTraceQuery({ traceId: TRACE_ID }), window),
	},
	{
		module: "session-replays",
		name: "sessionTraceSummariesQuery",
		label: "default",
		compile: () =>
			CH.compile(
				CH.sessionTraceSummariesQuery({
					traceIds: [TRACE_ID],
					startTime: START_TIME,
					endTime: END_TIME,
				}),
				{ orgId: ORG_ID },
			),
	},

	// ----- session-events (routes/session-replay.http.ts, v2/session-replays.http.ts) -----
	{
		module: "session-events",
		name: "sessionTranscriptQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.sessionTranscriptQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-events",
		name: "sessionActivityQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.sessionActivityQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},

	...webAnalyticsFixtures,

	// ----- errors builders reached only via direct calls (ErrorsService, v2 telemetry, observability) -----
	{
		// telemetry.http.ts v2GetSpan / observability/span-detail.ts
		module: "errors",
		name: "spanDetailQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID }), { orgId: ORG_ID }),
	},
	{
		module: "errors",
		name: "spanDetailQuery",
		label: "narrowByTime",
		compile: () =>
			CH.compile(
				CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID, narrowByTime: true }),
				window,
			),
	},
	{
		// ErrorsService errorIssuesScan (the scheduled sweep)
		module: "errors",
		name: "errorIssuesQuery",
		label: "scan",
		compile: () => CH.compile(CH.errorIssuesQuery({ limit: 500 }), window),
	},
	{
		// ErrorsService steady-state cursor window over the compact minute rollup.
		module: "errors",
		name: "errorTickIssuesQuery",
		label: "cursor-window",
		compile: () => CH.compile(CH.errorTickIssuesQuery(), window),
	},
	{
		// ErrorsService one-time cursor bootstrap from retained canonical events.
		module: "errors",
		name: "errorTickBootstrapIssuesQuery",
		label: "bootstrap-window",
		compile: () => CH.compile(CH.errorTickBootstrapIssuesQuery(), window),
	},
	{
		// ErrorsService errorIssueEnvFingerprints
		module: "errors",
		name: "errorFingerprintsQuery",
		label: "envFiltered",
		compile: () =>
			CH.compile(
				CH.errorFingerprintsQuery({ services: ["api"], deploymentEnvs: ["production"] }),
				window,
			),
	},
	{
		module: "errors",
		name: "errorIssueTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.errorIssueTimeseriesQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
				bucketSeconds: 300,
			}),
	},
	{
		module: "errors",
		name: "errorIssueSampleTracesQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.errorIssueSampleTracesQuery({ limit: 5 }), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
	},

	// -------------------------------------------------------------------------
	// Batch ④ — the modules the query-engine refactor touches. These exist so a
	// refactor that claims "no SQL changed" is actually checkable: without a
	// fixture, a builder contributes nothing to `__sql_baseline__/catalog.sql`
	// and its SQL can drift silently.
	// -------------------------------------------------------------------------

	// ----- service-operations: the three-tier raw/minutely/hourly splice -----
	{
		// routes/v2/services.http.ts — service detail "Operations" tab.
		module: "service-operations",
		name: "serviceOperationsSummaryQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.serviceOperationsSummaryQuery({ serviceName: "api", limit: 50 }), window),
	},
	{
		// Env filter exercises the extra predicate on every tier of the splice.
		module: "service-operations",
		name: "serviceOperationsSummaryQuery",
		label: "envFiltered",
		compile: () =>
			CH.compile(
				CH.serviceOperationsSummaryQuery({
					serviceName: "api",
					environments: ["production"],
					limit: 50,
				}),
				window,
			),
	},
	{
		module: "service-operations",
		name: "serviceOperationsTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compile(
				CH.serviceOperationsTimeseriesQuery({
					serviceName: "api",
					spanNames: ["GET /v2/services", "POST /v2/alerts"],
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},

	// ----- services: the hourly-rollup splice behind the service catalog -----
	{
		// routes/v2/services.http.ts — the services list.
		module: "services",
		name: "serviceCatalogQuery",
		label: "default",
		compile: () => CH.compile(CH.serviceCatalogQuery({ limit: 50 }), window),
	},
	{
		module: "services",
		name: "serviceCatalogQuery",
		label: "filtered",
		compile: () =>
			CH.compile(
				CH.serviceCatalogQuery({
					serviceName: "api",
					deploymentEnvironment: "production",
					serviceNamespace: "backend",
					limit: 50,
				}),
				window,
			),
	},

	// ----- infra: the four gauge-timeseries shapes and three facet unions -----
	{
		module: "infra",
		name: "hostGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compile(
				CH.hostGaugeTimeseriesQuery({
					hostName: "ip-10-0-1-42",
					metricName: "system.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// `groupByAttributeKey` switches the projected column off the `lit("")` default.
		module: "infra",
		name: "hostGaugeTimeseriesQuery",
		label: "grouped",
		compile: () =>
			CH.compile(
				CH.hostGaugeTimeseriesQuery({
					hostName: "ip-10-0-1-42",
					metricName: "system.cpu.utilization",
					groupByAttributeKey: "cpu",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "podGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compile(
				CH.podGaugeTimeseriesQuery({
					podName: "api-7d9f8b6c5-x2n4k",
					namespace: "backend",
					metricName: "k8s.pod.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "nodeGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compile(
				CH.nodeGaugeTimeseriesQuery({
					nodeName: "ip-10-0-1-42.ec2.internal",
					metricName: "k8s.node.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "workloadGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compile(
				CH.workloadGaugeTimeseriesQuery({
					kind: "deployment",
					workloadName: "api",
					namespace: "backend",
					metricName: "k8s.pod.cpu.utilization",
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		// `groupByPod` fans the workload series out per pod.
		module: "infra",
		name: "workloadGaugeTimeseriesQuery",
		label: "groupedByPod",
		compile: () =>
			CH.compile(
				CH.workloadGaugeTimeseriesQuery({
					kind: "statefulset",
					workloadName: "clickhouse",
					namespace: "data",
					metricName: "k8s.pod.memory.usage",
					groupByPod: true,
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "infra",
		name: "podFacetsQuery",
		label: "default",
		compile: () => CH.compileUnion(CH.podFacetsQuery(), window),
	},
	{
		module: "infra",
		name: "nodeFacetsQuery",
		label: "default",
		compile: () => CH.compileUnion(CH.nodeFacetsQuery(), window),
	},
	{
		module: "infra",
		name: "workloadFacetsQuery",
		label: "default",
		compile: () => CH.compileUnion(CH.workloadFacetsQuery({ kind: "deployment" }), window),
	},

	// ----- service-map: the parent⋈child span join and its two projections.
	// ----- The rollup's rows are `ingest`ed into service_map_edges_hourly
	// ----- verbatim, so these must reach the ClickHouse DESCRIBE sweep.
	{
		// Mirrors ServiceMapRollupService's per-hour call (service-map-rollup.ts).
		module: "service-map",
		name: "serviceMapEdgeJoinQuery",
		label: "rollup-hour",
		compile: () =>
			CH.compile(
				CH.serviceMapEdgeJoinQuery({
					rangeStart: CH.toDateTime(CH.param.dateTime("hourStart")),
					rangeEnd: CH.toDateTime(CH.param.dateTime("hourEnd")),
				}).format("JSON"),
				{ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME },
			),
	},
	{
		// The service-scoped variant pushes the filter into the parent subquery.
		module: "service-map",
		name: "serviceMapEdgeJoinQuery",
		label: "scoped-to-service",
		compile: () =>
			CH.compile(
				CH.serviceMapEdgeJoinQuery({
					rangeStart: CH.toDateTime(CH.param.dateTime("hourStart")),
					rangeEnd: CH.toDateTime(CH.param.dateTime("hourEnd")),
					deploymentEnv: "production",
					parentServiceName: "web",
				}).format("JSON"),
				{ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME },
			),
	},
	{
		module: "service-map-rollup",
		name: "serviceMapEdgesRollupSQL",
		label: "default",
		compile: () =>
			CH.serviceMapEdgesRollupSQL({ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME }),
	},
	{
		module: "service-map-rollup",
		name: "serviceMapEdgesExistingHoursSQL",
		label: "default",
		compile: () => CH.serviceMapEdgesExistingHoursSQL(window),
	},
	{
		module: "service-map-rollup",
		name: "serviceMapResolutionsExistingHoursSQL",
		label: "default",
		compile: () => CH.serviceMapResolutionsExistingHoursSQL(window),
	},
	{
		// Org-wide: hourly MV branch UNION ALL two partial-hour live joins.
		module: "service-map",
		name: "serviceDependenciesSQL",
		label: "default",
		compile: () => CH.serviceDependenciesSQL({}, window),
	},
	{
		module: "service-map",
		name: "serviceDependenciesSQL",
		label: "env-scoped",
		compile: () => CH.serviceDependenciesSQL({ deploymentEnv: "production" }, window),
	},
	{
		module: "service-map",
		name: "serviceDependenciesForServiceQuery",
		label: "default",
		compile: () => CH.compile(CH.serviceDependenciesForServiceQuery({ serviceName: "web" }), window),
	},
	{
		// Hourly MV UNION ALL raw traces, minus the internal-resolution anti-join.
		module: "service-map",
		name: "serviceExternalEdgesSQL",
		label: "default",
		compile: () => CH.serviceExternalEdgesSQL({ serviceName: "web" }, window),
		// TargetType is a String column, but both branches of the UNION emit only
		// http/messaging/rpc, and the row schema holds that line.
		sampleValues: { targetType: "http" },
	},
	{
		module: "service-map",
		name: "serviceExternalEdgesSQL",
		label: "env-scoped",
		compile: () =>
			CH.serviceExternalEdgesSQL({ serviceName: "web", deploymentEnv: "production" }, window),
		sampleValues: { targetType: "http" },
	},

	// ----- traces (runtime/query-engine.ts trace-list page enrichment) -----
	{
		module: "traces",
		name: "traceServicesByTraceIdsQuery",
		label: "page-enrichment",
		compile: () =>
			CH.compile(
				CH.traceServicesByTraceIdsQuery({
					traceIds: [TRACE_ID, "4bf92f3577b34da6a3ce929d0e0e4736"],
				}),
				window,
			),
	},

	// ----- activity: the only deliberately cross-org builders in the product.
	// ----- Fixtured so the catalog's tenant-scope test actually exercises the
	// ----- cross-org branch, rather than asserting a rule nothing exemplifies.
	{
		module: "activity",
		name: "activeOrgsByErrorEventsQuery",
		label: "default",
		compile: () => CH.compile(CH.activeOrgsByErrorEventsQuery(), { startTime: START_TIME }),
	},
	{
		module: "activity",
		name: "activeOrgsByTracesQuery",
		label: "default",
		compile: () => CH.compile(CH.activeOrgsByTracesQuery(), { startTime: START_TIME }),
	},
	{
		module: "activity",
		name: "activeOrgsByLogsQuery",
		label: "default",
		compile: () => CH.compile(CH.activeOrgsByLogsQuery(), { startTime: START_TIME }),
	},
]
