// ---------------------------------------------------------------------------
// Type-level tests: Query builder, joins, subqueries, union, compilation
// ---------------------------------------------------------------------------

import { expectTypeOf } from "expect-type"
import * as CH from "./index"
import type { InferQueryOutput } from "./query"
import type { InferUnionOutput } from "./union"
import type { CompiledQuery } from "./compile"
import type { Expr } from "./expr"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const Users = CH.table("users", {
  Id: CH.string,
  Name: CH.string,
  Age: CH.uint64,
  Score: CH.float64,
  Attrs: CH.map(CH.string, CH.string),
  Tags: CH.array(CH.string),
  CreatedAt: CH.dateTime64,
})

const Orders = CH.table("orders", {
  Id: CH.string,
  UserId: CH.string,
  Amount: CH.uint64,
  Status: CH.string,
})

const Tags = CH.table("tags", {
  Id: CH.string,
  UserId: CH.string,
  Label: CH.string,
})

// ---------------------------------------------------------------------------
// Select — callback overload infers Output from returned record
// ---------------------------------------------------------------------------

const q1 = CH.from(Users).select(($) => ({
  bucket: CH.toStartOfInterval($.CreatedAt, 60),
  count: CH.count(),
  avgScore: CH.avg($.Score),
}))

type Q1Output = InferQueryOutput<typeof q1>
expectTypeOf<Q1Output>().toEqualTypeOf<{
  readonly bucket: string
  readonly count: number
  readonly avgScore: number
}>()

// ---------------------------------------------------------------------------
// Select — shorthand overload infers Output from column names
// ---------------------------------------------------------------------------

const q2 = CH.from(Users).select("Id", "Name")

type Q2Output = InferQueryOutput<typeof q2>
expectTypeOf<Q2Output>().toEqualTypeOf<{
  readonly Id: string
  readonly Name: string
}>()

const q3 = CH.from(Users).select("Id", "Age", "Score")

type Q3Output = InferQueryOutput<typeof q3>
expectTypeOf<Q3Output>().toEqualTypeOf<{
  readonly Id: string
  readonly Age: number
  readonly Score: number
}>()

// ---------------------------------------------------------------------------
// Select — shorthand rejects invalid column names
// ---------------------------------------------------------------------------

// @ts-expect-error — "NonExistent" is not a column on Users
CH.from(Users).select("Id", "NonExistent")

// ---------------------------------------------------------------------------
// Column accessor types inside select callback
// ---------------------------------------------------------------------------

CH.from(Users).select(($) => {
  expectTypeOf($.Id).toMatchTypeOf<Expr<string>>()
  expectTypeOf($.Age).toMatchTypeOf<Expr<number>>()
  expectTypeOf($.Score).toMatchTypeOf<Expr<number>>()
  expectTypeOf($.Attrs).toMatchTypeOf<Expr<Record<string, string>>>()
  expectTypeOf($.Tags).toMatchTypeOf<Expr<ReadonlyArray<string>>>()
  expectTypeOf($.CreatedAt).toMatchTypeOf<Expr<string>>()
  return { id: $.Id }
})

// ---------------------------------------------------------------------------
// Chaining preserves Output type through where/groupBy/orderBy/limit/format
// ---------------------------------------------------------------------------

const full = CH.from(Users)
  .select(($) => ({
    name: $.Name,
    count: CH.count(),
  }))
  .where(($) => [$.Id.eq("test")])
  .groupBy("name")
  .orderBy(["count", "desc"])
  .limit(10)
  .format("JSON")

type FullOutput = InferQueryOutput<typeof full>
expectTypeOf<FullOutput>().toEqualTypeOf<{
  readonly name: string
  readonly count: number
}>()

// ---------------------------------------------------------------------------
// groupBy and orderBy only accept keys from Output
// ---------------------------------------------------------------------------

const qWithSelect = CH.from(Users).select(($) => ({
  name: $.Name,
  count: CH.count(),
}))

// Valid — keys exist in Output
qWithSelect.groupBy("name", "count")
qWithSelect.orderBy(["name", "asc"], ["count", "desc"])

// @ts-expect-error — "bogus" is not a key of Output
qWithSelect.groupBy("bogus")

// @ts-expect-error — "bogus" is not a key of Output
qWithSelect.orderBy(["bogus", "asc"])

// ---------------------------------------------------------------------------
// innerJoin — adds typed columns under alias
// ---------------------------------------------------------------------------

const joined = CH.from(Users)
  .innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))

const jq = joined.select(($) => ({
  userName: $.Name,
  orderAmount: $.o.Amount,
  orderStatus: $.o.Status,
}))

type JQOutput = InferQueryOutput<typeof jq>
expectTypeOf<JQOutput>().toEqualTypeOf<{
  readonly userName: string
  readonly orderAmount: number
  readonly orderStatus: string
}>()

// ---------------------------------------------------------------------------
// leftJoin — wraps joined columns with | null
// ---------------------------------------------------------------------------

const leftJoined = CH.from(Users)
  .leftJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))

const ljq = leftJoined.select(($) => ({
  userName: $.Name,
  orderAmount: $.o.Amount,
  orderStatus: $.o.Status,
}))

type LJQOutput = InferQueryOutput<typeof ljq>
expectTypeOf<LJQOutput>().toEqualTypeOf<{
  readonly userName: string
  readonly orderAmount: number | null
  readonly orderStatus: string | null
}>()

// ---------------------------------------------------------------------------
// Multiple joins accumulate
// ---------------------------------------------------------------------------

const multi = CH.from(Users)
  .innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
  .innerJoin(Tags, "t", (u, t) => u.Id.eq(t.UserId))
  .select(($) => ({
    name: $.Name,
    amount: $.o.Amount,
    label: $.t.Label,
  }))

type MultiOutput = InferQueryOutput<typeof multi>
expectTypeOf<MultiOutput>().toEqualTypeOf<{
  readonly name: string
  readonly amount: number
  readonly label: string
}>()

// ---------------------------------------------------------------------------
// crossJoin — no nullable wrapping
// ---------------------------------------------------------------------------

const crossed = CH.from(Users)
  .crossJoin(Orders, "o")
  .select(($) => ({
    userName: $.Name,
    orderAmount: $.o.Amount,
  }))

type CrossOutput = InferQueryOutput<typeof crossed>
expectTypeOf<CrossOutput>().toEqualTypeOf<{
  readonly userName: string
  readonly orderAmount: number
}>()

// ---------------------------------------------------------------------------
// innerJoinQuery — join with subquery
// ---------------------------------------------------------------------------

const subquery = CH.from(Orders).select(($) => ({
  userId: $.UserId,
  totalAmount: CH.sum($.Amount),
}))

const joinedSub = CH.from(Users)
  .innerJoinQuery(subquery, "agg", (u, agg) => u.Id.eq(agg.userId))
  .select(($) => ({
    name: $.Name,
    total: $.agg.totalAmount,
  }))

type JoinedSubOutput = InferQueryOutput<typeof joinedSub>
expectTypeOf<JoinedSubOutput>().toEqualTypeOf<{
  readonly name: string
  readonly total: number
}>()

// ---------------------------------------------------------------------------
// leftJoinQuery — nullable subquery join
// ---------------------------------------------------------------------------

const leftJoinedSub = CH.from(Users)
  .leftJoinQuery(subquery, "agg", (u, agg) => u.Id.eq(agg.userId))
  .select(($) => ({
    name: $.Name,
    total: $.agg.totalAmount,
  }))

type LeftJoinedSubOutput = InferQueryOutput<typeof leftJoinedSub>
expectTypeOf<LeftJoinedSubOutput>().toEqualTypeOf<{
  readonly name: string
  readonly total: number | null
}>()

// ---------------------------------------------------------------------------
// fromQuery — type-safe FROM subquery
// ---------------------------------------------------------------------------

const inner = CH.from(Users).select(($) => ({
  userId: $.Id,
  userName: $.Name,
  userAge: $.Age,
}))

const outer = CH.fromQuery(inner, "sub").select(($) => ({
  id: $.userId,
  name: $.userName,
}))

type OuterOutput = InferQueryOutput<typeof outer>
expectTypeOf<OuterOutput>().toEqualTypeOf<{
  readonly id: string
  readonly name: string
}>()

// ---------------------------------------------------------------------------
// unionAll — preserves shared Output type
// ---------------------------------------------------------------------------

const uq1 = CH.from(Users).select(($) => ({
  name: $.Name,
  count: CH.count(),
}))

const uq2 = CH.from(Users).select(($) => ({
  name: $.Id,
  count: CH.count(),
}))

const union = CH.unionAll(uq1, uq2)
type UnionOutput = InferUnionOutput<typeof union>
expectTypeOf<UnionOutput>().toEqualTypeOf<{
  readonly name: string
  readonly count: number
}>()

// Union orderBy accepts Output keys
union.orderBy(["count", "desc"])

// @ts-expect-error — "bogus" is not in union Output
union.orderBy(["bogus", "asc"])

// ---------------------------------------------------------------------------
// unionAll — mismatched Output types should fail
// ---------------------------------------------------------------------------

const qA = CH.from(Users).select(($) => ({
  name: $.Name,
  count: CH.count(),
}))

const qB = CH.from(Users).select(($) => ({
  name: $.Name,
  extra: $.Id,
}))

// @ts-expect-error — Output types don't match (count vs extra)
CH.unionAll(qA, qB)

// ---------------------------------------------------------------------------
// compileCH — output type matches query Output
// ---------------------------------------------------------------------------

const compileTarget = CH.from(Users).select(($) => ({
  id: $.Id,
  age: $.Age,
}))

const compiled = CH.compile(compileTarget, {})

expectTypeOf(compiled).toMatchTypeOf<
  CompiledQuery<{ readonly id: string; readonly age: number }>
>()

// castRows returns correctly typed array
expectTypeOf(compiled.castRows([])).toEqualTypeOf<
  ReadonlyArray<{ readonly id: string; readonly age: number }>
>()

// ---------------------------------------------------------------------------
// InferQueryOutput utility type
// ---------------------------------------------------------------------------

type Extracted = InferQueryOutput<typeof compileTarget>
expectTypeOf<Extracted>().toEqualTypeOf<{
  readonly id: string
  readonly age: number
}>()
