import * as JsonSchemaGenerator from "@effect/openapi-generator/JsonSchemaGenerator"
import { describe, expect, it } from "@effect/vitest"

describe("JsonSchemaGenerator", () => {
  it("schema & no definitions", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string" })
    const definitions = {}
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`// schemas
export type A = string
export const A = Schema.String
`)
  })

  it("schema & definitions", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { $ref: "#/components/schemas/B" })
    const definitions = {
      B: { type: "string" }
    }
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`// non-recursive definitions
export type B = string
export const B = Schema.String
// schemas
export type A = B
export const A = B
`)
  })

  it("onEnter strips specified keys", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string", description: "desc", examples: ["ex"] })
    const definitions = {}
    const result = generator.generate("openapi-3.1", definitions, false, {
      onEnter: (js) => {
        const out = { ...js }
        delete out.examples
        return out
      }
    })
    expect(result).toBe(`// schemas
export type A = string
export const A = Schema.String.annotate({ "description": "desc" })
`)
  })

  it("default preserves all annotations", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { type: "string", description: "desc", examples: ["ex"] })
    const definitions = {}
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`// schemas
export type A = string
export const A = Schema.String.annotate({ "description": "desc", "examples": ["ex"] })
`)
  })

  it("recursive schema", () => {
    const generator = JsonSchemaGenerator.make()
    generator.addSchema("A", { $ref: "#/components/schemas/B" })
    const definitions = {
      B: {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "children": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/B"
            }
          }
        },
        "required": [
          "name",
          "children"
        ],
        "additionalProperties": false
      }
    }
    const result = generator.generate("openapi-3.1", definitions, false)
    expect(result).toBe(`// recursive definitions
export type B = { readonly "name": string, readonly "children": ReadonlyArray<B> }
export const B = Schema.Struct({ "name": Schema.String, "children": Schema.Array(Schema.suspend((): Schema.Codec<B> => B)) })
// schemas
export type A = B
export const A = B
`)
  })
})
