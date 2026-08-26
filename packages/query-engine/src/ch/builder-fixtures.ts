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

import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import * as CH from "./index"
import { Effect } from "effect"
import type { QueryBuilderError } from "@maple-dev/clickhouse-builder"

/**
 * Run a compile that is now Effect-returning, throwing on failure.
 *
 * The catalog wants a throw: a fixture that will not compile must fail its test
 * loudly rather than becoming an entry the sweep silently skips. Compilation is
 * synchronous and effect-free, so `runSync` is exact here.
 */
const runCompile = <A>(compiled: Effect.Effect<A, QueryBuilderError>): A => Effect.runSync(compiled)

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

// Web analytics fixtures used by the v1 route registry.
//
// Two fixtures per page-view builder: unfiltered, and with a
// session_replays-only filter set. The second is the one that matters — it
// forces the `SessionId IN (SELECT …)` semi-join branch, which is a whole
// second SQL shape that no unfiltered fixture reaches.
//
// Every one is emitted TWICE, once per page-view source. `useProductEvents` is a
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
	eventName: "signup_started",
} as const

const webAnalyticsVariants = (
	name: string,
	label: string,
	compile: (useProductEvents: boolean) => CompiledQuery<unknown>,
): ReadonlyArray<BuilderFixture> => [
	{ module: "web-analytics", name, label, compile: () => compile(false) },
	{ module: "web-analytics", name, label: `${label}-rollup`, compile: () => compile(true) },
]

const webAnalyticsFixtures: ReadonlyArray<BuilderFixture> = [
	...webAnalyticsVariants("webAnalyticsSummaryQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsSummaryQuery({ useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsSummaryQuery", "filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsSummaryQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useProductEvents }),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsLiveQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsLiveQuery({ useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsLiveQuery", "filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsLiveQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useProductEvents }),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsTimeseriesQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsTimeseriesQuery({ bucketSeconds: 3600, useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsPageviewsTimeseriesQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsPageviewsTimeseriesQuery({ bucketSeconds: 3600, useProductEvents }),
			window,
		),
	),
	// Forces the semi-join: `referrerHost` is a session_replays-only dimension,
	// so the page-view source has to narrow through a subquery to honour it.
	...webAnalyticsVariants("webAnalyticsPageviewsTimeseriesQuery", "semi-joined", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsPageviewsTimeseriesQuery({
				bucketSeconds: 3600,
				referrerHost: "t.co",
				visitorType: "returning",
				useProductEvents,
			}),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsPagesQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsPagesQuery({ limit: 100, useProductEvents }), window),
	),
	// host/pagePath filter directly off the page-view source — deliberately NOT
	// through the semi-join, so the 82% of sessions with no analytics block still count.
	...webAnalyticsVariants("webAnalyticsPagesQuery", "url-filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsPagesQuery({ limit: 100, host: "maple.dev", useProductEvents }),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsPagesQuery", "semi-joined", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsPagesQuery({ limit: 100, country: "DE", useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsEventsQuery", "default", (useProductEvents) =>
		CH.compileUnsafe(CH.webAnalyticsEventsQuery({ limit: 100, useProductEvents }), window),
	),
	...webAnalyticsVariants("webAnalyticsEventsQuery", "url-filtered", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsEventsQuery({ limit: 100, host: "maple.dev", useProductEvents }),
			window,
		),
	),
	// `eventName` alongside a replays dimension: the replays semi-join must appear
	// and the event's own filter must NOT — this is the breakdown it is picked from.
	...webAnalyticsVariants("webAnalyticsEventsQuery", "semi-joined", (useProductEvents) =>
		CH.compileUnsafe(
			CH.webAnalyticsEventsQuery({
				limit: 100,
				country: "DE",
				eventName: "signup_started",
				useProductEvents,
			}),
			window,
		),
	),
	...webAnalyticsVariants("webAnalyticsBreakdownsQuery", "default", (useProductEvents) =>
		CH.compileUnionUnsafe(CH.webAnalyticsBreakdownsQuery({ useProductEvents }), window),
	),
	// Every dimension selected at once: each branch must exclude its own filter,
	// so this is the fixture that would catch a branch that forgot to. On the
	// rollup variant it is also the one that shows the navigation semi-join being
	// inlined into all twelve branches — the shape the rollup exists to make cheap.
	...webAnalyticsVariants("webAnalyticsBreakdownsQuery", "all-dimensions-filtered", (useProductEvents) =>
		CH.compileUnionUnsafe(
			CH.webAnalyticsBreakdownsQuery({ ...WEB_ANALYTICS_ALL_FILTERS, useProductEvents }),
			window,
		),
	),
]

// Product-event funnel fixtures. The funnel SQL has four independent axes —
// person-key resolution (with or without the identity_links join), a session
// step 1 (UNION ALL of a session_replays branch), the population filter
// semi-join, and a breakdown dimension (event column vs session_replays join) —
// and each is a distinct SQL shape the analyzer has to see.
const FUNNEL_STEPS: ReadonlyArray<CH.FunnelStep> = [
	{ kind: "page", pagePath: "/pricing", host: "maple.dev" },
	{ kind: "event", eventName: "signup_completed" },
	{ kind: "event", eventName: "plan_started", attributeEquals: { plan: "startup" } },
]
const REFERRAL_STEPS: ReadonlyArray<CH.FunnelStep> = [
	{ kind: "session", dimension: "referrerHost", value: "news.ycombinator.com" },
	...FUNNEL_STEPS,
]

const productEventsFixtures: ReadonlyArray<BuilderFixture> = [
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "person",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsFunnelQuery({
					steps: FUNNEL_STEPS,
					keyBy: "person",
					windowSeconds: 7 * 86_400,
				}),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "session-step-filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsFunnelQuery({
					steps: REFERRAL_STEPS,
					keyBy: "person",
					windowSeconds: 7 * 86_400,
					filters: WEB_ANALYTICS_ALL_FILTERS,
				}),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "visitor-session-step",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsFunnelQuery({
					steps: REFERRAL_STEPS,
					keyBy: "visitor",
					windowSeconds: 3_600,
				}),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelQuery",
		label: "session-key",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsFunnelQuery({ steps: FUNNEL_STEPS, keyBy: "session", windowSeconds: 1_800 }),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelBreakdownQuery",
		label: "session-dimension",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsFunnelBreakdownQuery({
					steps: FUNNEL_STEPS,
					keyBy: "person",
					windowSeconds: 7 * 86_400,
					breakdownBy: "utmSource",
					limit: 10,
				}),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventsFunnelBreakdownQuery",
		label: "attribute-session-step",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventsFunnelBreakdownQuery({
					steps: REFERRAL_STEPS,
					keyBy: "user",
					windowSeconds: 7 * 86_400,
					breakdownBy: "attribute:plan",
					limit: 5,
				}),
				window,
			),
	},
	{
		module: "product-events",
		name: "productEventNamesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.productEventNamesQuery({ limit: 100 }), window),
	},
	{
		module: "product-events",
		name: "productEventNamesQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.productEventNamesQuery({ filters: WEB_ANALYTICS_ALL_FILTERS, limit: 100 }),
				window,
			),
	},
]

export const builderFixtures: ReadonlyArray<BuilderFixture> = [
	...productEventsFixtures,
	// Session replay fixtures used by the replay routes.
	{
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.sessionReplaysListQuery({}), window),
	},
	{
		// Filters force the session_events semi-join + activity join branches.
		module: "session-replays",
		name: "sessionReplaysListQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
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
		compile: () => CH.compileUnionUnsafe(CH.sessionReplaysFacetsQuery({}), window),
	},
	{
		// Covers the identity predicates, which are excluded from their own branch
		// (group) or narrow every branch (userSearch).
		module: "session-replays",
		name: "sessionReplaysFacetsQuery",
		label: "identity-filtered",
		compile: () =>
			CH.compileUnionUnsafe(
				CH.sessionReplaysFacetsQuery({ userSearch: "ada", groupName: "Acme Inc" }),
				window,
			),
	},
	{
		module: "session-replays",
		name: "getSessionReplayQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.getSessionReplayQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-replays",
		name: "sessionReplayChunkIndexQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionReplayChunkIndexQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-replays",
		name: "sessionReplayEventsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionReplayEventsQuery({ startTime: START_TIME, endTime: END_TIME }), {
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
			CH.compileUnsafe(
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
		compile: () => CH.compileUnsafe(CH.sessionsForTraceQuery({ traceId: TRACE_ID }), window),
	},
	{
		module: "session-replays",
		name: "sessionTraceSummariesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
				CH.sessionTraceSummariesQuery({
					traceIds: [TRACE_ID],
					startTime: START_TIME,
					endTime: END_TIME,
				}),
				{ orgId: ORG_ID },
			),
	},

	// Session event fixtures used by the replay routes.
	{
		module: "session-events",
		name: "sessionTranscriptQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionTranscriptQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},
	{
		module: "session-events",
		name: "sessionActivityQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.sessionActivityQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
	},

	...webAnalyticsFixtures,

	// Error fixtures reached through ErrorsService, v2 telemetry, and observability.
	{
		// telemetry.http.ts v2GetSpan / observability/span-detail.ts
		module: "errors",
		name: "spanDetailQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID }), { orgId: ORG_ID }),
	},
	{
		module: "errors",
		name: "spanDetailQuery",
		label: "narrowByTime",
		compile: () =>
			CH.compileUnsafe(
				CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID, narrowByTime: true }),
				window,
			),
	},
	{
		// ErrorsService errorIssuesScan (the scheduled sweep)
		module: "errors",
		name: "errorIssuesQuery",
		label: "scan",
		compile: () => CH.compileUnsafe(CH.errorIssuesQuery({ limit: 500 }), window),
	},
	{
		// ErrorsService steady-state cursor window over the compact minute rollup.
		module: "errors",
		name: "errorTickIssuesQuery",
		label: "cursor-window",
		compile: () => CH.compileUnsafe(CH.errorTickIssuesQuery(), window),
	},
	{
		// ErrorsService one-time cursor bootstrap from retained canonical events.
		module: "errors",
		name: "errorTickBootstrapIssuesQuery",
		label: "bootstrap-window",
		compile: () => CH.compileUnsafe(CH.errorTickBootstrapIssuesQuery(), window),
	},
	{
		// ErrorsService errorIssueEnvFingerprints
		module: "errors",
		name: "errorFingerprintsQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
				CH.errorFingerprintsQuery({ services: ["api"], deploymentEnvs: ["production"] }),
				window,
			),
	},
	{
		module: "errors",
		name: "errorIssueTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueTimeseriesQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
				bucketSeconds: 300,
			}),
	},
	{
		module: "errors",
		name: "errorsSparkQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorsSparkQuery({ fingerprintHashes: [FINGERPRINT] }), {
				...window,
				bucketSeconds: 300,
			}),
	},
	{
		module: "errors",
		name: "errorIssueSampleTracesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueSampleTracesQuery({ limit: 5 }), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
	},
	{
		module: "errors",
		name: "errorIssueEnvironmentsQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueEnvironmentsQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
	},
	{
		// FixVerificationTickService — the post-merge occurrence split that decides
		// whether a merged fix actually stopped the error.
		module: "errors",
		name: "errorIssueVersionsSinceQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.errorIssueVersionsSinceQuery(), {
				...window,
				fingerprintHash: FINGERPRINT,
			}),
	},

	// Batch ④ — the modules the query-engine refactor touches. These exist so a
	// refactor that claims "no SQL changed" is actually checkable: without a
	// fixture, a builder contributes nothing to `__sql_baseline__/catalog.sql`
	// and its SQL can drift silently.

	// Service-operation splice across raw, minutely, and hourly sources.
	{
		// routes/v2/services.http.ts — service detail "Operations" tab.
		module: "service-operations",
		name: "serviceOperationsSummaryQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceOperationsSummaryQuery({ serviceName: "api", limit: 50 }), window),
	},
	{
		// Env filter exercises the extra predicate on every tier of the splice.
		module: "service-operations",
		name: "serviceOperationsSummaryQuery",
		label: "envFiltered",
		compile: () =>
			CH.compileUnsafe(
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
			CH.compileUnsafe(
				CH.serviceOperationsTimeseriesQuery({
					serviceName: "api",
					spanNames: ["GET /v2/services", "POST /v2/alerts"],
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},

	// Service-catalog hourly-rollup splice.
	{
		// routes/v2/services.http.ts — the services list.
		module: "services",
		name: "serviceCatalogQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.serviceCatalogQuery({ limit: 50 }), window),
	},
	{
		module: "services",
		name: "serviceCatalogQuery",
		label: "filtered",
		compile: () =>
			CH.compileUnsafe(
				CH.serviceCatalogQuery({
					serviceName: "api",
					deploymentEnvironment: "production",
					serviceNamespace: "backend",
					limit: 50,
				}),
				window,
			),
	},

	// Infra gauge timeseries and facet unions.
	{
		module: "infra",
		name: "hostGaugeTimeseriesQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(
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
			CH.compileUnsafe(
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
			CH.compileUnsafe(
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
			CH.compileUnsafe(
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
			CH.compileUnsafe(
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
			CH.compileUnsafe(
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
		compile: () => CH.compileUnionUnsafe(CH.podFacetsQuery(), window),
	},
	{
		module: "infra",
		name: "nodeFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.nodeFacetsQuery(), window),
	},
	{
		module: "infra",
		name: "workloadFacetsQuery",
		label: "default",
		compile: () => CH.compileUnionUnsafe(CH.workloadFacetsQuery({ kind: "deployment" }), window),
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
			CH.compileUnsafe(
				CH.serviceMapEdgeJoinQuery({
					rangeStart: CH.toDateTime(CH.param.dateTimeString("hourStart")),
					rangeEnd: CH.toDateTime(CH.param.dateTimeString("hourEnd")),
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
			CH.compileUnsafe(
				CH.serviceMapEdgeJoinQuery({
					rangeStart: CH.toDateTime(CH.param.dateTimeString("hourStart")),
					rangeEnd: CH.toDateTime(CH.param.dateTimeString("hourEnd")),
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
			runCompile(
				CH.serviceMapEdgesRollupSQL({ orgId: ORG_ID, hourStart: START_TIME, hourEnd: END_TIME }),
			),
	},
	{
		module: "service-map-rollup",
		name: "serviceMapEdgesExistingHoursSQL",
		label: "default",
		compile: () => runCompile(CH.serviceMapEdgesExistingHoursSQL(window)),
	},
	{
		module: "service-map-rollup",
		name: "serviceMapResolutionsExistingHoursSQL",
		label: "default",
		compile: () => runCompile(CH.serviceMapResolutionsExistingHoursSQL(window)),
	},
	{
		// Org-wide: hourly MV branch UNION ALL two partial-hour live joins.
		module: "service-map",
		name: "serviceDependenciesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceDependenciesSQL({}, window)),
	},
	{
		module: "service-map",
		name: "serviceDependenciesSQL",
		label: "env-scoped",
		compile: () => runCompile(CH.serviceDependenciesSQL({ deploymentEnv: "production" }, window)),
	},
	{
		module: "service-map",
		name: "serviceDependenciesForServiceQuery",
		label: "default",
		compile: () =>
			CH.compileUnsafe(CH.serviceDependenciesForServiceQuery({ serviceName: "web" }), window),
	},
	{
		// Hourly MV UNION ALL raw traces, minus the internal-resolution anti-join.
		module: "service-map",
		name: "serviceExternalEdgesSQL",
		label: "default",
		compile: () => runCompile(CH.serviceExternalEdgesSQL({ serviceName: "web" }, window)),
		// TargetType is a String column, but both branches of the UNION emit only
		// http/messaging/rpc, and the row schema holds that line.
		sampleValues: { targetType: "http" },
	},
	{
		module: "service-map",
		name: "serviceExternalEdgesSQL",
		label: "env-scoped",
		compile: () =>
			runCompile(
				CH.serviceExternalEdgesSQL({ serviceName: "web", deploymentEnv: "production" }, window),
			),
		sampleValues: { targetType: "http" },
	},

	// Trace-list enrichment fixtures.
	{
		module: "traces",
		name: "traceServicesByTraceIdsQuery",
		label: "page-enrichment",
		compile: () =>
			CH.compileUnsafe(
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
		compile: () => CH.compileUnsafe(CH.activeOrgsByErrorEventsQuery(), { startTime: START_TIME }),
	},
	{
		module: "activity",
		name: "activeOrgsByTracesQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.activeOrgsByTracesQuery(), { startTime: START_TIME }),
	},
	{
		module: "activity",
		name: "activeOrgsByLogsQuery",
		label: "default",
		compile: () => CH.compileUnsafe(CH.activeOrgsByLogsQuery(), { startTime: START_TIME }),
	},
]
