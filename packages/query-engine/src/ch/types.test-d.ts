// ---------------------------------------------------------------------------
// Type-level tests: Phantom type inference
// ---------------------------------------------------------------------------

import { expectTypeOf } from "expect-type"
import type {
  CHString,
  CHUInt8,
  CHUInt16,
  CHUInt32,
  CHUInt64,
  CHInt32,
  CHFloat64,
  CHDateTime,
  CHDateTime64,
  CHBool,
  CHMap,
  CHArray,
  CHNullable,
  InferTS,
  OutputToColumnDefs,
  NullableColumnDefs,
} from "./types"

// ---------------------------------------------------------------------------
// Primitive type inference
// ---------------------------------------------------------------------------

expectTypeOf<InferTS<CHString>>().toEqualTypeOf<string>()
expectTypeOf<InferTS<CHUInt8>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<CHUInt16>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<CHUInt32>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<CHUInt64>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<CHInt32>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<CHFloat64>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<CHDateTime>>().toEqualTypeOf<string>()
expectTypeOf<InferTS<CHDateTime64>>().toEqualTypeOf<string>()
expectTypeOf<InferTS<CHBool>>().toEqualTypeOf<boolean>()

// ---------------------------------------------------------------------------
// Compound type inference
// ---------------------------------------------------------------------------

expectTypeOf<InferTS<CHMap<CHString, CHString>>>().toEqualTypeOf<Record<string, string>>()
expectTypeOf<InferTS<CHMap<CHString, CHFloat64>>>().toEqualTypeOf<Record<string, number>>()
expectTypeOf<InferTS<CHArray<CHString>>>().toEqualTypeOf<ReadonlyArray<string>>()
expectTypeOf<InferTS<CHArray<CHFloat64>>>().toEqualTypeOf<ReadonlyArray<number>>()
expectTypeOf<InferTS<CHNullable<CHString>>>().toEqualTypeOf<string | null>()
expectTypeOf<InferTS<CHNullable<CHFloat64>>>().toEqualTypeOf<number | null>()

// Nested compound types
expectTypeOf<InferTS<CHArray<CHMap<CHString, CHString>>>>().toEqualTypeOf<
  ReadonlyArray<Record<string, string>>
>()
expectTypeOf<InferTS<CHNullable<CHArray<CHString>>>>().toEqualTypeOf<ReadonlyArray<string> | null>()

// ---------------------------------------------------------------------------
// OutputToColumnDefs — converts output record to synthetic column defs
// ---------------------------------------------------------------------------

type TestOutput = { name: string; count: number; active: boolean }
type Converted = OutputToColumnDefs<TestOutput>

expectTypeOf<InferTS<Converted["name"]>>().toEqualTypeOf<string>()
expectTypeOf<InferTS<Converted["count"]>>().toEqualTypeOf<number>()
expectTypeOf<InferTS<Converted["active"]>>().toEqualTypeOf<boolean>()

// ---------------------------------------------------------------------------
// NullableColumnDefs — wraps each column type with | null
// ---------------------------------------------------------------------------

type TestCols = { Name: CHString; Score: CHFloat64; Active: CHBool }
type Nulled = NullableColumnDefs<TestCols>

expectTypeOf<InferTS<Nulled["Name"]>>().toEqualTypeOf<string | null>()
expectTypeOf<InferTS<Nulled["Score"]>>().toEqualTypeOf<number | null>()
expectTypeOf<InferTS<Nulled["Active"]>>().toEqualTypeOf<boolean | null>()

// ---------------------------------------------------------------------------
// Negative cases — wrong type inferences should fail
// ---------------------------------------------------------------------------

// @ts-expect-error — CHString infers string, not number
expectTypeOf<InferTS<CHString>>().toEqualTypeOf<number>()

// @ts-expect-error — CHFloat64 infers number, not string
expectTypeOf<InferTS<CHFloat64>>().toEqualTypeOf<string>()

// @ts-expect-error — CHBool infers boolean, not number
expectTypeOf<InferTS<CHBool>>().toEqualTypeOf<number>()

// @ts-expect-error — CHNullable<CHString> infers string | null, not just string
expectTypeOf<InferTS<CHNullable<CHString>>>().toEqualTypeOf<string>()
