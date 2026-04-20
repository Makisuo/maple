import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { MutableList } from "effect"

describe("MutableList", () => {
  it("appendAll with an empty array keeps an empty list empty", () => {
    const list = MutableList.make<number>()

    strictEqual(MutableList.appendAll(list, []), 0)
    strictEqual(list.length, 0)
    strictEqual(list.head, undefined)
    strictEqual(list.tail, undefined)
    strictEqual(MutableList.take(list), MutableList.Empty)
  })

  it("appendAll with an empty array does not break subsequent appends", () => {
    const list = MutableList.make<number>()

    MutableList.appendAll(list, [])
    MutableList.append(list, 1)
    MutableList.appendAll(list, [])
    MutableList.append(list, 2)

    deepStrictEqual(MutableList.takeAll(list), [1, 2])
    strictEqual(MutableList.take(list), MutableList.Empty)
  })

  it("appendAllUnsafe with an empty array is a no-op", () => {
    const list = MutableList.make<number>()

    MutableList.appendAll(list, [1])
    strictEqual(MutableList.appendAllUnsafe(list, []), 0)
    MutableList.append(list, 2)

    deepStrictEqual(MutableList.takeAll(list), [1, 2])
    strictEqual(MutableList.take(list), MutableList.Empty)
  })
})
