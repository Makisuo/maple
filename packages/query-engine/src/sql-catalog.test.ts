import { describe, expect, it } from "vitest"
import { warehouseQueries } from "@maple/domain"
import {
	collectBuilderCatalog,
	collectPipeCatalog,
	collectQuerySpecCatalog,
	collectSqlCatalog,
	dedupeByFingerprint,
	pipeFixtures,
	pipePathReachesAnnualRoute,
	routeCoverage,
	uncoveredPipes,
} from "./sql-catalog"
import { builderFixtures } from "./ch/builder-fixtures"
import * as activityQueries from "./ch/queries/activity"
import * as alertCheckQueries from "./ch/queries/alert-checks"
import * as anomalyQueries from "./ch/queries/anomaly"
import * as attributeKeyQueries from "./ch/queries/attribute-keys"
import * as errorQueries from "./ch/queries/errors"
import * as infraQueries from "./ch/queries/infra"
import * as livenessQueries from "./ch/queries/liveness"
import * as logQueries from "./ch/queries/logs"
import * as metricQueries from "./ch/queries/metrics"
import * as serviceInfraQueries from "./ch/queries/service-infra"
import * as serviceMapRollupQueries from "./ch/queries/service-map-rollup"
import * as serviceMapQueries from "./ch/queries/service-map"
import * as serviceOperationQueries from "./ch/queries/service-operations"
import * as serviceQueries from "./ch/queries/services"
import * as sessionEventQueries from "./ch/queries/session-events"
import * as sessionReplayQueries from "./ch/queries/session-replays"
import * as topOperationQueries from "./ch/queries/top-operations"
import * as traceQueries from "./ch/queries/traces"

// These run on every PR with no ClickHouse. They guarantee the catalog the
// DESCRIBE sweep consumes is complete and actually compiles; the sweep itself
// (apps/api, needs a server) is what validates the SQL against the analyzer.
describe("sql catalog", () => {
	const pipeEntries = collectPipeCatalog()
	const specEntries = collectQuerySpecCatalog()
	const entries = collectSqlCatalog()

	it("compiles every fixture", () => {
		expect(pipeEntries.length).toBeGreaterThan(0)
		expect(specEntries.length).toBeGreaterThan(0)
		for (const entry of entries) {
			expect(entry.sql, entry.id).toBeTruthy()
			expect(entry.sql.toUpperCase(), entry.id).toContain("SELECT")
		}
	})

	// The wire contract is additive, so a new pipe is a new SQL shape nobody has
	// executed until a fixture exists for it.
	it("covers every name in warehouseQueries", () => {
		expect(uncoveredPipes(pipeEntries)).toEqual([])
	})

	// Builders that read across every tenant on purpose. Each must declare
	// `.crossOrg()` and run through `WarehouseQueryService.crossOrgQuery`, which
	// records a justification on the span. This list should stay tiny — it is the
	// complete inventory of cross-tenant reads in the product.
	const CROSS_ORG_BUILDERS: ReadonlySet<string> = new Set([
		"activeOrgsByErrorEventsQuery",
		"activeOrgsByTracesQuery",
		"activeOrgsByLogsQuery",
	])

	// The predecessor of this test asserted `entry.sql.toContain("OrgId")`, which
	// `SELECT count() AS OrgId ...` and `WHERE OrgId = 'x' OR 1=1` both satisfy.
	// Scope is now derived by the compiler from a top-level OrgId predicate, so
	// this asserts the derived fact rather than the presence of a substring.
	it("scopes every query to an org", () => {
		for (const entry of entries) {
			if (entry.compiled === undefined) continue
			const expected = CROSS_ORG_BUILDERS.has(entry.name) ? "cross-org" : "org"
			expect(entry.compiled.tenantScope, `${entry.id} tenant scope`).toBe(expected)
		}
	})

	// Two labelled fixtures of one pipe that produce identical SQL under the same
	// capabilities are testing the same shape twice — usually a param name typo,
	// so the variant silently never applied. (Across capability variants a
	// collapse is legitimate: a fixture with no attribute filter is unaffected by
	// index capabilities, and `dedupeByFingerprint` stops the sweep paying twice.)
	it("gives each labelled fixture of a pipe a distinct SQL shape", () => {
		const shapes = new Map<string, Set<string>>()
		const labels = new Map<string, Set<string>>()
		for (const entry of pipeEntries) {
			const key = `${entry.name}@${entry.capabilityLabel}`
			if (!shapes.has(key)) shapes.set(key, new Set())
			if (!labels.has(key)) labels.set(key, new Set())
			shapes.get(key)!.add(entry.fingerprint)
			labels.get(key)!.add(entry.label)
		}
		for (const [key, fingerprints] of shapes) {
			expect(fingerprints.size, `${key} fixtures collapse to the same SQL`).toBe(labels.get(key)!.size)
		}
	})

	// The bug this harness exists for lived behind a routing predicate that no
	// test ever made true. One-sided coverage is the failure mode.
	it("exercises every routing predicate both ways", () => {
		const coverage = routeCoverage()
		expect(coverage.size).toBeGreaterThan(0)
		for (const [name, sides] of coverage) {
			expect(sides.true, `no fixture makes ${name} true`).toBeGreaterThan(0)
			expect(sides.false, `no fixture makes ${name} false`).toBeGreaterThan(0)
		}
	})

	it("routes the annual QuerySpec fixtures to the rollup union", () => {
		const annual = specEntries.filter((entry) => entry.route === "traces_timeseries:annual")
		expect(annual.length).toBeGreaterThan(0)
		for (const entry of annual) {
			expect(entry.sql, entry.id).toContain("service_overview_hourly")
			expect(entry.sql, entry.id).toContain("UNION ALL")
		}
	})

	// Documents a real asymmetry between the two entry surfaces. If someone makes
	// the pipe adapter forward bucketSeconds, this fails and the annual fixtures
	// above need a pipe twin.
	it("keeps the annual route unreachable from the pipe adapter", () => {
		expect(pipePathReachesAnnualRoute()).toBe(false)
	})

	it("dedupes to fewer shapes than fixtures", () => {
		const unique = dedupeByFingerprint(entries)
		expect(unique.length).toBeGreaterThan(warehouseQueries.length - 1)
		expect(unique.length).toBeLessThanOrEqual(entries.length)
	})

	it("declares fixtures only for known pipes", () => {
		const known = new Set<string>(warehouseQueries)
		for (const fixture of pipeFixtures) {
			expect(known.has(fixture.pipe), `unknown pipe ${fixture.pipe}`).toBe(true)
		}
	})
})

// ---------------------------------------------------------------------------
// Builder coverage — the third entry surface.
//
// Every `*Query`/`*SQL` export under ch/queries must be either fixtured in
// ch/builder-fixtures.ts or explicitly exempted below. Adding a builder
// without either fails here — the same playbook as `uncoveredPipes`, extended
// to the ~125 builders reached only through direct compiledQuery call sites.
// ---------------------------------------------------------------------------

const QUERY_MODULES: Record<string, Record<string, unknown>> = {
	activity: activityQueries,
	"alert-checks": alertCheckQueries,
	anomaly: anomalyQueries,
	"attribute-keys": attributeKeyQueries,
	errors: errorQueries,
	infra: infraQueries,
	liveness: livenessQueries,
	logs: logQueries,
	metrics: metricQueries,
	"service-infra": serviceInfraQueries,
	"service-map-rollup": serviceMapRollupQueries,
	"service-map": serviceMapQueries,
	"service-operations": serviceOperationQueries,
	services: serviceQueries,
	"session-events": sessionEventQueries,
	"session-replays": sessionReplayQueries,
	"top-operations": topOperationQueries,
	traces: traceQueries,
}

/**
 * Builders not (yet) in the fixture set. THREE reasons only, and each group
 * says which: `pipe` = reached through the pipe registry / QuerySpec lowering,
 * so those fixtures already sweep it; `helper` = composed into another
 * fixtured builder, never compiled standalone; `todo` = a follow-up batch —
 * SHRINK this list, never grow it.
 */
const EXEMPT_BUILDERS: ReadonlySet<string> = new Set([
	// pipe: swept via pipeFixtures / querySpecFixtures (pipe-dispatch.ts, runtime lowering)
	"attribute-keys/attributeKeysQuery",
	"attribute-keys/spanAttributeValuesQuery",
	"attribute-keys/resourceAttributeValuesQuery",
	"attribute-keys/logAttributeValuesQuery",
	"attribute-keys/metricScopedAttributeKeysQuery",
	"attribute-keys/metricScopedAttributeValuesQuery",
	"attribute-keys/metricAttributeValuesQuery",
	"errors/errorsByTypeQuery",
	"errors/errorsTimeseriesQuery",
	"errors/spanHierarchyQuery",
	"errors/tracesDurationStatsQuery",
	"errors/tracesFacetsQuery",
	"errors/errorsFacetsQuery",
	"errors/errorsSummaryQuery",
	"errors/errorDetailTracesQuery",
	"logs/logsTimeseriesQuery",
	"logs/logsBreakdownQuery",
	"logs/logsCountQuery",
	"logs/logsListQuery",
	"logs/errorRateByServiceQuery",
	"logs/logsFacetsQuery",
	"metrics/metricsTimeseriesQuery",
	"metrics/metricsTimeseriesRateQuery",
	"metrics/metricsSparklinesQuery",
	"metrics/metricsBreakdownQuery",
	"metrics/listMetricsQuery",
	"metrics/metricsSummaryQuery",
	"services/serviceOverviewQuery",
	"services/serviceReleasesTimelineQuery",
	"services/serviceApdexTimeseriesQuery",
	"services/serviceUsageQuery",
	"services/servicesFacetsQuery",
	"top-operations/topOperationsQuery",
	"traces/tracesTimeseriesQuery",
	"traces/tracesBreakdownQuery",
	"traces/tracesListQuery",
	"traces/slowTracesQuery",
	"traces/spanSearchQuery",
	"traces/tracesRootListQuery",

	// helper: composed into sessionReplaysListQuery, never compiled standalone
	"session-events/sessionEventMatchQuery",
	"session-events/sessionActivityAggregateQuery",

	// todo (dead export — removal tracked separately; zero consumers)
	"errors/traceTimeProbeQuery",

	// todo batch ② — alerting correctness (anomaly, alert-checks, setup-audit, activity, liveness, internal)
	"alert-checks/listRuleChecksQuery",
	"alert-checks/alertCheckGroupTotalsQuery",
	"alert-checks/alertChecksSummaryQuery",
	"anomaly/anomalyTraceSignalsQuery",
	"anomaly/anomalyLogVolumeQuery",
	"anomaly/anomalyErrorSpikeCurrentQuery",
	"anomaly/anomalyErrorSpikeBaselineQuery",
	"anomaly/anomalyTraceSignalTimeseriesQuery",
	"anomaly/anomalyLogVolumeTimeseriesQuery",
	"anomaly/anomalyErrorSpikeTimeseriesQuery",
	"anomaly/anomalyErrorSpikeServiceTimeseriesQuery",
	"liveness/serviceLivenessQuery",
	"liveness/orgTelemetryPulseQuery",

	// todo batch ③ — infra + integrations (infra, cloudflare-*, planetscale-*, service-map, rollups)
	"infra/listHostsQuery",
	"infra/hostDetailSummaryQuery",
	"infra/fleetUtilizationTimeseriesQuery",
	"infra/hostNetworkTimeseriesQuery",
	"infra/listPodsQuery",
	"infra/listPodsSummaryQuery",
	"infra/podDetailSummaryQuery",
	"infra/listNodesQuery",
	"infra/nodeDetailSummaryQuery",
	"infra/listWorkloadsQuery",
	"infra/workloadDetailSummaryQuery",
	"service-infra/serviceWorkloadsSQL",
	"service-map-rollup/serviceMapResolutionsRollupSQL",
	"service-map/serviceDbEdgesSQL",
	"service-map/serviceDbEdgesForServiceQuery",
	"service-map/serviceDbQuerySummarySQL",
	"service-map/serviceDbQueryTimeseriesSQL",
	"service-map/serviceDbTopQueriesSQL",
	"service-map/servicePlatformsSQL",

	// todo batch ④ — remainder (billing, service detail, operations, stray trace/log lookups)
	"logs/getLogByKeyQuery",
	"service-operations/serviceOperationsSummaryRawQuery",
	"service-operations/serviceOperationsTimeseriesRawQuery",
	"services/serviceHealthSnapshotQuery",
	"services/serviceHealthBaselineQuery",
	"services/serviceEnvironmentsQuery",
	"services/serviceUsageWithPreviousQuery",
	"traces/traceSummariesQuery",
	"traces/traceListQuery",
])

describe("builder coverage", () => {
	const fixtured = new Set(builderFixtures.map((fixture) => `${fixture.module}/${fixture.name}`))

	it("compiles every builder fixture into the catalog", () => {
		const entries = collectBuilderCatalog()
		expect(entries.length).toBe(builderFixtures.length)
		for (const entry of entries) {
			expect(entry.sql, entry.id).toContain("OrgId")
		}
	})

	it("declares fixtures whose module/name actually exists", () => {
		for (const fixture of builderFixtures) {
			const module = QUERY_MODULES[fixture.module]
			expect(module, `unknown module ${fixture.module}`).toBeDefined()
			expect(typeof module?.[fixture.name], `${fixture.module} does not export ${fixture.name}`).toBe(
				"function",
			)
		}
	})

	it("covers or exempts every exported builder", () => {
		const missing: Array<string> = []
		for (const [moduleName, module] of Object.entries(QUERY_MODULES)) {
			for (const [exportName, value] of Object.entries(module)) {
				if (typeof value !== "function") continue
				if (!/(Query|SQL)$/.test(exportName)) continue
				const key = `${moduleName}/${exportName}`
				if (!fixtured.has(key) && !EXEMPT_BUILDERS.has(key)) missing.push(key)
			}
		}
		expect(missing, `builders with no fixture and no exemption:\n${missing.join("\n")}`).toEqual([])
	})

	it("keeps the exemption list free of stale entries", () => {
		for (const key of EXEMPT_BUILDERS) {
			const [moduleName, exportName] = key.split("/") as [string, string]
			expect(
				typeof QUERY_MODULES[moduleName]?.[exportName],
				`${key} is exempt but no longer exported`,
			).toBe("function")
			expect(fixtured.has(key), `${key} is exempt AND fixtured — drop the exemption`).toBe(false)
		}
	})
})
