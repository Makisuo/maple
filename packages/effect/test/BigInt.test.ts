import * as BigInt from "effect/BigInt"
import { describe, it } from "vitest"
import { assertNone, assertSome, strictEqual } from "./utils/assert.ts"

describe("BigInt", () => {
  it("Equivalence", () => {
    strictEqual(BigInt.Equivalence(1n, 1n), true)
    strictEqual(BigInt.Equivalence(1n, 2n), false)
  })

  it("divide", () => {
    assertSome(BigInt.divide(6n, 3n), 2n)
    assertNone(BigInt.divide(6n, 0n))
    strictEqual(BigInt.divideUnsafe(6n, 3n), 2n)
  })

  it("sqrt", () => {
    assertSome(BigInt.sqrt(4n), 2n)
    assertNone(BigInt.sqrt(-1n))
  })

  it("toNumber", () => {
    assertSome(BigInt.toNumber(42n), 42)
    assertNone(BigInt.toNumber(BigInt.BigInt(Number.MAX_SAFE_INTEGER) + 1n))
  })

  it("fromString", () => {
    assertSome(BigInt.fromString("42"), 42n)
    assertNone(BigInt.fromString(" "))
    assertNone(BigInt.fromString("a"))
  })

  it("fromNumber", () => {
    assertSome(BigInt.fromNumber(42), 42n)
    assertNone(BigInt.fromNumber(Number.MAX_SAFE_INTEGER + 1))
  })

  it("ReducerSum", () => {
    strictEqual(BigInt.ReducerSum.combine(1n, 2n), 3n)
    strictEqual(BigInt.ReducerSum.combine(BigInt.ReducerSum.initialValue, 2n), 2n)
    strictEqual(BigInt.ReducerSum.combine(2n, BigInt.ReducerSum.initialValue), 2n)
  })

  it("ReducerMultiply", () => {
    strictEqual(BigInt.ReducerMultiply.combine(2n, 3n), 6n)
    strictEqual(BigInt.ReducerMultiply.combine(BigInt.ReducerMultiply.initialValue, 2n), 2n)
    strictEqual(BigInt.ReducerMultiply.combine(2n, BigInt.ReducerMultiply.initialValue), 2n)
  })

  it("CombinerMax", () => {
    strictEqual(BigInt.CombinerMax.combine(1n, 2n), 2n)
  })

  it("CombinerMin", () => {
    strictEqual(BigInt.CombinerMin.combine(1n, 2n), 1n)
  })
})
