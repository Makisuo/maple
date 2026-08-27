// SQL catalog for the integration query builders.
//
// The core package's catalog cannot cover these: `@maple/query-engine` must not
// import this package (the dependency runs one way), so the fixtures live with
// the builders instead. Same contract as the core catalog — compile the REAL
// exported builder with production-shaped params, so every SQL shape the
// product can emit is enumerated and snapshotted. The ClickHouse e2e sweep in
// apps/api (`sql-catalog.clickhouse.e2e.test.ts`) analyzes these fixtures
// against the real migrations alongside the core catalog.

import { Effect } from "effect"
import { compileUnionUnsafe, compileUnsafe, type CompiledQuery } from "@maple/query-engine/ch"
import * as CH from "./index"

export interface IntegrationFixture {
	/** Source module basename, e.g. `"cloudflare-infra"`. */
	readonly module: string
	/** The exported builder this covers — must match the export name. */
	readonly name: string
	/** Distinguishes fixtures for one builder; appears in failure output. */
	readonly label: string
	readonly compile: () => CompiledQuery<unknown>
}

const ORG_ID = "org_sql_catalog"
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

/** The window plus the bucket every timeseries builder resolves a param from. */
const bucketed = { ...window, bucketSeconds: 300 }

/** A `trace:` session's trace id, in the 32-hex shape the route validates. */
const AI_TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"

/** One zone's spans, as the /infra/cloudflare pages scope them. */
const cfZone = { ...window, serviceName: "cloudflare-zone-example-com" }
const cfZoneBucketed = { ...cfZone, bucketSeconds: 300 }

/** The current-vs-previous split the usage stats card compares over. */
const cfUsageCompare = { ...window, currentStartTime: "2026-01-02 10:30:00", prevStartTime: START_TIME }

/** One PlanetScale branch, as the /infra/planetscale pages scope them. */
const psBranch = { ...window, database: "maple-prd", branch: "main" }
const psBranchBucketed = { ...psBranch, bucketSeconds: 300 }

/** The zone-slice filters the /infra/cloudflare page sends, as one bag. */
const CF_FILTERS = { hosts: ["example.com"], statusClasses: ["5xx"], methods: ["GET"] }

/** The half-open child window plus the earlier parent scan the audit joins take. */
const traceWindow = {
	orgId: ORG_ID,
	childStart: START_TIME,
	childEnd: END_TIME,
	parentStart: "2026-01-01 08:30:00",
}

export const integrationFixtures: ReadonlyArray<IntegrationFixture> = [
	{
		module: "ai-sessions",
		name: "aiSessionListQuery",
		label: "default",
		// The ClickHouse e2e sweep runs its quoted/unquoted 64-bit decode assertion
		// for every fixture whose compiled query carries a row schema — which the
		// builder derives from the SELECT, so nothing is declared here.
		compile: () => compileUnsafe(CH.aiSessionListQuery(), window),
	},
	{
		// The vendor/service filters the AI sessions list page sends.
		module: "ai-sessions",
		name: "aiSessionListQuery",
		label: "filtered",
		compile: () =>
			compileUnsafe(
				CH.aiSessionListQuery({
					limit: 25,
					vendorIds: ["eve"],
					serviceNames: ["maple-slack-agent"],
				}),
				window,
			),
	},
	{
		module: "ai-sessions",
		name: "aiSessionFacetsQuery",
		label: "default",
		compile: () => compileUnionUnsafe(CH.aiSessionFacetsQuery(), window),
	},
	{
		module: "ai-sessions",
		name: "aiSessionSpansQuery",
		label: "default",
		compile: () =>
			compileUnsafe(
				CH.aiSessionSpansQuery(),
				{ ...window, sessionId: "wrun_sql_catalog" },
				{ rowSchema: CH.aiSessionSpansRowSchema },
			),
	},
	{
		// A session detail page opened from a link that carries no time hints
		// resolves its bounds with this first. The baseline is what proves the
		// only read in the file with no `Timestamp` predicate is this one — the
		// bloom-indexed detection scan, never the fan-out.
		module: "ai-sessions",
		name: "aiSessionWindowQuery",
		label: "default",
		compile: () =>
			compileUnsafe(CH.aiSessionWindowQuery(), { orgId: ORG_ID, sessionId: "wrun_sql_catalog" }),
	},
	{
		// The same two reads for a `trace:` session — one whose vendor exposes no
		// session key, so the id names the trace and the detection half is gone.
		module: "ai-sessions",
		name: "aiTraceWindowQuery",
		label: "default",
		compile: () => compileUnsafe(CH.aiTraceWindowQuery(), { orgId: ORG_ID, traceId: AI_TRACE_ID }),
	},
	{
		module: "ai-sessions",
		name: "aiTraceSpansQuery",
		label: "default",
		compile: () =>
			compileUnsafe(
				CH.aiTraceSpansQuery(),
				{ ...window, traceId: AI_TRACE_ID },
				{ rowSchema: CH.aiSessionSpansRowSchema },
			),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneLatencySQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneLatencySQL(), window),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneTimeseriesSQL(), { ...window, bucketSeconds: 300 }),
	},
	{
		// Filters exercise the zone-slice predicates the /infra/cloudflare page sends.
		module: "cloudflare-infra",
		name: "cloudflareZoneTimeseriesSQL",
		label: "filtered",
		compile: () =>
			compileUnsafe(
				CH.cloudflareZoneTimeseriesSQL({
					hosts: ["example.com"],
					statusClasses: ["5xx"],
					methods: ["GET"],
				}),
				{ ...window, bucketSeconds: 300 },
			),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareQueueGaugesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareQueueGaugesSQL(), window),
	},
	{
		module: "cloudflare-infra-breakdowns",
		name: "cloudflareZoneBreakdownTimeseriesSQL",
		label: "default",
		compile: () =>
			compileUnsafe(CH.cloudflareZoneBreakdownTimeseriesSQL("path", {}, ["/api/v2/traces"]), {
				...window,
				serviceName: "cloudflare-zone-example-com",
				bucketSeconds: 300,
			}),
	},
	{
		module: "cloudflare-usage",
		name: "cloudflareUsageQuery",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareUsageQuery(), { ...window, bucketSeconds: 3600 }),
	},
	{
		module: "cloudflare-map",
		name: "cloudflareServiceLatencySQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareServiceLatencySQL(), window),
	},
	{
		module: "planetscale-map",
		name: "planetscaleGaugesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleGaugesSQL(), window),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneCountersSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneCountersSQL(), cfZone),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneCountersSQL",
		label: "filtered",
		compile: () => compileUnsafe(CH.cloudflareZoneCountersSQL(CF_FILTERS), cfZone),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneStatusTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneStatusTimeseriesSQL(), cfZoneBucketed),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneStatusTimeseriesSQL",
		label: "filtered",
		compile: () => compileUnsafe(CH.cloudflareZoneStatusTimeseriesSQL(CF_FILTERS), cfZoneBucketed),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneCacheTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneCacheTimeseriesSQL(), cfZoneBucketed),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareZoneLatencyTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneLatencyTimeseriesSQL(), cfZoneBucketed),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareWorkerCountersSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareWorkerCountersSQL(), cfZone),
	},
	{
		module: "cloudflare-infra",
		name: "cloudflareWorkerLatencySQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareWorkerLatencySQL(), cfZone),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareZoneFirewallTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneFirewallTimeseriesSQL(), cfZoneBucketed),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareZoneFirewallTopSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneFirewallTopSQL(), cfZone),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareZoneDnsTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneDnsTimeseriesSQL(), cfZoneBucketed),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareZoneDnsBreakdownSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneDnsBreakdownSQL(), cfZone),
	},
	{
		module: "cloudflare-infra-extended",
		name: "cloudflareDurableObjectCountersSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareDurableObjectCountersSQL(), cfZone),
	},
	{
		module: "cloudflare-infra-breakdowns",
		name: "cloudflareZoneBreakdownTotalsSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneBreakdownTotalsSQL("path"), cfZone),
	},
	{
		module: "cloudflare-infra-breakdowns",
		name: "cloudflareZoneBreakdownCoverageSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareZoneBreakdownCoverageSQL("path"), cfZone),
	},
	{
		module: "cloudflare-infra-breakdowns",
		name: "cloudflareZoneFacetsQuery",
		label: "default",
		compile: () => compileUnionUnsafe(CH.cloudflareZoneFacetsQuery(), cfZone),
	},
	{
		module: "cloudflare-map",
		name: "cloudflareServiceCountersSQL",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareServiceCountersSQL(), cfZone),
	},
	{
		module: "cloudflare-usage",
		name: "cloudflareUsageStatsQuery",
		label: "default",
		compile: () => compileUnsafe(CH.cloudflareUsageStatsQuery(), cfUsageCompare),
	},
	{
		module: "planetscale-infra",
		name: "planetscaleInfraTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleInfraTimeseriesSQL(), psBranchBucketed),
	},
	{
		module: "planetscale-infra",
		name: "planetscaleBranchInfraTimeseriesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleBranchInfraTimeseriesSQL(), psBranchBucketed),
	},
	{
		module: "planetscale-map",
		name: "planetscaleBranchGaugesSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleBranchGaugesSQL(), psBranch),
	},
	{
		module: "planetscale-map",
		name: "planetscaleStorageSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleStorageSQL(), psBranch),
	},
	{
		module: "planetscale-map",
		name: "planetscaleBranchStorageSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleBranchStorageSQL(), psBranch),
	},
	{
		module: "planetscale-map",
		name: "planetscaleConnectionsSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleConnectionsSQL(), psBranch),
	},
	{
		module: "planetscale-map",
		name: "planetscaleBranchConnectionsSQL",
		label: "default",
		compile: () => compileUnsafe(CH.planetscaleBranchConnectionsSQL(), psBranch),
	},
	{
		module: "billing-usage",
		name: "dailySignalVolumeQuery",
		label: "default",
		compile: () => compileUnsafe(CH.dailySignalVolumeQuery(), window),
	},
	{
		module: "billing-usage",
		name: "dailySessionCountQuery",
		label: "default",
		compile: () => compileUnsafe(CH.dailySessionCountQuery(), window),
	},
	{
		module: "billing-usage",
		name: "dailyProductEventCountQuery",
		label: "default",
		compile: () => compileUnsafe(CH.dailyProductEventCountQuery(), window),
	},
	{
		module: "internal",
		name: "dbStatementSamplesQuery",
		label: "default",
		compile: () => compileUnsafe(CH.dbStatementSamplesQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditAttributeKeyInventoryQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditAttributeKeyInventoryQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditSpanProfileByServiceQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditSpanProfileByServiceQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditSamplingByServiceQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditSamplingByServiceQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditLogSeverityByServiceQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditLogSeverityByServiceQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditMetricLabelCardinalityQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditMetricLabelCardinalityQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditPeerValueInventoryQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditPeerValueInventoryQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditDbEdgeIdentityQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditDbEdgeIdentityQuery({ limit: 25 }), window),
	},
	{
		module: "setup-audit",
		name: "auditLogCorrelationQuery",
		label: "default",
		compile: () => compileUnsafe(CH.auditLogCorrelationQuery(), window),
	},
	{
		module: "setup-audit",
		name: "auditOrphanSpansSQL",
		label: "default",
		compile: () => Effect.runSync(CH.auditOrphanSpansSQL(traceWindow)),
	},
	{
		module: "setup-audit",
		name: "auditRootlessTracesSQL",
		label: "default",
		compile: () => Effect.runSync(CH.auditRootlessTracesSQL(traceWindow)),
	},
]

export interface IntegrationCatalogEntry {
	readonly id: string
	readonly sql: string
	readonly compiled: CompiledQuery<unknown>
}

/** Compile every fixture. A fixture that throws fails here, not in production. */
export function collectIntegrationCatalog(): ReadonlyArray<IntegrationCatalogEntry> {
	return integrationFixtures.map((fixture) => {
		const compiled = fixture.compile()
		// The executor dies on unresolved placeholders at runtime; a fixture
		// missing a compile param must fail HERE.
		if (compiled.sql.includes("__PARAM_")) {
			throw new Error(
				`Integration catalog: ${fixture.module}/${fixture.name} (${fixture.label}) ` +
					`left an unresolved __PARAM_ placeholder — a compile param is missing.`,
			)
		}
		return {
			id: `builder:${fixture.module}:${fixture.name}:${fixture.label}`,
			sql: compiled.sql,
			compiled,
		}
	})
}

// Anti-rot assertion — the integration half of `UNDECODED_QUERIES`

/**
 * Catalog entries whose rows nothing validates.
 *
 * `rowSchemaSource: "none"` means at least one selected expression had no type
 * to read — a `rawExpr`, a `dynamicColumn` without one, a function declared
 * with `defineUntypedFn`/`compileFnCall` — so `decodeRows` degrades to an
 * identity cast and a warehouse that changes a column's wire format is
 * invisible until the value reaches a consumer several layers away.
 *
 * Asserted *exactly*, in both directions: a query that stops deriving fails,
 * and so does one still listed here after it starts. It is empty, and that is
 * the invariant worth keeping — `aiSessionFacetsQuery` selected an untyped
 * local `uniqExact` and validated nothing for as long as this package had no
 * gate of its own, while the core catalog's identical assertion could not see
 * it (that catalog must not import this package).
 *
 * Adding an entry is how you say a query cannot derive, and it needs a sentence
 * here saying why.
 */
export const UNDECODED_INTEGRATION_QUERIES: ReadonlySet<string> = new Set([])

/** The id of every catalog entry that decodes nothing. */
export function undecodedIntegrationQueries(
	entries: ReadonlyArray<IntegrationCatalogEntry>,
): ReadonlyArray<string> {
	return entries
		.filter((entry) => entry.compiled.rowSchemaSource === "none")
		.map((entry) => entry.id)
		.sort()
}

/**
 * The same list with the columns responsible, for the assertion's failure
 * message. Derivation is all-or-nothing, so "this query decodes nothing" is
 * useless on its own — these are the aliases to give a type.
 */
export function undecodedIntegrationColumns(
	entries: ReadonlyArray<IntegrationCatalogEntry>,
): ReadonlyMap<string, ReadonlyArray<string>> {
	const columns = new Map<string, ReadonlyArray<string>>()
	for (const entry of entries) {
		if (entry.compiled.rowSchemaSource !== "none") continue
		columns.set(entry.id, entry.compiled.untypedColumns)
	}
	return columns
}

/**
 * Builders deliberately left without a fixture.
 *
 * Empty, and worth keeping that way: a builder no fixture compiles is outside
 * every gate this package has — the undecoded-row-schema assertion below, the
 * SQL baseline, and the ClickHouse e2e sweep in apps/api that analyzes these
 * fixtures against the real migrations. Thirty-seven of forty-eight builders
 * sat outside all three until 2026-08-27, which is how `aiSessionFacetsQuery`
 * came to validate nothing without anyone noticing.
 *
 * An entry needs a sentence here saying why the builder cannot be compiled with
 * production-shaped params.
 */
export const EXEMPT_INTEGRATION_BUILDERS: ReadonlySet<string> = new Set([])

/** Every exported builder — the `*Query` / `*SQL` naming convention is the
 *  contract, the same one the core catalog's coverage assertion reads. */
export function exportedIntegrationBuilders(): ReadonlyArray<string> {
	return Object.entries(CH)
		.filter(([name, value]) => typeof value === "function" && /(Query|SQL)$/.test(name))
		.map(([name]) => name)
		.sort()
}

/** Exported builders that no fixture compiles and no exemption covers. */
export function unfixturedIntegrationBuilders(): ReadonlyArray<string> {
	const fixtured = new Set(integrationFixtures.map((fixture) => fixture.name))
	return exportedIntegrationBuilders().filter(
		(name) => !fixtured.has(name) && !EXEMPT_INTEGRATION_BUILDERS.has(name),
	)
}
