import type { Option } from "effect"
import { Schema } from "effect"
import { describe, expect, it } from "tstyche"

describe("resolveInto", () => {
  it("String", () => {
    const schema = Schema.String
    const annotations = Schema.resolveInto(schema)
    expect(annotations).type.toBe<Schema.Annotations.Bottom<string, readonly []> | undefined>()
    expect(annotations?.examples).type.toBe<ReadonlyArray<string> | undefined>()
  })

  it("URL", () => {
    const schema = Schema.URL
    const annotations = Schema.resolveInto(schema)
    expect(annotations).type.toBe<Schema.Annotations.Bottom<URL, readonly []> | undefined>()
  })

  it("Option(string)", () => {
    const schema = Schema.Option(Schema.String)
    const annotations = Schema.resolveInto(schema)
    expect(annotations).type.toBe<
      Schema.Annotations.Bottom<Option.Option<string>, readonly [Schema.String]> | undefined
    >()
  })
})
