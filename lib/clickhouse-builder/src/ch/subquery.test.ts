import { describe, expect, it } from "@effect/vitest"
import { compileCHUnsafe } from "./compile"
import * as CH from "./index"
import { param } from "./param"

const Events = CH.table(
	"events",
	{
		OrgId: CH.string,
		TraceId: CH.string,
		ServiceName: CH.string,
		Count: CH.uint64,
	},
	{ tenantColumn: "OrgId" },
)

const Excluded = CH.table("excluded", { OrgId: CH.string, TraceId: CH.string }, { tenantColumn: "OrgId" })

const excludedTraces = CH.from(Excluded)
	.select(($) => ({ TraceId: $.TraceId }))
	.where(($) => [$.OrgId.eq(param.string("orgId"))])
	.groupBy("TraceId")

describe("subquery conditions", () => {
	it("splices a CHQuery as the IN subquery", () => {
		const { sql } = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ count: CH.count() }))
				.where(($) => [$.OrgId.eq(param.string("orgId")), CH.inSubquery($.TraceId, excludedTraces)]),
			{ orgId: "org_1" },
		)

		expect(sql).toContain("TraceId IN (")
		expect(sql).toContain("FROM excluded")
	})

	it("resolves the inner query's params from the outer param set", () => {
		const { sql } = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ count: CH.count() }))
				.where(($) => [$.OrgId.eq(param.string("orgId")), CH.inSubquery($.TraceId, excludedTraces)]),
			{ orgId: "org_1" },
		)

		// Both the outer predicate and the spliced subquery's own OrgId filter
		// must be resolved — a leftover placeholder would reach ClickHouse.
		expect(sql).not.toContain("__PARAM_")
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(2)
	})

	it("emits NOT IN for notInSubquery", () => {
		const { sql } = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ count: CH.count() }))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					CH.notInSubquery($.TraceId, excludedTraces),
				]),
			{ orgId: "org_1" },
		)

		expect(sql).toContain("TraceId NOT IN (")
	})

	it("still accepts pre-compiled SQL", () => {
		const { sql } = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ count: CH.count() }))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					CH.inSubquery($.TraceId, "SELECT TraceId FROM excluded"),
				]),
			{ orgId: "org_1" },
		)

		expect(sql).toContain("TraceId IN (SELECT TraceId FROM excluded)")
	})

	it("does NOT let a scoped subquery scope the outer query", () => {
		// `x IN (SELECT y FROM t WHERE OrgId = 'a')` does not confine the outer
		// read to org 'a' — another org can hold the same `y`.
		const compiled = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ count: CH.count() }))
				.where(($) => [CH.inSubquery($.TraceId, excludedTraces)]),
			{ orgId: "org_1" },
		)

		expect(compiled.tenantScope).toBe("cross-tenant")
	})
})

describe("withCTE with a query", () => {
	it("derives the CTE's tenant scope instead of taking it on assertion", () => {
		const scopedCte = CH.from(Events)
			.select(($) => ({ TraceId: $.TraceId, total: CH.sum($.Count) }))
			.where(($) => [$.OrgId.eq(param.string("orgId"))])
			.groupBy("TraceId")

		const compiled = compileCHUnsafe(
			CH.from(CH.table("hot", { TraceId: CH.string, total: CH.uint64 }))
				.select(($) => ({ TraceId: $.TraceId }))
				.withCTE("hot", scopedCte),
			{ orgId: "org_1" },
		)

		expect(compiled.sql.startsWith("WITH hot AS (")).toBe(true)
		// No OrgId predicate on the outer query — the scope comes from the CTE.
		expect(compiled.tenantScope).toBe("tenant")
	})

	it("reads as cross-tenant when the CTE query is itself unscoped", () => {
		const unscopedCte = CH.from(Events)
			.select(($) => ({ TraceId: $.TraceId }))
			.groupBy("TraceId")

		const compiled = compileCHUnsafe(
			CH.from(CH.table("hot", { TraceId: CH.string }))
				.select(($) => ({ TraceId: $.TraceId }))
				.withCTE("hot", unscopedCte),
			{},
		)

		expect(compiled.tenantScope).toBe("cross-tenant")
	})
})

describe("having", () => {
	it("emits HAVING after GROUP BY and before ORDER BY", () => {
		const { sql } = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ serviceName: $.ServiceName, total: CH.sum($.Count) }))
				.where(($) => [$.OrgId.eq(param.string("orgId"))])
				.groupBy("serviceName")
				.having(() => [CH.dynamicColumn<string>("serviceName").neq("")])
				.orderBy(["total", "desc"]),
			{ orgId: "org_1" },
		)

		expect(sql).toContain("HAVING serviceName != ''")
		expect(sql.indexOf("GROUP BY")).toBeLessThan(sql.indexOf("HAVING"))
		expect(sql.indexOf("HAVING")).toBeLessThan(sql.indexOf("ORDER BY"))
	})

	it("drops undefined entries like where does", () => {
		const build = (filterEmpty: boolean) =>
			compileCHUnsafe(
				CH.from(Events)
					.select(($) => ({ serviceName: $.ServiceName, total: CH.sum($.Count) }))
					.where(($) => [$.OrgId.eq(param.string("orgId"))])
					.groupBy("serviceName")
					.having(() =>
						filterEmpty ? [CH.dynamicColumn<string>("serviceName").neq("")] : [undefined],
					),
				{ orgId: "org_1" },
			).sql

		expect(build(true)).toContain("HAVING")
		expect(build(false)).not.toContain("HAVING")
	})

	it("does NOT scope a query via the tenant column", () => {
		// By HAVING time the rows are aggregated — the scan that produced them
		// already crossed tenants.
		const compiled = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ orgId: $.OrgId, total: CH.sum($.Count) }))
				.groupBy("orgId")
				.having(($) => [$.OrgId.eq(param.string("orgId"))]),
			{ orgId: "org_1" },
		)

		expect(compiled.sql).toContain("HAVING OrgId = 'org_1'")
		expect(compiled.tenantScope).toBe("cross-tenant")
	})
})

describe("Expr.mod", () => {
	it("emits an infix modulo", () => {
		const { sql } = compileCHUnsafe(
			CH.from(Events)
				.select(($) => ({ count: CH.count() }))
				.where(($) => [$.OrgId.eq(param.string("orgId")), CH.cityHash64($.TraceId).mod(16).eq(0)]),
			{ orgId: "org_1" },
		)

		expect(sql).toContain("cityHash64(TraceId) % 16 = 0")
	})
})

describe("deferred params", () => {
	// A spliced subquery compiles with no params so the outer pass resolves them.
	// Nested compilations (CTEs, FROM-subqueries, joins) are part of the same
	// string, so they have to inherit the deferral rather than demand values.
	it("defers a nested FROM-subquery's params to the outer compile", () => {
		const inner = CH.from(Events)
			.select(($) => ({ TraceId: $.TraceId }))
			.where(($) => [$.OrgId.eq(param.string("orgId"))])

		const spliced = CH.fromQuery(inner, "sub").select(($) => ({ traceId: $.TraceId }))

		const outer = CH.from(Events)
			.select(($) => ({ traceId: $.TraceId }))
			.where(($) => [$.OrgId.eq(param.string("orgId")), CH.inSubquery($.TraceId, spliced)])

		expect(compileCHUnsafe(outer, { orgId: "org_1" }).sql).not.toContain("__PARAM_")
	})
})
