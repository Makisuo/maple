import * as Arr from "effect/Array"
import * as JsonSchema from "effect/JsonSchema"
import * as Rec from "effect/Record"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

export function make() {
  const store: Record<string, JsonSchema.JsonSchema> = {}

  function addSchema(name: string, schema: JsonSchema.JsonSchema): string {
    if (name in store) {
      throw new Error(`Schema ${name} already exists`)
    }
    store[name] = schema
    return name
  }

  function generate(
    source: "openapi-3.0" | "openapi-3.1",
    components: JsonSchema.Definitions,
    typeOnly: boolean,
    options?: {
      readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
    }
  ) {
    const nameMap: Array<string> = []
    const schemas: Array<JsonSchema.JsonSchema> = []

    const definitions: JsonSchema.Definitions = Rec.map(
      components,
      (js) => fromSchemaOpenApi(js).schema
    )

    for (const [name, js] of Object.entries(store)) {
      nameMap.push(name)
      schemas.push(fromSchemaOpenApi(js).schema)
    }

    if (Arr.isArrayNonEmpty(schemas)) {
      const multiDocument: SchemaRepresentation.MultiDocument = SchemaRepresentation.fromJsonSchemaMultiDocument({
        dialect: "draft-2020-12",
        schemas,
        definitions
      }, {
        onEnter(js) {
          const out = { ...js }
          if (out.type === "object" && out.additionalProperties === undefined) {
            out.additionalProperties = false
          }
          return options?.onEnter?.(out) ?? out
        }
      })

      const codeDocument = SchemaRepresentation.toCodeDocument(multiDocument)

      const nonRecursives = codeDocument.references.nonRecursives.map(({ $ref, code }) => renderSchema($ref, code))
      const recursives = Object.entries(codeDocument.references.recursives).map(([$ref, code]) =>
        renderSchema($ref, code)
      )
      const codes = codeDocument.codes.map((code, i) => renderSchema(nameMap[i], code))

      const s = render("non-recursive definitions", nonRecursives) +
        render("recursive definitions", recursives) +
        render("schemas", codes)

      return s
    } else {
      return ""
    }

    function fromSchemaOpenApi(jsonSchema: JsonSchema.JsonSchema) {
      switch (source) {
        case "openapi-3.1":
          return JsonSchema.fromSchemaOpenApi3_1(jsonSchema)
        case "openapi-3.0":
          return JsonSchema.fromSchemaOpenApi3_0(jsonSchema)
      }
    }

    function renderSchema($ref: string, code: SchemaRepresentation.Code) {
      const strings = [`export type ${$ref} = ${code.Type}`]
      if (!typeOnly) {
        strings.push(`export const ${$ref} = ${code.runtime}`)
      }
      return strings.join("\n")
    }

    function render(title: string, as: ReadonlyArray<string>) {
      if (as.length === 0) return ""
      return "// " + title + "\n" + as.join("\n") + "\n"
    }
  }

  return { addSchema, generate } as const
}
