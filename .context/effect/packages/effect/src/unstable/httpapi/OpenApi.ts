/**
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import type { NonEmptyArray } from "../../Array.ts"
import { constFalse } from "../../Function.ts"
import * as JsonPatch from "../../JsonPatch.ts"
import { escapeToken } from "../../JsonPointer.ts"
import * as JsonSchema from "../../JsonSchema.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as SchemaRepresentation from "../../SchemaRepresentation.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as HttpMethod from "../http/HttpMethod.ts"
import * as HttpApi from "./HttpApi.ts"
import * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"
import type { HttpApiSecurity } from "./HttpApiSecurity.ts"

/**
 * @since 4.0.0
 * @category annotations
 */
export class Identifier extends ServiceMap.Service<Identifier, string>()("effect/httpapi/OpenApi/Identifier") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Title extends ServiceMap.Service<Title, string>()("effect/httpapi/OpenApi/Title") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Version extends ServiceMap.Service<Version, string>()("effect/httpapi/OpenApi/Version") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Description extends ServiceMap.Service<Description, string>()("effect/httpapi/OpenApi/Description") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class License extends ServiceMap.Service<License, OpenAPISpecLicense>()("effect/httpapi/OpenApi/License") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class ExternalDocs
  extends ServiceMap.Service<ExternalDocs, OpenAPISpecExternalDocs>()("effect/httpapi/OpenApi/ExternalDocs")
{}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Servers
  extends ServiceMap.Service<Servers, ReadonlyArray<OpenAPISpecServer>>()("effect/httpapi/OpenApi/Servers")
{}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Format extends ServiceMap.Service<Format, string>()("effect/httpapi/OpenApi/Format") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Summary extends ServiceMap.Service<Summary, string>()("effect/httpapi/OpenApi/Summary") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Deprecated extends ServiceMap.Service<Deprecated, boolean>()("effect/httpapi/OpenApi/Deprecated") {}

/**
 * @since 4.0.0
 * @category annotations
 */
export class Override
  extends ServiceMap.Service<Override, Record<string, unknown>>()("effect/httpapi/OpenApi/Override")
{}

/**
 * @since 4.0.0
 * @category annotations
 */
export const Exclude = ServiceMap.Reference<boolean>("effect/httpapi/OpenApi/Exclude", {
  defaultValue: constFalse
})

/**
 * Transforms the generated OpenAPI specification
 *
 * @since 4.0.0
 * @category annotations
 */
export class Transform extends ServiceMap.Service<
  Transform,
  (openApiSpec: Record<string, any>) => Record<string, any>
>()("effect/httpapi/OpenApi/Transform") {}

const servicesPartial = <Tags extends Record<string, ServiceMap.Key<any, any> | ServiceMap.Key<never, any>>>(
  tags: Tags
): (
  options: {
    readonly [K in keyof Tags]?: ServiceMap.Service.Shape<Tags[K]> | undefined
  }
) => ServiceMap.ServiceMap<never> => {
  const entries = Object.entries(tags)
  return (options) => {
    let context = ServiceMap.empty()
    for (const [key, tag] of entries) {
      if (options[key] !== undefined) {
        context = ServiceMap.add(context, tag as any, options[key]!)
      }
    }
    return context
  }
}

/**
 * @since 4.0.0
 * @category annotations
 */
export const annotations: (
  options: {
    readonly identifier?: string | undefined
    readonly title?: string | undefined
    readonly version?: string | undefined
    readonly description?: string | undefined
    readonly license?: OpenAPISpecLicense | undefined
    readonly summary?: string | undefined
    readonly deprecated?: boolean | undefined
    readonly externalDocs?: OpenAPISpecExternalDocs | undefined
    readonly servers?: ReadonlyArray<OpenAPISpecServer> | undefined
    readonly format?: string | undefined
    readonly override?: Record<string, unknown> | undefined
    readonly exclude?: boolean | undefined
    readonly transform?: ((openApiSpec: Record<string, any>) => Record<string, any>) | undefined
  }
) => ServiceMap.ServiceMap<never> = servicesPartial({
  identifier: Identifier,
  title: Title,
  version: Version,
  description: Description,
  license: License,
  summary: Summary,
  deprecated: Deprecated,
  externalDocs: ExternalDocs,
  servers: Servers,
  format: Format,
  override: Override,
  exclude: Exclude,
  transform: Transform
})

const apiCache = new WeakMap<HttpApi.Any, OpenAPISpec>()

/**
 * This function checks if a given tag exists within the provided context. If
 * the tag is present, it retrieves the associated value and applies the given
 * callback function to it. If the tag is not found, the function does nothing.
 */
function processAnnotation<Services, S, I>(
  ctx: ServiceMap.ServiceMap<Services>,
  annotation: ServiceMap.Key<I, S>,
  f: (s: S) => void
) {
  const o = ServiceMap.getOption(ctx, annotation)
  if (Option.isSome(o)) {
    f(o.value)
  }
}

/**
 * Converts an `HttpApi` instance into an OpenAPI Specification object.
 *
 * **Details**
 *
 * This function takes an `HttpApi` instance, which defines a structured API,
 * and generates an OpenAPI Specification (`OpenAPISpec`). The resulting spec
 * adheres to the OpenAPI 3.1.0 standard and includes detailed metadata such as
 * paths, operations, security schemes, and components. The function processes
 * the API's annotations, middleware, groups, and endpoints to build a complete
 * and accurate representation of the API in OpenAPI format.
 *
 * The function also deduplicates schemas, applies transformations, and
 * integrates annotations like descriptions, summaries, external documentation,
 * and overrides. Cached results are used for better performance when the same
 * `HttpApi` instance is processed multiple times.
 *
 * **Options**
 *
 * - `additionalProperties`: Controls how additional properties are handled while resolving the JSON schema. Possible values include:
 *   - `false`: Disallow additional properties (default)
 *   - `true`: Allow additional properties
 *   - `JsonSchema`: Use the provided JSON Schema for additional properties
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromApi<Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly additionalProperties?: boolean | JsonSchema.JsonSchema | undefined
  } | undefined
): OpenAPISpec {
  const cached = apiCache.get(api)
  if (cached !== undefined) {
    return cached
  }
  let spec: OpenAPISpec = {
    openapi: "3.1.0",
    info: {
      title: "Api",
      version: "0.0.1"
    },
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {}
    },
    security: [],
    tags: []
  }

  const pathOps: Array<
    {
      readonly _tag: "schema"
      readonly ast: AST.AST
      readonly path: ReadonlyArray<string>
    } | {
      readonly _tag: "parameter"
      readonly ast: AST.AST
      readonly path: ReadonlyArray<string>
    }
  > = []

  processAnnotation(api.annotations, Title, (title) => {
    spec.info.title = title
  })
  processAnnotation(api.annotations, Version, (version) => {
    spec.info.version = version
  })
  processAnnotation(api.annotations, Description, (description) => {
    spec.info.description = description
  })
  processAnnotation(api.annotations, License, (license) => {
    spec.info.license = license
  })
  processAnnotation(api.annotations, Summary, (summary) => {
    spec.info.summary = summary
  })
  processAnnotation(api.annotations, Servers, (servers) => {
    spec.servers = [...servers]
  })

  HttpApi.reflect(api, {
    onGroup({ group }) {
      if (ServiceMap.get(group.annotations, Exclude)) {
        return
      }
      let tag: OpenAPISpecTag = {
        name: ServiceMap.getOrElse(group.annotations, Title, () => group.identifier)
      }
      processAnnotation(group.annotations, Description, (description) => {
        tag.description = description
      })
      processAnnotation(group.annotations, ExternalDocs, (externalDocs) => {
        tag.externalDocs = externalDocs
      })
      processAnnotation(group.annotations, Override, (override) => {
        Object.assign(tag, override)
      })
      processAnnotation(group.annotations, Transform, (transformFn) => {
        tag = transformFn(tag) as OpenAPISpecTag
      })

      spec.tags.push(tag)
    },
    onEndpoint({ endpoint, group, mergedAnnotations, middleware }) {
      if (ServiceMap.get(mergedAnnotations, Exclude)) {
        return
      }
      let op: OpenAPISpecOperation = {
        tags: [ServiceMap.getOrElse(group.annotations, Title, () => group.identifier)],
        operationId: ServiceMap.getOrElse(
          endpoint.annotations,
          Identifier,
          () => group.topLevel ? endpoint.name : `${group.identifier}.${endpoint.name}`
        ),
        parameters: [],
        security: [],
        responses: {}
      }

      const path = endpoint.path.replace(/:(\w+)\??/g, "{$1}")
      const method = endpoint.method.toLowerCase() as OpenAPISpecMethodName

      function processRequestBodies(payloadMap: HttpApiEndpoint.PayloadMap) {
        if (payloadMap.size > 0) {
          const c: OpenApiSpecContent = {}
          let hasContent = false
          payloadMap.forEach(({ encoding, schemas }, contentType) => {
            const filtered = schemas.filter((s) => !HttpApiSchema.isNoContent(s.ast))
            if (filtered.length === 0) return
            hasContent = true
            const asts = filtered.map(AST.getAST)
            const ast = asts.length === 1 ? asts[0] : new AST.Union(asts, "anyOf")
            pathOps.push({
              _tag: "schema",
              ast: toEncodingAST(ast, encoding._tag),
              path: ["paths", path, method, "requestBody", "content", contentType, "schema"]
            })
            c[contentType] = {
              schema: {}
            }
          })
          if (hasContent) {
            op.requestBody = { content: c, required: true }
          }
        }
      }

      function processResponseBodies(bodies: ResponseBodies, defaultDescription: () => string) {
        for (const [status, { content, descriptions }] of bodies) {
          const description = descriptions.size > 0 ? Array.from(descriptions).join(" | ") : defaultDescription()
          op.responses[status] = {
            description
          }
          if (content !== undefined) {
            content.forEach((map, encoding) => {
              map.forEach((schemas, contentType) => {
                const asts = Array.from(schemas, AST.getAST)
                const ast = asts.length === 1 ? asts[0] : new AST.Union(asts, "anyOf")

                pathOps.push({
                  _tag: "schema",
                  ast: toEncodingAST(ast, encoding),
                  path: ["paths", path, method, "responses", String(status), "content", contentType, "schema"]
                })
                op.responses[status].content ??= {}
                op.responses[status].content[contentType] = {
                  schema: {}
                }
              })
            })
          }
        }
      }

      function processParameters(schema: Schema.Top | undefined, i: OpenAPISpecParameter["in"]) {
        if (schema) {
          const ast = AST.getLastEncoding(schema.ast)
          if (AST.isObjects(ast)) {
            for (const ps of ast.propertySignatures) {
              op.parameters.push({
                name: String(ps.name),
                in: i,
                schema: {},
                required: i === "path" || !AST.isOptional(ps.type)
              })
              pathOps.push({
                _tag: "parameter",
                ast: ps.type,
                path: ["paths", path, method, "parameters", String(op.parameters.length - 1), "schema"]
              })
            }
          }
        }
      }

      processAnnotation(endpoint.annotations, Description, (description) => {
        op.description = description
      })
      processAnnotation(endpoint.annotations, Summary, (summary) => {
        op.summary = summary
      })
      processAnnotation(endpoint.annotations, Deprecated, (deprecated) => {
        op.deprecated = deprecated
      })
      processAnnotation(endpoint.annotations, ExternalDocs, (externalDocs) => {
        op.externalDocs = externalDocs
      })

      middleware.forEach((middleware) => {
        if (!HttpApiMiddleware.isSecurity(middleware)) {
          return
        }
        for (const [name, security] of Object.entries(middleware.security)) {
          processHttpApiSecurity(name, security)
          op.security.push({ [name]: [] })
        }
      })

      function processHttpApiSecurity(
        name: string,
        security: HttpApiSecurity
      ) {
        if (spec.components.securitySchemes[name] !== undefined) {
          return
        }
        spec.components.securitySchemes[name] = makeSecurityScheme(security)
      }

      const hasBody = HttpMethod.hasBody(endpoint.method)
      if (hasBody) {
        processRequestBodies(endpoint.payload)
      }

      processParameters(endpoint.params, "path")
      if (!hasBody && endpoint.payload.size === 1) {
        const entry = endpoint.payload.values().next().value!
        processParameters(entry.schemas[0], "query")
      }
      processParameters(endpoint.headers, "header")
      processParameters(endpoint.query, "query")

      processResponseBodies(
        extractResponseBodies(
          HttpApiEndpoint.getSuccessSchemas(endpoint),
          HttpApiSchema.getStatusSuccess,
          resolveDescriptionOrIdentifier
        ),
        () => "Success"
      )
      processResponseBodies(
        extractResponseBodies(
          HttpApiEndpoint.getErrorSchemas(endpoint),
          HttpApiSchema.getStatusError,
          resolveDescriptionOrIdentifier
        ),
        () => "Error"
      )

      if (!spec.paths[path]) {
        spec.paths[path] = {}
      }

      processAnnotation(endpoint.annotations, Override, (override) => {
        Object.assign(op, override)
      })
      processAnnotation(endpoint.annotations, Transform, (transformFn) => {
        op = transformFn(op) as OpenAPISpecOperation
      })

      spec.paths[path][method] = op
    }
  })

  processAnnotation(api.annotations, HttpApi.AdditionalSchemas, (componentSchemas) => {
    componentSchemas.forEach((componentSchema) => {
      const identifier = AST.resolveIdentifier(componentSchema.ast)
      if (identifier !== undefined) {
        if (identifier in spec.components.schemas) {
          throw new globalThis.Error(`Duplicate component schema identifier: ${identifier}`)
        }
        spec.components.schemas[identifier] = {}
        pathOps.push({
          _tag: "schema",
          ast: componentSchema.ast,
          path: ["components", "schemas", identifier]
        })
      }
    })
  })

  function escapePath(path: ReadonlyArray<string>): string {
    return "/" + path.map(escapeToken).join("/")
  }

  if (Arr.isArrayNonEmpty(pathOps)) {
    const multiDocument = SchemaRepresentation.fromASTs(
      Arr.map(pathOps, (op) => op.ast)
    )
    const jsonSchemaMultiDocument = JsonSchema.toMultiDocumentOpenApi3_1(
      SchemaRepresentation.toJsonSchemaMultiDocument(multiDocument, {
        additionalProperties: options?.additionalProperties
      })
    )
    const patchOps: Array<JsonPatch.JsonPatchOperation> = pathOps.map((op, i) => {
      const oppath = escapePath(op.path)
      const value = jsonSchemaMultiDocument.schemas[i]
      return {
        op: "replace",
        path: oppath,
        value: value as Schema.Json
      }
    })

    Object.entries(jsonSchemaMultiDocument.definitions).forEach(([name, definition]) => {
      patchOps.push({
        op: "add",
        path: escapePath(["components", "schemas", name]),
        value: definition as Schema.Json
      })
    })

    spec = JsonPatch.apply(patchOps, spec as any) as any
  }

  Object.keys(spec.components.schemas).forEach((key) => {
    if (!JsonSchema.VALID_OPEN_API_COMPONENTS_SCHEMAS_KEY_REGEXP.test(key)) {
      throw new globalThis.Error(`Invalid component schema key: ${key}`)
    }
  })

  processAnnotation(api.annotations, Override, (override) => {
    Object.assign(spec, override)
  })
  processAnnotation(api.annotations, Transform, (transformFn) => {
    spec = transformFn(spec) as OpenAPISpec
  })

  apiCache.set(api, spec)

  return spec
}

type ResponseBodies = Map<
  number, // status
  {
    descriptions: Set<string>
    content: Content | undefined // undefined means no content
  }
>

function extractResponseBodies(
  schemas: readonly [Schema.Top, ...Array<Schema.Top>],
  getStatus: (ast: AST.AST) => number,
  getDescription: (ast: AST.AST) => string | undefined
): ResponseBodies {
  const map = new Map<number, {
    descriptions: Set<string>
    content: Content | undefined
  }>()

  schemas.forEach(process)

  return map

  function process(schema: Schema.Top) {
    const ast = schema.ast
    const status = getStatus(ast)
    if (HttpApiSchema.isNoContent(ast)) {
      addNoContent(status, getDescription(schema.ast) ?? "<No Content>")
    } else {
      addContent(schema, status, HttpApiSchema.getResponseEncoding(ast))
    }
  }

  function addNoContent(status: number, description: string) {
    const statusMap = map.get(status)
    if (statusMap === undefined) {
      map.set(status, {
        descriptions: new Set([description]),
        content: undefined
      })
    } else {
      if (description !== undefined) {
        statusMap.descriptions.add(description)
      }
    }
  }

  function addContent(schema: Schema.Top, status: number, encoding: HttpApiSchema.Encoding) {
    const description = getDescription(schema.ast)
    const statusMap = map.get(status)
    const { _tag, contentType } = encoding
    if (statusMap === undefined) {
      map.set(status, {
        descriptions: new Set(description !== undefined ? [description] : []),
        content: new Map([[_tag, new Map([[contentType, new Set([schema])]])]])
      })
    } else {
      if (statusMap.content !== undefined) {
        // concat descriptions
        if (description !== undefined) {
          statusMap.descriptions.add(description)
        }

        const contentTypeMap = statusMap.content.get(_tag)
        if (contentTypeMap === undefined) {
          statusMap.content.set(_tag, new Map([[contentType, new Set([schema])]]))
        } else {
          const set = contentTypeMap.get(contentType)
          if (set === undefined) {
            contentTypeMap.set(contentType, new Set([schema]))
          } else {
            set.add(schema)
          }
        }
      }
    }
  }
}

function resolveDescriptionOrIdentifier(ast: AST.AST): string | undefined {
  return AST.resolveDescription(ast) ?? AST.resolveIdentifier(ast)
}

type Content = Map<
  HttpApiSchema.Encoding["_tag"],
  Map<
    string, // contentType
    Set<Schema.Top>
  >
>

const Uint8ArrayEncoding = Schema.String.annotate({
  format: "binary"
})

function toEncodingAST(ast: AST.AST, _tag: HttpApiSchema.Encoding["_tag"]): AST.AST {
  switch (_tag) {
    case "Uint8Array":
      return Uint8ArrayEncoding.ast
    case "Text":
      return Schema.String.ast
    case "FormUrlEncoded":
    case "Json":
      return ast
    case "Multipart":
      return persistedFileToBinaryEncoding(ast)
  }
}

function persistedFileToBinaryEncoding(ast: AST.AST): AST.AST {
  if (
    AST.isDeclaration(ast) &&
    ((ast.annotations as (Schema.Annotations.Declaration<unknown, readonly []> | undefined))?.typeConstructor?._tag ===
      "effect/http/PersistedFile")
  ) {
    return Uint8ArrayEncoding.ast
  }

  if (typeof (ast as any)?.recur === "function") {
    return (ast as any).recur(persistedFileToBinaryEncoding)
  }

  return ast
}

const makeSecurityScheme = (security: HttpApiSecurity): OpenAPISecurityScheme => {
  const meta: Partial<OpenAPISecurityScheme> = {}
  processAnnotation(security.annotations, Description, (description) => {
    meta.description = description
  })
  switch (security._tag) {
    case "Basic": {
      return {
        ...meta,
        type: "http",
        scheme: "basic"
      }
    }
    case "Bearer": {
      const format = ServiceMap.getOption(security.annotations, Format).pipe(
        Option.map((format) => ({ bearerFormat: format })),
        Option.getOrUndefined
      )
      return {
        ...meta,
        type: "http",
        scheme: "bearer",
        ...format
      }
    }
    case "ApiKey": {
      return {
        ...meta,
        type: "apiKey",
        name: security.key,
        in: security.in
      }
    }
  }
}

/**
 * This model describes the OpenAPI specification (version 3.1.0) returned by
 * {@link fromApi}. It is not intended to describe the entire OpenAPI
 * specification, only the output of `fromApi`.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpec {
  openapi: "3.1.0"
  info: OpenAPISpecInfo
  paths: OpenAPISpecPaths
  components: OpenAPIComponents
  security: Array<OpenAPISecurityRequirement>
  tags: Array<OpenAPISpecTag>
  servers?: Array<OpenAPISpecServer>
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecInfo {
  title: string
  version: string
  description?: string
  license?: OpenAPISpecLicense
  summary?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecTag {
  name: string
  description?: string
  externalDocs?: OpenAPISpecExternalDocs
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecExternalDocs {
  url: string
  description?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecLicense {
  name: string
  url?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecServer {
  url: string
  description?: string
  variables?: Record<string, OpenAPISpecServerVariable>
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecServerVariable {
  default: string
  enum?: NonEmptyArray<string>
  description?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecPaths = Record<string, OpenAPISpecPathItem>

/**
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecMethodName =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch"
  | "trace"

/**
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecPathItem = {
  [K in OpenAPISpecMethodName]?: OpenAPISpecOperation
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecParameter {
  name: string
  in: "query" | "header" | "path" | "cookie"
  schema: object
  required: boolean
  description?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecResponses = Record<number, OpenApiSpecResponse>

/**
 * @category models
 * @since 4.0.0
 */
export type OpenApiSpecContent = {
  [K in string]: OpenApiSpecMediaType
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenApiSpecResponse {
  description: string
  content?: OpenApiSpecContent
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenApiSpecMediaType {
  schema: JsonSchema.JsonSchema
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecRequestBody {
  content: OpenApiSpecContent
  required: true
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPIComponents {
  schemas: JsonSchema.Definitions
  securitySchemes: Record<string, OpenAPISecurityScheme>
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPIHTTPSecurityScheme {
  readonly type: "http"
  scheme: "bearer" | "basic" | string
  description?: string
  /* only for scheme: 'bearer' */
  bearerFormat?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPIApiKeySecurityScheme {
  readonly type: "apiKey"
  name: string
  in: "query" | "header" | "cookie"
  description?: string
}

/**
 * @category models
 * @since 4.0.0
 */
export type OpenAPISecurityScheme =
  | OpenAPIHTTPSecurityScheme
  | OpenAPIApiKeySecurityScheme

/**
 * @category models
 * @since 4.0.0
 */
export type OpenAPISecurityRequirement = Record<string, Array<string>>

/**
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecOperation {
  operationId: string
  parameters: Array<OpenAPISpecParameter>
  responses: OpenAPISpecResponses
  /** Always contains at least the title annotation or the group identifier */
  tags: NonEmptyArray<string>
  security: Array<OpenAPISecurityRequirement>
  requestBody?: OpenAPISpecRequestBody
  description?: string
  summary?: string
  deprecated?: boolean
  externalDocs?: OpenAPISpecExternalDocs
}
