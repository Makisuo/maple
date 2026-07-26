import * as SchemaRepresentation from "effect/SchemaRepresentation"

const doc = SchemaRepresentation.fromJsonSchemaDocument({
  "dialect": "draft-2020-12",
  "schema": {
    "type": "object",
    "properties": {
      "a": {
        "type": "string"
      }
    }
  },
  "definitions": {}
})

console.dir(doc, { depth: null })
