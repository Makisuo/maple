import { describe, expect, it } from "vitest"
import { compile } from "../index"
import { compile as compileFragment } from "@maple-dev/clickhouse-builder/sql"
import * as CH from "../index"
import { edgeCondition, hourGrain, interiorBounds, interiorConditions, minuteGrain } from "./rollup-splice"

// ---------------------------------------------------------------------------
// These pin the tiling invariant: the raw edge and the aggregate interior must
// cover the window exactly once. Getting it wrong does not raise — it inflates
// or deflates counts — so the boundary is asserted directly rather than
// inferred from a query's output.
//
// What this can and cannot prove: it proves both halves are built from ONE
// boundary definition, which is the failure mode five hand-copied definitions
// had. It does NOT prove the tiers tile against real data; that needs a live
// ClickHouse (insert spans straddling a boundary, assert raw-only total ==
// spliced total) and belongs with the apps/api DESCRIBE sweep.
// ---------------------------------------------------------------------------

const sqlOf = (cond: CH.Condition) => compileFragment(cond.toFragment())

/** Compile a trivial query carrying `conds` so the WHERE text can be inspected. */
const whereSql = (conds: ReadonlyArray<CH.Condition>) => {
	const t = CH.table("t", { OrgId: CH.string, Hour: CH.dateTime, Minute: CH.dateTime })
	return compile(
		CH.from(t)
			.select(($) => ({ c: $.OrgId }))
			.where(($) => [$.OrgId.eq("org"), ...conds]),
		{ startTime: "2026-01-01 10:30:00", endTime: "2026-01-03 14:15:00" },
	).sql
}

describe("rollup splice boundaries", () => {
	describe("half-open interior", () => {
		// A `<=` on the upper bound would include the trailing partial bucket that
		// the raw edge also covers — the silent double-count.
		it("bounds the interior with >= lower and strictly < upper", () => {
			const [lower, upper] = interiorConditions(CH.rawExpr<string>("Hour"))
			expect(sqlOf(lower)).toContain(">=")
			expect(sqlOf(upper)).toContain("<")
			expect(sqlOf(upper)).not.toContain("<=")
		})

		it("uses the same bounds in interiorBounds as in interiorConditions", () => {
			const bounds = interiorBounds()
			expect(bounds.gte).toBe(hourGrain.firstFullBucket)
			expect(bounds.lt).toBe(hourGrain.endFloor)
		})
	})

	describe("aligned start", () => {
		// When the window begins exactly on a boundary, startFloor IS the first
		// whole bucket. Advancing unconditionally would drop it entirely.
		it("guards firstFullBucket against advancing past an aligned start", () => {
			expect(hourGrain.firstFullBucket).toBe(
				`if(${hourGrain.startDt} = ${hourGrain.startFloor}, ${hourGrain.startFloor}, ${hourGrain.startFloor} + INTERVAL 1 HOUR)`,
			)
			expect(minuteGrain.firstFullBucket).toContain("INTERVAL 1 MINUTE")
		})
	})

	describe("complementarity", () => {
		// The edge is the exact complement of the interior: same two boundary
		// expressions, opposite inequalities. This is what makes the two tiers
		// tile rather than gap or overlap.
		it.each([
			["hour", hourGrain],
			["minute", minuteGrain],
		])("edge and interior share one boundary definition (%s grain)", (_label, grain) => {
			const edge = sqlOf(edgeCondition("Timestamp", grain))
			expect(edge).toBe(`(Timestamp < ${grain.firstFullBucket} OR Timestamp >= ${grain.endFloor})`)

			const [lower, upper] = interiorConditions(CH.rawExpr<string>("Hour"), grain)
			// The edge excludes exactly what the interior includes.
			expect(sqlOf(lower)).toContain(grain.firstFullBucket)
			expect(sqlOf(upper)).toContain(grain.endFloor)
		})

		it("lets the edge take a different physical column than the interior", () => {
			// The three-tier service-operations splice reads its minutely tier with
			// the HOUR grain, so column and grain vary independently.
			expect(sqlOf(edgeCondition("Minute", hourGrain))).toBe(
				`(Minute < ${hourGrain.firstFullBucket} OR Minute >= ${hourGrain.endFloor})`,
			)
		})
	})

	it("emits placeholders that survive to compile time", () => {
		// The fragments embed __PARAM_*__ rather than literals, so a compiled
		// query resolves them once at the outer compile() call.
		expect(hourGrain.startDt).toContain("__PARAM_startTime__")
		const sql = whereSql([edgeCondition("Hour")])
		expect(sql).not.toContain("__PARAM_")
		expect(sql).toContain("2026-01-01 10:30:00")
	})
})
