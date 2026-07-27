import { SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual, throws } from "../../utils/assert.ts"

describe("fromJsonSchemaMultiDocument", () => {
  it("preserves root order and shares definitions", () => {
    const document = SchemaRepresentation.fromJsonSchemaMultiDocument({
      dialect: "draft-2020-12",
      schemas: [
        { $ref: "#/$defs/A" },
        { $ref: "#/$defs/A", description: "second" },
        { type: "array", items: { $ref: "#/$defs/A" } },
        { $ref: "#/$defs/A", description: "fourth" }
      ],
      definitions: {
        A: { type: "string", minLength: 1 }
      }
    })

    const definition = {
      _tag: "String" as const,
      checks: [{ _tag: "Filter" as const, meta: { _tag: "isMinLength" as const, minLength: 1 } }]
    }
    deepStrictEqual(document, {
      representations: [
        { _tag: "Reference", $ref: "A" },
        { ...definition, annotations: { description: "second" } },
        {
          _tag: "Arrays",
          elements: [],
          rest: [{ _tag: "Reference", $ref: "A" }],
          checks: []
        },
        { ...definition, annotations: { description: "fourth" } }
      ],
      references: { A: definition }
    })
  })

  it("resolves alias chains when combining a reference", () => {
    const document = SchemaRepresentation.fromJsonSchemaMultiDocument({
      dialect: "draft-2020-12",
      schemas: [{ $ref: "#/$defs/A", description: "root" }],
      definitions: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/C" },
        C: { type: "number" }
      }
    })

    deepStrictEqual(document, {
      representations: [{
        _tag: "Number",
        checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }],
        annotations: { description: "root" }
      }],
      references: {
        A: { _tag: "Reference", $ref: "B" },
        B: { _tag: "Reference", $ref: "C" },
        C: {
          _tag: "Number",
          checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }]
        }
      }
    })
  })

  it("tracks recursive definitions independently", () => {
    const document = SchemaRepresentation.fromJsonSchemaMultiDocument({
      dialect: "draft-2020-12",
      schemas: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
      definitions: {
        A: { $ref: "#/$defs/A" },
        B: { $ref: "#/$defs/B" }
      }
    })

    deepStrictEqual(document, {
      representations: [
        { _tag: "Reference", $ref: "A" },
        { _tag: "Reference", $ref: "B" }
      ],
      references: {
        A: { _tag: "Suspend", thunk: { _tag: "Reference", $ref: "A" }, checks: [] },
        B: { _tag: "Suspend", thunk: { _tag: "Reference", $ref: "B" }, checks: [] }
      }
    })
  })

  it("throws when a reference that must be resolved is missing", () => {
    throws(
      () =>
        SchemaRepresentation.fromJsonSchemaMultiDocument({
          dialect: "draft-2020-12",
          schemas: [{ $ref: "#/$defs/Missing", description: "resolve" }],
          definitions: {}
        }),
      "Reference Missing not found"
    )
  })

  it("throws when resolving a circular alias chain", () => {
    throws(
      () =>
        SchemaRepresentation.fromJsonSchemaMultiDocument({
          dialect: "draft-2020-12",
          schemas: [{ $ref: "#/$defs/A", description: "resolve" }],
          definitions: {
            A: { $ref: "#/$defs/B" },
            B: { $ref: "#/$defs/A" }
          }
        }),
      "Circular reference detected: A"
    )
  })
})
