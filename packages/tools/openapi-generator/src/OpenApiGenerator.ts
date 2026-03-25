import * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as ServiceMap from "effect/ServiceMap"
import * as String from "effect/String"
import type { OpenAPISpec, OpenAPISpecMethodName, OpenAPISpecPathItem } from "effect/unstable/httpapi/OpenApi"
import SwaggerToOpenApi from "swagger2openapi"
import * as JsonSchemaGenerator from "./JsonSchemaGenerator.ts"
import * as OpenApiTransformer from "./OpenApiTransformer.ts"
import * as ParsedOperation from "./ParsedOperation.ts"
import * as Utils from "./Utils.ts"

export class OpenApiGenerator extends ServiceMap.Service<
  OpenApiGenerator,
  { readonly generate: (spec: OpenAPISpec, options: OpenApiGenerateOptions) => Effect.Effect<string> }
>()("OpenApiGenerator") {}

export interface OpenApiGenerateOptions {
  /**
   * The name to give to the generated client.
   */
  readonly name: string
  /**
   * When `true`, will **only** generate types based on the provided OpenApi
   * specification (without corresponding schemas).
   */
  readonly typeOnly: boolean
  /**
   * Hook to transform each JSON Schema node before processing.
   */
  readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
}

const methodNames: ReadonlyArray<OpenAPISpecMethodName> = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
]

export const make = Effect.gen(function*() {
  const generate = Effect.fn(
    function*(spec: OpenAPISpec, options: OpenApiGenerateOptions) {
      const generator = JsonSchemaGenerator.make()
      const openApiTransformer = yield* OpenApiTransformer.OpenApiTransformer

      // If we receive a Swagger 2.0 spec, convert it to an OpenApi 3.0 spec
      if (isSwaggerSpec(spec)) {
        spec = yield* convertSwaggerSpec(spec)
      }

      function resolveRef(ref: string) {
        const parts = ref.split("/").slice(1)
        let current: any = spec
        for (const part of parts) {
          current = current[part]
        }
        return current
      }

      const operations: Array<ParsedOperation.ParsedOperation> = []

      function handlePath(path: string, methods: OpenAPISpecPathItem): void {
        for (const method of methodNames) {
          const operation = methods[method]

          if (Predicate.isUndefined(operation)) {
            continue
          }

          const id = operation.operationId
            ? Utils.camelize(operation.operationId)
            : `${method.toUpperCase()}${path}`

          const description = Utils.nonEmptyString(operation.description) ?? Utils.nonEmptyString(operation.summary)

          const { pathIds, pathTemplate } = processPath(path)

          const op = ParsedOperation.makeDeepMutable({
            id,
            method,
            description,
            pathIds,
            pathTemplate
          })

          const schemaId = Utils.identifier(operation.operationId ?? path)

          const validParameters = operation.parameters?.filter((param) => {
            return param.in !== "path" && param.in !== "cookie"
          }) ?? []

          if (validParameters.length > 0) {
            const schema = {
              type: "object" as JsonSchema.Type,
              properties: {} as Record<string, any>,
              required: [] as Array<string>,
              additionalProperties: false
            }

            for (let parameter of validParameters) {
              if ("$ref" in parameter) {
                parameter = resolveRef(parameter.$ref as string)
              }

              if (parameter.in === "path") {
                continue
              }

              const paramSchema = parameter.schema
              const added: Array<string> = []
              if ("properties" in paramSchema && Predicate.isObject(paramSchema.properties)) {
                const required = "required" in paramSchema
                  ? paramSchema.required as Array<string>
                  : []

                for (const [name, propSchema] of Object.entries(paramSchema.properties)) {
                  const adjustedName = `${parameter.name}[${name}]`
                  schema.properties[adjustedName] = propSchema
                  if (required.includes(name)) {
                    schema.required.push(adjustedName)
                  }
                  added.push(adjustedName)
                }
              } else {
                schema.properties[parameter.name] = parameter.schema
                if (parameter.required) {
                  schema.required.push(parameter.name)
                }
                added.push(parameter.name)
              }

              if (parameter.in === "query") {
                Utils.spreadElementsInto(added, op.urlParams)
              } else if (parameter.in === "header") {
                Utils.spreadElementsInto(added, op.headers)
              } else if (parameter.in === "cookie") {
                Utils.spreadElementsInto(added, op.cookies)
              }
            }

            op.params = generator.addSchema(
              `${schemaId}Params`,
              schema
            )

            op.paramsOptional = !schema.required || schema.required.length === 0
          }

          if (Predicate.isNotUndefined(operation.requestBody?.content?.["application/json"]?.schema)) {
            op.payload = generator.addSchema(
              `${schemaId}RequestJson`,
              operation.requestBody.content["application/json"].schema
            )
          }

          if (Predicate.isNotUndefined(operation.requestBody?.content?.["multipart/form-data"]?.schema)) {
            op.payload = generator.addSchema(
              `${schemaId}RequestFormData`,
              operation.requestBody.content["multipart/form-data"].schema
            )
            op.payloadFormData = true
          }

          let defaultSchema: string | undefined
          for (const entry of Object.entries(operation.responses ?? {})) {
            const status = entry[0]
            let response = entry[1]

            while ("$ref" in response) {
              response = resolveRef(response.$ref as string)
            }

            if (Predicate.isNotUndefined(response.content?.["application/json"]?.schema)) {
              const schemaName = generator.addSchema(
                `${schemaId}${status}`,
                response.content["application/json"].schema
              )

              if (status === "default") {
                defaultSchema = schemaName
                continue
              }

              const statusLower = status.toLowerCase()
              const statusMajorNumber = Number(status[0])
              if (Number.isNaN(statusMajorNumber)) {
                continue
              }
              if (statusMajorNumber < 4) {
                op.successSchemas.set(statusLower, schemaName)
              } else {
                op.errorSchemas.set(statusLower, schemaName)
              }
            }

            // Handle SSE streaming responses (text/event-stream)
            if (
              Predicate.isUndefined(op.sseSchema) &&
              Predicate.isNotUndefined(response.content?.["text/event-stream"]?.schema)
            ) {
              const statusMajorNumber = Number(status[0])
              if (!Number.isNaN(statusMajorNumber) && statusMajorNumber < 4) {
                op.sseSchema = generator.addSchema(
                  `${schemaId}${status}Sse`,
                  response.content["text/event-stream"].schema
                )
              }
            }

            // Handle binary streaming responses (application/octet-stream)
            if (Predicate.isNotUndefined(response.content?.["application/octet-stream"])) {
              const statusMajorNumber = Number(status[0])
              if (!Number.isNaN(statusMajorNumber) && statusMajorNumber < 4) {
                op.binaryResponse = true
              }
            }

            if (Predicate.isUndefined(response.content)) {
              if (status !== "default") {
                op.voidSchemas.add(status.toLowerCase())
              }
            }
          }

          if (op.successSchemas.size === 0 && Predicate.isNotUndefined(defaultSchema)) {
            op.successSchemas.set("2xx", defaultSchema)
          }

          operations.push(op)
        }
      }

      for (const [path, methods] of Object.entries(spec.paths)) {
        handlePath(path, methods)
      }

      // TODO: make a CLI option ?
      const importName = "Schema"
      const source = getDialect(spec)
      const generation = generator.generate(source, spec.components?.schemas ?? {}, options.typeOnly, {
        onEnter: options.onEnter
      })

      return String.stripMargin(
        `|${openApiTransformer.imports(importName, operations)}
         |${generation}
         |${openApiTransformer.toImplementation(importName, options.name, operations)}
         |
         |${openApiTransformer.toTypes(importName, options.name, operations)}`
      )
    },
    (effect, _, options) =>
      Effect.provideServiceEffect(
        effect,
        OpenApiTransformer.OpenApiTransformer,
        options.typeOnly
          ? Effect.sync(OpenApiTransformer.makeTransformerTs)
          : Effect.sync(OpenApiTransformer.makeTransformerSchema)
      )
  )

  return { generate } as const
})

function getDialect(spec: OpenAPISpec): "openapi-3.0" | "openapi-3.1" {
  return spec.openapi.trim().startsWith("3.0") ? "openapi-3.0" : "openapi-3.1"
}

export const layerTransformerSchema: Layer.Layer<OpenApiGenerator> = Layer.effect(OpenApiGenerator, make)

export const layerTransformerTs: Layer.Layer<OpenApiGenerator> = Layer.effect(OpenApiGenerator, make)

const isSwaggerSpec = (spec: OpenAPISpec) => "swagger" in spec

const convertSwaggerSpec = Effect.fn((spec: OpenAPISpec) =>
  Effect.callback<OpenAPISpec>((resume) => {
    SwaggerToOpenApi.convertObj(
      spec as any,
      { laxDefaults: true, laxurls: true, patch: true, warnOnly: true },
      (err, result) => {
        if (err) {
          resume(Effect.die(err))
        } else {
          resume(Effect.succeed(result.openapi as any))
        }
      }
    )
  }).pipe(Effect.withSpan("OpenApi.convertSwaggerSpec"))
)

const processPath = (path: string): {
  readonly pathIds: Array<string>
  readonly pathTemplate: string
} => {
  const pathIds: Array<string> = []
  path = path.replace(/{([^}]+)}/g, (_, name) => {
    const id = Utils.camelize(name)
    pathIds.push(id)
    return "${" + id + "}"
  })
  const pathTemplate = "`" + path + "`"
  return { pathIds, pathTemplate } as const
}
