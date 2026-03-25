import * as Schema from "../../../Schema.ts"
import type { CodecTransformer } from "../LanguageModel.ts"

/** @internal */
export const defaultCodecTransformer: CodecTransformer = (codec) => {
  const document = Schema.toJsonSchemaDocument(codec)
  const jsonSchema = document.schema
  if (Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions
  }
  return { codec, jsonSchema }
}
