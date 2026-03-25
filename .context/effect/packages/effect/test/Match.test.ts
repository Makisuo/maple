import { describe, it } from "@effect/vitest"
import { Match, pipe } from "effect"
import { strictEqual } from "./utils/assert.ts"

describe("Match", () => {
  it("tag skips null inputs", () => {
    const match = pipe(
      Match.type<{ _tag: "A" } | null>(),
      Match.tag("A", () => "hit"),
      Match.orElse(() => "miss")
    )

    strictEqual(match({ _tag: "A" }), "hit")
    strictEqual(match(null), "miss")
  })

  it("tagStartsWith skips null inputs", () => {
    const match = pipe(
      Match.type<{ _tag: "A.one" } | null>(),
      Match.tagStartsWith("A", () => "hit"),
      Match.orElse(() => "miss")
    )

    strictEqual(match({ _tag: "A.one" }), "hit")
    strictEqual(match(null), "miss")
  })
})
