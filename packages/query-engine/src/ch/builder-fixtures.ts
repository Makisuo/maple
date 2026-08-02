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
}

const ORG_ID = "org_sql_catalog"
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"
const SESSION_ID = "sess_0af7651916cd43dd"
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const FINGERPRINT = "11640393269246331608"

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

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
		name: "sessionReplayEventsQuery",
		label: "default",
		compile: () =>
			CH.compile(CH.sessionReplayEventsQuery({ startTime: START_TIME, endTime: END_TIME }), {
				orgId: ORG_ID,
				sessionId: SESSION_ID,
			}),
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
			CH.compile(CH.spanDetailQuery({ traceId: TRACE_ID, spanId: SPAN_ID, narrowByTime: true }), window),
	},
	{
		// ErrorsService errorIssuesScan (the scheduled sweep)
		module: "errors",
		name: "errorIssuesQuery",
		label: "scan",
		compile: () => CH.compile(CH.errorIssuesQuery({ limit: 500 }), window),
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
]
