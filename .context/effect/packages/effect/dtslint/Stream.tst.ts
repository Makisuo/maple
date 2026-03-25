import { Data, pipe, Stream } from "effect"
import { describe, expect, it } from "tstyche"

class ErrorA extends Data.TaggedError("ErrorA")<{
  readonly message: string
}> {}

class ErrorB extends Data.TaggedError("ErrorB")<{
  readonly code: number
}> {}

declare const stream: Stream.Stream<string, ErrorA | ErrorB, "dep-1">
declare const predicate: (error: ErrorA | ErrorB) => boolean

describe("Stream.catchIf", () => {
  it("supports refinement in data-last usage", () => {
    const result = pipe(
      stream,
      Stream.catchIf(
        (error): error is ErrorA => error._tag === "ErrorA",
        (error) => {
          expect(error).type.toBe<ErrorA>()
          return Stream.succeed("recovered")
        }
      )
    )
    expect(result).type.toBe<Stream.Stream<string, ErrorB, "dep-1">>()
  })

  it("supports refinement with orElse", () => {
    const result = pipe(
      stream,
      Stream.catchIf(
        (error): error is ErrorA => error._tag === "ErrorA",
        () => Stream.succeed(1),
        (error) => {
          expect(error).type.toBe<ErrorB>()
          return Stream.succeed(2)
        }
      )
    )
    expect(result).type.toBe<Stream.Stream<string | number, never, "dep-1">>()
  })

  it("supports predicate in data-first usage", () => {
    const result = Stream.catchIf(
      stream,
      predicate,
      (error) => {
        expect(error).type.toBe<ErrorA | ErrorB>()
        return Stream.succeed(0)
      }
    )
    expect(result).type.toBe<Stream.Stream<string | number, ErrorA | ErrorB, "dep-1">>()
  })
})
