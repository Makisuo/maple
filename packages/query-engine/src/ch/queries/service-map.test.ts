import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	serviceDbEdgesSQL,
	serviceDbEdgesForServiceQuery,
	serviceDbQuerySummarySQL,
	serviceDbQueryTimeseriesSQL,
	serviceDbTopQueriesSQL,
	serviceDependenciesSQL,
	serviceDependenciesForServiceQuery,
	serviceExternalEdgesSQL,
	servicePlatformsSQL,
} from "./service-map"
import { serviceMapResolutionsRollupSQL } from "./service-map-rollup"
import { DB_NAMESPACE_ATTR_SQL } from "@maple/domain/tinybird/db-query-shape-sql"

// The read side must derive `DbNamespace` byte-identically to the write side's
// `DB_NAMESPACE_ATTR_SQL` (Hyperdrive-collapsing coalesce) or the sealed-hour and
// raw-fallback branches won't merge. Assertions below reference these directly so
// a drift in either surface fails the build.
//
// Sealed rows already store the collapsed value, but pre-migration rows still hold
// the raw Hyperdrive hex, so the sealed column is re-collapsed on read too:
const SEALED_NAMESPACE_COLLAPSE =
	"if(match(DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', DbNamespace)"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

// ---------------------------------------------------------------------------
// serviceExternalEdgesSQL
// ---------------------------------------------------------------------------

describe("serviceExternalEdgesSQL", () => {
	it("scopes by org, service, and time window", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'artifacts-api'")
		expect(sql).toContain("toStartOfHour(toDateTime('2024-01-01 00:00:00'))")
		expect(sql).toContain("toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})

	it("unions hourly MV branch with raw-traces fallback for the in-progress hour", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("FROM service_external_edges_hourly")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("UNION ALL")
		// Recent branch must filter to the in-progress hour [endHour, endTime].
		expect(sql).toContain("Timestamp >= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})

	it("excludes db.system.name from the raw-traces branch (DB edges are a separate MV)", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("SpanAttributes['db.system.name'] = ''")
	})

	it("applies messaging > rpc > http precedence in the multiIf", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		// First branch of multiIf must be the messaging predicate.
		const multiIfIdx = sql.indexOf("multiIf(")
		expect(multiIfIdx).toBeGreaterThan(-1)
		const after = sql.slice(multiIfIdx, multiIfIdx + 400)
		const msgIdx = after.indexOf("'messaging'")
		const rpcIdx = after.indexOf("'rpc'")
		const httpIdx = after.indexOf("'http'")
		expect(msgIdx).toBeGreaterThan(-1)
		expect(rpcIdx).toBeGreaterThan(-1)
		expect(httpIdx).toBeGreaterThan(-1)
		expect(msgIdx).toBeLessThan(rpcIdx)
		expect(rpcIdx).toBeLessThan(httpIdx)
	})

	it("anti-joins internal-service overlap from the resolutions table for HTTP only", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("FROM service_address_resolutions_hourly")
		expect(sql).toContain("targetType = 'http'")
		expect(sql).toContain("targetName IN (")
	})

	it("threads deploymentEnv into both branches and the resolutions anti-join", () => {
		const { sql } = serviceExternalEdgesSQL(
			{ serviceName: "artifacts-api", deploymentEnv: "production" },
			baseParams,
		)
		expect(sql).toContain("DeploymentEnv = 'production'")
		expect(sql).toContain("ResourceAttributes['deployment.environment'] = 'production'")
	})

	it("groups by target identity and orders by callCount desc", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("GROUP BY sourceService, targetType, targetSystem, targetName")
		expect(sql).toContain("ORDER BY callCount DESC")
		expect(sql).toContain("LIMIT 200")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in serviceName / orgId to prevent SQL injection", () => {
		const { sql } = serviceExternalEdgesSQL(
			{ serviceName: "weird'service" },
			{ ...baseParams, orgId: "org'attack" },
		)
		expect(sql).toContain("ServiceName = 'weird\\'service'")
		expect(sql).toContain("OrgId = 'org\\'attack'")
	})

	it.effect("decodes external edge rows and validates targetType", () =>
		Effect.gen(function* () {
			const compiled = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					sourceService: "artifacts-api",
					targetType: "http",
					targetSystem: "",
					targetName: "checkout.internal",
					callCount: "11",
					errorCount: "1",
					avgDurationMs: "12.5",
					p95DurationMs: "40",
					estimatedSpanCount: "22",
				},
			])
			expect(rows).toEqual([
				{
					sourceService: "artifacts-api",
					targetType: "http",
					targetSystem: "",
					targetName: "checkout.internal",
					callCount: 11,
					errorCount: 1,
					avgDurationMs: 12.5,
					p95DurationMs: 40,
					estimatedSpanCount: 22,
				},
			])

			const invalid = yield* Effect.exit(
				compiled.decodeRows([
					{
						sourceService: "artifacts-api",
						targetType: "database",
						targetSystem: "",
						targetName: "postgres",
						callCount: 1,
						errorCount: 0,
						avgDurationMs: 1,
						p95DurationMs: 1,
						estimatedSpanCount: 1,
					},
				]),
			)
			expect(Exit.isFailure(invalid)).toBe(true)
		}),
	)
})

// ---------------------------------------------------------------------------
// serviceMapResolutionsRollupSQL — companion of the edges rollup
// ---------------------------------------------------------------------------

describe("serviceMapResolutionsRollupSQL", () => {
	const hourParams = {
		orgId: "org_1",
		hourStart: "2024-01-01 00:00:00",
		hourEnd: "2024-01-01 01:00:00",
	}

	it("joins parent Client/Producer spans to child Server/Consumer spans", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("SpanKind IN ('Client', 'Producer')")
		expect(sql).toContain("SpanKind IN ('Server', 'Consumer')")
		expect(sql).toContain("ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)")
	})

	it("projects parent server.address as the resolution key", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		// Map lookup is pushed into the parent subquery as `ServerAddress`, so the
		// outer SELECT reads a flat column instead of re-evaluating the map.
		expect(sql).toContain("SpanAttributes['server.address'] AS ServerAddress")
		expect(sql).toContain("p.ServerAddress AS ParentServerAddress")
		expect(sql).toContain("c.ServiceName AS ResolvedTargetService")
	})

	it("hour-buckets via toStartOfHour, scopes by org", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("toStartOfHour(p.Timestamp) AS Hour")
		expect(sql).toContain("OrgId = 'org_1'")
	})

	it("drops same-service edges and empty server.address", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("p.ServiceName != c.ServiceName")
		expect(sql).toContain("SpanAttributes['server.address'] != ''")
	})

	it("bounds the join to a single hour on both sides", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp < '2024-01-01 01:00:00'")
		// Both branches must enforce the hour bound — count occurrences.
		const matches = sql.match(/Timestamp >= '2024-01-01 00:00:00'/g)
		expect(matches?.length).toBe(2)
	})

	it("groups by the resolution key tuple and formats as JSON", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain(
			"GROUP BY OrgId, Hour, SourceService, ParentServerAddress, ResolvedTargetService, DeploymentEnv",
		)
		expect(sql).toContain("FORMAT JSON")
	})
})

// ---------------------------------------------------------------------------
// serviceDependenciesForServiceQuery — service-scoped service↔service edges
// ---------------------------------------------------------------------------

describe("serviceDependenciesSQL", () => {
	it.effect("decodes service dependency rows with numeric strings from ClickHouse JSON", () =>
		Effect.gen(function* () {
			const compiled = serviceDependenciesSQL({ deploymentEnv: "production" }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					sourceService: "artifacts-api",
					targetService: "checkout-api",
					callCount: "12",
					errorCount: "2",
					avgDurationMs: "8.5",
					p95DurationMs: "30",
					estimatedSpanCount: "18",
				},
			])

			expect(rows).toEqual([
				{
					sourceService: "artifacts-api",
					targetService: "checkout-api",
					callCount: 12,
					errorCount: 2,
					avgDurationMs: 8.5,
					p95DurationMs: 30,
					estimatedSpanCount: 18,
				},
			])
		}),
	)
})

describe("serviceDependenciesForServiceQuery", () => {
	it("filters SourceService on the hourly branch", () => {
		const { sql } = compileCH(
			serviceDependenciesForServiceQuery({ serviceName: "artifacts-api" }),
			baseParams,
		)
		expect(sql).toContain("FROM service_map_edges_hourly")
		expect(sql).toContain("SourceService = 'artifacts-api'")
	})

	it("pushes parent ServiceName into the live topology JOIN's left subquery", () => {
		const { sql } = compileCH(
			serviceDependenciesForServiceQuery({ serviceName: "artifacts-api" }),
			baseParams,
		)
		// The DSL emits the parent subquery against service_map_spans with a
		// `ServiceName = ?` predicate so the JOIN's left side is pre-shrunk.
		expect(sql).toContain("FROM service_map_spans")
		expect(sql).toContain("ServiceName = 'artifacts-api'")
		// Both the hourly branch and the in-progress-hour join must filter — so
		// the service name string should appear at least twice in the emitted SQL.
		const matches = sql.match(/'artifacts-api'/g)
		expect(matches && matches.length >= 2).toBe(true)
	})

	it("unions hourly MV with the in-progress-hour topology JOIN", () => {
		const { sql } = compileCH(
			serviceDependenciesForServiceQuery({ serviceName: "artifacts-api" }),
			baseParams,
		)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("FROM service_map_edges_hourly")
		expect(sql).toContain("INNER JOIN")
	})

	it("threads deploymentEnv through both branches (hourly + parent + child)", () => {
		const { sql } = compileCH(
			serviceDependenciesForServiceQuery({
				serviceName: "artifacts-api",
				deploymentEnv: "production",
			}),
			baseParams,
		)
		const matches = sql.match(/DeploymentEnv = 'production'/g)
		// hourly branch + parent subquery + child subquery in the live join.
		expect(matches && matches.length >= 3).toBe(true)
	})

	it("orders by callCount desc, limits to 200, formats as JSON", () => {
		const { sql } = compileCH(
			serviceDependenciesForServiceQuery({ serviceName: "artifacts-api" }),
			baseParams,
		)
		expect(sql).toContain("ORDER BY callCount DESC")
		expect(sql).toContain("LIMIT 200")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in serviceName to prevent SQL injection", () => {
		const { sql } = compileCH(
			serviceDependenciesForServiceQuery({ serviceName: "weird'service" }),
			baseParams,
		)
		expect(sql).toContain("ServiceName = 'weird\\'service'")
		expect(sql).toContain("SourceService = 'weird\\'service'")
	})
})

// ---------------------------------------------------------------------------
// serviceDbEdgesForServiceQuery — service-scoped service↔database edges
// ---------------------------------------------------------------------------

describe("serviceDbEdgesForServiceQuery", () => {
	it.effect("decodes org-wide database edge rows with numeric strings from ClickHouse JSON", () =>
		Effect.gen(function* () {
			const compiled = serviceDbEdgesSQL({ deploymentEnv: "production" }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					sourceService: "artifacts-api",
					dbSystem: "postgresql",
					dbNamespace: "orders",
					callCount: "42",
					errorCount: "3",
					avgDurationMs: "14.25",
					p95DurationMs: "88",
					estimatedSpanCount: "63",
				},
			])

			expect(rows).toEqual([
				{
					sourceService: "artifacts-api",
					dbSystem: "postgresql",
					dbNamespace: "orders",
					callCount: 42,
					errorCount: 3,
					avgDurationMs: 14.25,
					p95DurationMs: 88,
					estimatedSpanCount: 63,
				},
			])
		}),
	)

	it("splits database nodes by namespace on both branches, collapsing Hyperdrive (org-wide SQL)", () => {
		const { sql } = serviceDbEdgesSQL({}, baseParams)
		// hourly branch reads the rollup's stored dimension, re-collapsing pre-migration hex…
		expect(sql).toContain(`${SEALED_NAMESPACE_COLLAPSE} AS dbNamespace`)
		// …the raw branch derives the SAME identity via the shared write-side fragment
		expect(sql).toContain(`${DB_NAMESPACE_ATTR_SQL} AS dbNamespace`)
		// …and every GROUP BY carries it so distinct databases stay distinct rows
		const matches = sql.match(/GROUP BY sourceService, dbSystem, dbNamespace/g)
		expect(matches?.length).toBe(3)
	})

	it("guards the org-wide raw branch against unnamed spans (ServiceName != '')", () => {
		// Org-wide (no serviceName) still needs the empty-service guard on the raw
		// in-progress-hour branch — the hourly MV already applies it at write time.
		const { sql } = serviceDbEdgesSQL({}, baseParams)
		expect(sql).toContain("ServiceName != ''")
	})

	it("filters ServiceName on both branches (hourly MV + raw traces)", () => {
		const { sql } = compileCH(serviceDbEdgesForServiceQuery({ serviceName: "artifacts-api" }), baseParams)
		const matches = sql.match(/ServiceName = 'artifacts-api'/g)
		// One in the hourly branch, one in the raw-traces fallback.
		expect(matches && matches.length === 2).toBe(true)
	})

	it("unions service_map_db_edges_hourly with raw traces for the in-progress hour", () => {
		const { sql } = compileCH(serviceDbEdgesForServiceQuery({ serviceName: "artifacts-api" }), baseParams)
		expect(sql).toContain("FROM service_map_db_edges_hourly")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("Timestamp >= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})

	it("restricts the raw branch to Client/Producer spans with a db system set (stable + legacy)", () => {
		const { sql } = compileCH(serviceDbEdgesForServiceQuery({ serviceName: "artifacts-api" }), baseParams)
		expect(sql).toContain("SpanKind IN ('Client', 'Producer')")
		// Same stable→legacy coalesce as the MV write side (DB_SYSTEM_ATTR_SQL).
		expect(sql).toContain(
			"coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != ''",
		)
	})

	it("carries dbNamespace on both branches so distinct databases split", () => {
		const { sql } = compileCH(serviceDbEdgesForServiceQuery({ serviceName: "artifacts-api" }), baseParams)
		// hourly branch reads the rollup's stored dimension
		expect(sql).toContain("DbNamespace")
		// raw branch derives the identity via the shared coalesce order
		expect(sql).toContain("SpanAttributes['db.namespace']")
		expect(sql).toContain("SpanAttributes['db.name']")
		expect(sql).toContain("SpanAttributes['server.address']")
		expect(sql).toContain("SpanAttributes['net.peer.name']")
	})

	it("threads deploymentEnv through both branches", () => {
		const { sql } = compileCH(
			serviceDbEdgesForServiceQuery({
				serviceName: "artifacts-api",
				deploymentEnv: "production",
			}),
			baseParams,
		)
		expect(sql).toContain("DeploymentEnv = 'production'")
		expect(sql).toContain("ResourceAttributes['deployment.environment'] = 'production'")
	})

	it("orders by callCount desc, limits to 200, formats as JSON", () => {
		const { sql } = compileCH(serviceDbEdgesForServiceQuery({ serviceName: "artifacts-api" }), baseParams)
		expect(sql).toContain("ORDER BY callCount DESC")
		expect(sql).toContain("LIMIT 200")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in serviceName to prevent SQL injection", () => {
		const { sql } = compileCH(serviceDbEdgesForServiceQuery({ serviceName: "weird'service" }), baseParams)
		expect(sql).toContain("ServiceName = 'weird\\'service'")
	})
})

// ---------------------------------------------------------------------------
// serviceDbQuerySummarySQL / serviceDbQueryTimeseriesSQL / serviceDbTopQueriesSQL
// ---------------------------------------------------------------------------

describe("service-map database query summaries", () => {
	const params = {
		...baseParams,
		dbSystem: "postgresql",
		sourceService: "artifacts-api",
		deploymentEnv: "production",
		bucketSeconds: 300,
		topN: 5,
	}

	it("reads the sealed rollup for complete hours and raw traces for the in-progress hour", () => {
		const { sql } = serviceDbQuerySummarySQL(params)
		expect(sql).toContain("UNION ALL")
		// sealed rollup branch — complete hours only
		expect(sql).toContain("FROM service_map_db_query_shapes_hourly")
		expect(sql).toContain("DbSystem = 'postgresql'")
		expect(sql).toContain("DeploymentEnv = 'production'")
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2024-01-01 00:00:00'))")
		expect(sql).toContain("Hour < toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
		// raw branch — in-progress (current) hour only
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("Timestamp >= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
		expect(sql).toContain("Timestamp <= toDateTime('2024-01-02 00:00:00')")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'artifacts-api'")
		expect(sql).toContain("ResourceAttributes['deployment.environment'] = 'production'")
		expect(sql).toContain(
			"coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = 'postgresql'",
		)
	})

	it("merges sample-weighted TDigest states across the rollup + raw branches for P50/P95", () => {
		const { sql } = serviceDbQuerySummarySQL(params)
		// rollup stores a t-digest state; raw branch builds the matching state…
		expect(sql).toContain("quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles)")
		expect(sql).toContain(
			"quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0)))",
		)
		// …and the outer query merges both into final quantiles
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.5, 0.95)(bQ)")
		expect(sql).toContain("AS p50DurationMs")
		expect(sql).toContain("AS p95DurationMs")
	})

	it("buckets sub-hour query activity from raw traces (rollup can't serve <1h buckets)", () => {
		const { sql } = serviceDbQueryTimeseriesSQL(params) // bucketSeconds: 300
		expect(sql).toContain("toStartOfInterval(toDateTime(Timestamp), INTERVAL 300 SECOND) AS bucket")
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("service_map_db_query_shapes_hourly")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("LIMIT 2000")
	})

	it("serves hour-aligned query activity from the rollup + raw union", () => {
		const { sql } = serviceDbQueryTimeseriesSQL({ ...params, bucketSeconds: 3600 })
		expect(sql).toContain("FROM service_map_db_query_shapes_hourly")
		expect(sql).toContain("toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles)")
	})

	it("groups top queries by the rollup key and the shared fingerprint fallback", () => {
		const { sql } = serviceDbTopQueriesSQL(params)
		// sealed branch reads the rollup's pre-computed key…
		expect(sql).toContain("FROM service_map_db_query_shapes_hourly")
		// …the raw branch derives the SAME key via the shared SQL fragments
		expect(sql).toContain("SpanAttributes['db.statement.fingerprint']")
		expect(sql).toContain("SpanAttributes['db.query.summary']")
		expect(sql).toContain("cityHash64")
		expect(sql).toContain("GROUP BY queryKey")
		expect(sql).toContain("ORDER BY estimatedQueryCount DESC")
		expect(sql).toContain("LIMIT 5")
	})

	it("normalizes literals into the shape key and prefers db.query.summary over the span name", () => {
		const { sql } = serviceDbTopQueriesSQL(params)
		// literal-normalized fingerprint fallback collapses per-literal variants
		expect(sql).toContain("replaceRegexpAll")
		expect(sql).toContain("in (?)")
		// OTEL label precedence: db.query.summary is consulted before SpanName
		expect(sql.indexOf("db.query.summary")).toBeLessThan(sql.indexOf("SpanName"))
	})

	it("labels top queries from the literal-stripped sample statement, falling back to the derived label", () => {
		const { sql } = serviceDbTopQueriesSQL(params)
		// distinct co-located shapes (same op/collection, different SQL) get their
		// own statement-based label instead of one indistinct summary row…
		expect(sql).toContain("if(sampleStatement != ''")
		expect(sql).toContain("AS queryLabel")
		// …derived by stripping literals from the sample statement (preserving case)
		expect(sql).toContain("replaceRegexpAll")
		// …and falls back to the rollup's derived label when there's no statement
		expect(sql).toContain("fallbackLabel")
	})

	it("clamps untrusted bucket and limit values", () => {
		const timeseries = serviceDbQueryTimeseriesSQL({ ...params, bucketSeconds: 1 }).sql
		const topQueries = serviceDbTopQueriesSQL({ ...params, topN: 500 }).sql
		expect(timeseries).toContain("INTERVAL 60 SECOND")
		expect(topQueries).toContain("LIMIT 50")
	})

	it("scopes to one database identity when dbNamespace is set (rollup + raw branches)", () => {
		const { sql } = serviceDbQuerySummarySQL({ ...params, dbNamespace: "orders" })
		// sealed rollup branch filters the stored dimension (re-collapsed)…
		expect(sql).toContain(`${SEALED_NAMESPACE_COLLAPSE} = 'orders'`)
		// …the raw branch filters via the shared identity fragment
		expect(sql).toContain(`${DB_NAMESPACE_ATTR_SQL} = 'orders'`)
	})

	it("treats dbNamespace='' as the legacy/unknown node and undefined as unscoped", () => {
		const scoped = serviceDbQuerySummarySQL({ ...params, dbNamespace: "" }).sql
		expect(scoped).toContain(`${SEALED_NAMESPACE_COLLAPSE} = ''`)
		const unscoped = serviceDbQuerySummarySQL(params).sql
		expect(unscoped).not.toContain(`${SEALED_NAMESPACE_COLLAPSE} = `)
	})

	it("scopes hour-aligned timeseries and top-queries to dbNamespace on both branches", () => {
		// Both sibling builders must thread the same filter as the summary — a
		// regression here silently widens the panel to every database of the system.
		// (Sub-hour timeseries is raw-only, covered separately below.)
		const namespaceCoalesce = `${DB_NAMESPACE_ATTR_SQL} = 'orders'`
		const timeseries = serviceDbQueryTimeseriesSQL({ ...params, dbNamespace: "orders", bucketSeconds: 3600 }).sql
		const topQueries = serviceDbTopQueriesSQL({ ...params, dbNamespace: "orders" }).sql
		for (const sql of [timeseries, topQueries]) {
			expect(sql).toContain(`${SEALED_NAMESPACE_COLLAPSE} = 'orders'`) // sealed rollup branch
			expect(sql).toContain(namespaceCoalesce) // raw in-progress-hour branch
		}
	})

	it("scopes sub-hour timeseries to dbNamespace via the raw identity fragment", () => {
		// The <1h path reads raw traces only (rollup can't serve sub-hour buckets),
		// so it filters on the coalesced identity, not the stored DbNamespace column.
		const { sql } = serviceDbQueryTimeseriesSQL({ ...params, dbNamespace: "orders", bucketSeconds: 300 })
		expect(sql).not.toContain("service_map_db_query_shapes_hourly")
		expect(sql).toContain(`${DB_NAMESPACE_ATTR_SQL} = 'orders'`)
	})

	it("escapes raw params in summary SQL", () => {
		const { sql } = serviceDbQuerySummarySQL({
			...baseParams,
			dbSystem: "post'gres",
			sourceService: "svc'one",
			deploymentEnv: "prod'west",
		})
		expect(sql).toContain("= 'post\\'gres'")
		expect(sql).toContain("ServiceName = 'svc\\'one'")
		expect(sql).toContain("ResourceAttributes['deployment.environment'] = 'prod\\'west'")
	})

	it.effect("decodes summary rows with numeric strings from ClickHouse JSON", () =>
		Effect.gen(function* () {
			const compiled = serviceDbQuerySummarySQL(params)

			const rows = yield* compiled.decodeRows([
				{
					queryCount: "10",
					estimatedQueryCount: "14.5",
					errorCount: "2",
					estimatedErrorCount: "3.5",
					errorRate: "0.2",
					avgDurationMs: "12.25",
					p50DurationMs: "9",
					p95DurationMs: "30",
					activeServiceCount: "4",
				},
			])

			expect(rows).toEqual([
				{
					queryCount: 10,
					estimatedQueryCount: 14.5,
					errorCount: 2,
					estimatedErrorCount: 3.5,
					errorRate: 0.2,
					avgDurationMs: 12.25,
					p50DurationMs: 9,
					p95DurationMs: 30,
					activeServiceCount: 4,
				},
			])
		}),
	)

	it.effect("decodes timeseries rows with numeric strings from ClickHouse JSON", () =>
		Effect.gen(function* () {
			const compiled = serviceDbQueryTimeseriesSQL(params)

			const rows = yield* compiled.decodeRows([
				{
					bucket: "2024-01-01 00:05:00",
					queryCount: "12",
					estimatedQueryCount: "16",
					errorCount: "1",
					errorRate: "0.0625",
					avgDurationMs: "7.5",
					p50DurationMs: "4",
					p95DurationMs: "20",
				},
			])

			expect(rows).toEqual([
				{
					bucket: "2024-01-01 00:05:00",
					queryCount: 12,
					estimatedQueryCount: 16,
					errorCount: 1,
					errorRate: 0.0625,
					avgDurationMs: 7.5,
					p50DurationMs: 4,
					p95DurationMs: 20,
				},
			])
		}),
	)

	it.effect("decodes top-query rows with numeric strings from ClickHouse JSON", () =>
		Effect.gen(function* () {
			const compiled = serviceDbTopQueriesSQL(params)

			const rows = yield* compiled.decodeRows([
				{
					queryKey: "abc",
					queryLabel: "SELECT users",
					sampleStatement: "SELECT * FROM users WHERE id = ?",
					sampleService: "artifacts-api",
					serviceCount: "1",
					queryCount: "50",
					estimatedQueryCount: "75",
					errorCount: "3",
					errorRate: "0.06",
					avgDurationMs: "12.5",
					p50DurationMs: "8",
					p95DurationMs: "44",
					lastSeen: "2024-01-01 00:05:00",
				},
			])

			expect(rows[0]).toMatchObject({
				queryKey: "abc",
				serviceCount: 1,
				queryCount: 50,
				estimatedQueryCount: 75,
				errorRate: 0.06,
			})
		}),
	)
})

describe("servicePlatformsSQL", () => {
	it.effect("decodes platform rows with the declared string columns", () =>
		Effect.gen(function* () {
			const compiled = servicePlatformsSQL({ deploymentEnv: "production" }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					serviceName: "artifacts-api",
					k8sCluster: "prod",
					k8sPodName: "artifacts-api-123",
					k8sDeploymentName: "artifacts-api",
					cloudPlatform: "",
					cloudProvider: "aws",
					faasName: "",
					mapleSdkType: "node",
					processRuntimeName: "nodejs",
				},
			])

			expect(rows[0]).toMatchObject({
				serviceName: "artifacts-api",
				k8sDeploymentName: "artifacts-api",
				cloudProvider: "aws",
				mapleSdkType: "node",
			})
		}),
	)

	it.effect("fails decoding when a platform string column is missing", () =>
		Effect.gen(function* () {
			const compiled = servicePlatformsSQL({}, baseParams)

			const exit = yield* Effect.exit(
				compiled.decodeRows([
					{
						serviceName: "artifacts-api",
						k8sCluster: "prod",
						k8sPodName: "artifacts-api-123",
						k8sDeploymentName: "artifacts-api",
						cloudPlatform: "",
						cloudProvider: "aws",
						faasName: "",
						mapleSdkType: "node",
					},
				]),
			)

			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)
})
