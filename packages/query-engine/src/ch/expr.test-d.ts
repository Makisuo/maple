// ---------------------------------------------------------------------------
// Type-level tests: Expression type safety
// ---------------------------------------------------------------------------

import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import type { Expr, Condition, ColumnRef } from "./expr"
import type { ParamMarker } from "./param"
import type { CHString, CHFloat64, CHMap } from "./types"
import { makeColumnRef } from "./expr"

// ---------------------------------------------------------------------------
// Literal expressions
// ---------------------------------------------------------------------------

expectTypeOf(CH.lit("hello")).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.lit(42)).toMatchTypeOf<Expr<number>>()

// ---------------------------------------------------------------------------
// Aggregate functions — return types
// ---------------------------------------------------------------------------

expectTypeOf(CH.count()).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.avg(CH.lit(1))).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.sum(CH.lit(1))).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.uniq(CH.lit("x"))).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.countIf(CH.lit(1).gt(0))).toMatchTypeOf<Expr<number>>()

// min/max preserve generic type
expectTypeOf(CH.min(CH.lit("a"))).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.max(CH.lit(1))).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.min(CH.lit(1))).toMatchTypeOf<Expr<number>>()

// any_ preserves generic
expectTypeOf(CH.any(CH.lit("x"))).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.any(CH.lit(1))).toMatchTypeOf<Expr<number>>()

// groupUniqArray wraps in ReadonlyArray
expectTypeOf(CH.groupUniqArray(CH.lit("x"))).toMatchTypeOf<Expr<ReadonlyArray<string>>>()
expectTypeOf(CH.groupUniqArray(CH.lit(1))).toMatchTypeOf<Expr<ReadonlyArray<number>>>()

// quantile returns Expr<number>
expectTypeOf(CH.quantile(0.95)(CH.lit(1))).toMatchTypeOf<Expr<number>>()

// ---------------------------------------------------------------------------
// ClickHouse functions — return types
// ---------------------------------------------------------------------------

expectTypeOf(CH.toStartOfInterval(CH.lit("ts"), 60)).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.if_(CH.lit(1).gt(0), CH.lit("yes"), CH.lit("no"))).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.coalesce(CH.lit("a"), CH.lit("b"))).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.concat(CH.lit("a"), CH.lit("b"))).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.round_(CH.lit(1), 2)).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.intDiv(CH.lit(10), 3)).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.toString(CH.lit(1))).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.toFloat64OrZero(CH.lit("3.14"))).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.length(CH.lit("hello"))).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.position(CH.lit("hello"), "ell")).toMatchTypeOf<Expr<number>>()

// ---------------------------------------------------------------------------
// Comparison operators — return Condition
// ---------------------------------------------------------------------------

const strExpr = CH.lit("hello")
const numExpr = CH.lit(42)

expectTypeOf(strExpr.eq("world")).toMatchTypeOf<Condition>()
expectTypeOf(strExpr.neq("world")).toMatchTypeOf<Condition>()
expectTypeOf(numExpr.gt(0)).toMatchTypeOf<Condition>()
expectTypeOf(numExpr.gte(0)).toMatchTypeOf<Condition>()
expectTypeOf(numExpr.lt(100)).toMatchTypeOf<Condition>()
expectTypeOf(numExpr.lte(100)).toMatchTypeOf<Condition>()

// Comparisons also accept Expr of same type
expectTypeOf(strExpr.eq(CH.lit("world"))).toMatchTypeOf<Condition>()
expectTypeOf(numExpr.gt(CH.lit(0))).toMatchTypeOf<Condition>()

// IN / NOT IN return Condition
expectTypeOf(strExpr.in_("a", "b")).toMatchTypeOf<Condition>()
expectTypeOf(strExpr.notIn("a", "b")).toMatchTypeOf<Condition>()

// Condition combinators return Condition
const cond = strExpr.eq("x")
expectTypeOf(cond.and(numExpr.gt(0))).toMatchTypeOf<Condition>()
expectTypeOf(cond.or(numExpr.lt(10))).toMatchTypeOf<Condition>()

// ---------------------------------------------------------------------------
// Arithmetic — only valid for Expr<number>
// ---------------------------------------------------------------------------

expectTypeOf(numExpr.div(2)).toMatchTypeOf<Expr<number>>()
expectTypeOf(numExpr.mul(2)).toMatchTypeOf<Expr<number>>()
expectTypeOf(numExpr.add(1)).toMatchTypeOf<Expr<number>>()
expectTypeOf(numExpr.sub(1)).toMatchTypeOf<Expr<number>>()

// Arithmetic with Expr<number> argument
expectTypeOf(numExpr.div(CH.lit(2))).toMatchTypeOf<Expr<number>>()

// @ts-expect-error — .div() requires Expr<number>, not Expr<string>
strExpr.div(2)

// @ts-expect-error — .mul() requires Expr<number>
strExpr.mul(2)

// @ts-expect-error — .add() requires Expr<number>
strExpr.add(1)

// @ts-expect-error — .sub() requires Expr<number>
strExpr.sub(1)

// ---------------------------------------------------------------------------
// String operations — only valid for Expr<string>
// ---------------------------------------------------------------------------

expectTypeOf(strExpr.like("%test%")).toMatchTypeOf<Condition>()
expectTypeOf(strExpr.ilike("%test%")).toMatchTypeOf<Condition>()
expectTypeOf(strExpr.notLike("%test%")).toMatchTypeOf<Condition>()

// @ts-expect-error — .like() requires Expr<string>
numExpr.like("%test%")

// @ts-expect-error — .ilike() requires Expr<string>
numExpr.ilike("%test%")

// @ts-expect-error — .notLike() requires Expr<string>
numExpr.notLike("%test%")

// ---------------------------------------------------------------------------
// ColumnRef .get() — only valid for Map columns
// ---------------------------------------------------------------------------

const mapRef = makeColumnRef<"Attrs", CHMap<CHString, CHString>>("Attrs")
expectTypeOf(mapRef.get("key")).toMatchTypeOf<Expr<string>>()

const strRef = makeColumnRef<"Name", CHString>("Name")
// @ts-expect-error — .get() requires a Map column type
strRef.get("key")

const numRef = makeColumnRef<"Score", CHFloat64>("Score")
// @ts-expect-error — .get() requires a Map column type
numRef.get("key")

// ---------------------------------------------------------------------------
// Type mismatch in comparisons
// ---------------------------------------------------------------------------

// @ts-expect-error — cannot compare Expr<string> with number
strExpr.eq(42)

// @ts-expect-error — cannot compare Expr<number> with string
numExpr.eq("hello")

// ---------------------------------------------------------------------------
// Aggregate function input constraints
// ---------------------------------------------------------------------------

// @ts-expect-error — avg requires Expr<number>
CH.avg(CH.lit("hello"))

// @ts-expect-error — sum requires Expr<number>
CH.sum(CH.lit("hello"))

// ---------------------------------------------------------------------------
// Param type safety
// ---------------------------------------------------------------------------

expectTypeOf(CH.param.string("orgId")).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.param.string("orgId")).toMatchTypeOf<ParamMarker<"orgId", string>>()

expectTypeOf(CH.param.int("limit")).toMatchTypeOf<Expr<number>>()
expectTypeOf(CH.param.int("limit")).toMatchTypeOf<ParamMarker<"limit", number>>()

expectTypeOf(CH.param.dateTime("start")).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.param.dateTime("start")).toMatchTypeOf<ParamMarker<"start", string>>()

// Param name is captured as a literal type
expectTypeOf(CH.param.string("orgId")._paramName).toEqualTypeOf<"orgId">()
expectTypeOf(CH.param.int("limit")._paramName).toEqualTypeOf<"limit">()

// ---------------------------------------------------------------------------
// mapContains / mapGet / inList — return types
// ---------------------------------------------------------------------------

expectTypeOf(CH.mapContains(mapRef, "key")).toMatchTypeOf<Condition>()
expectTypeOf(CH.mapGet(mapRef, "key")).toMatchTypeOf<Expr<string>>()
expectTypeOf(CH.inList(strExpr, ["a", "b"])).toMatchTypeOf<Condition>()

// ---------------------------------------------------------------------------
// Array constructors
// ---------------------------------------------------------------------------

expectTypeOf(CH.arrayOf(CH.lit("a"), CH.lit("b"))).toMatchTypeOf<Expr<ReadonlyArray<string>>>()
expectTypeOf(CH.arrayOf(CH.lit(1), CH.lit(2))).toMatchTypeOf<Expr<ReadonlyArray<number>>>()
