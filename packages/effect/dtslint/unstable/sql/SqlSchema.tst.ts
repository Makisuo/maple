import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import { describe, expect, it } from "tstyche"

describe("SqlSchema", () => {
  it("findAll accepts Request type input", () => {
    const query = SqlSchema.findAll({
      Request: Schema.NumberFromString,
      Result: Schema.String,
      execute: (request) => {
        expect(request).type.toBe<string>()
        return Effect.succeed([request])
      }
    })

    query(1)
    // @ts-expect-error!
    query("1")
  })

  it("findNonEmpty accepts Request type input", () => {
    const query = SqlSchema.findNonEmpty({
      Request: Schema.NumberFromString,
      Result: Schema.String,
      execute: (request) => {
        expect(request).type.toBe<string>()
        return Effect.succeed([request])
      }
    })

    query(1)
    // @ts-expect-error!
    query("1")
  })

  it("findOne accepts Request type input", () => {
    const query = SqlSchema.findOne({
      Request: Schema.NumberFromString,
      Result: Schema.String,
      execute: (request) => {
        expect(request).type.toBe<string>()
        return Effect.succeed([request])
      }
    })

    query(1)
    // @ts-expect-error!
    query("1")
  })

  it("findOneOption accepts Request type input", () => {
    const query = SqlSchema.findOneOption({
      Request: Schema.NumberFromString,
      Result: Schema.String,
      execute: (request) => {
        expect(request).type.toBe<string>()
        return Effect.succeed([request])
      }
    })

    query(1)
    // @ts-expect-error!
    query("1")
  })

  it("void accepts Request type input", () => {
    const query = SqlSchema.void({
      Request: Schema.NumberFromString,
      execute: (request) => {
        expect(request).type.toBe<string>()
        return Effect.succeed(undefined)
      }
    })

    query(1)
    // @ts-expect-error!
    query("1")
  })
})
