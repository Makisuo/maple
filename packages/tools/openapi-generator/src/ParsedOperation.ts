import type * as Types from "effect/Types"
import type {
  OpenAPISecurityRequirement,
  OpenAPISpecExternalDocs,
  OpenAPISpecLicense,
  OpenAPISpecMethodName,
  OpenAPISpecServer
} from "effect/unstable/httpapi/OpenApi"

export interface ParsedOpenApiMetadata {
  readonly title: string
  readonly version: string
  readonly summary: string | undefined
  readonly description: string | undefined
  readonly license: OpenAPISpecLicense | undefined
  readonly servers: ReadonlyArray<OpenAPISpecServer> | undefined
}

export interface ParsedOpenApiTag {
  readonly name: string
  readonly description: string | undefined
  readonly externalDocs: OpenAPISpecExternalDocs | undefined
}

export interface ParsedOpenApiSecurityScheme {
  readonly name: string
  readonly type: "basic" | "bearer" | "apiKey"
  readonly description: string | undefined
  readonly bearerFormat: string | undefined
  readonly key: string | undefined
  readonly in: "header" | "query" | "cookie" | undefined
}

export interface ParsedOpenApi {
  readonly metadata: ParsedOpenApiMetadata
  readonly tags: ReadonlyArray<ParsedOpenApiTag>
  readonly securitySchemes: ReadonlyArray<ParsedOpenApiSecurityScheme>
  readonly operations: ReadonlyArray<ParsedOperation>
}

export interface ParsedOperationMetadata {
  readonly summary: string | undefined
  readonly description: string | undefined
  readonly deprecated: boolean
  readonly externalDocs: OpenAPISpecExternalDocs | undefined
}

export interface ParsedOperationParameter {
  readonly name: string
  readonly in: "path" | "query" | "header" | "cookie"
  readonly required: boolean
  readonly description: string | undefined
  readonly schema: {}
}

export interface ParsedOperationRequestBody {
  readonly required: boolean
  readonly contentTypes: Array<string>
}

export type ParsedOperationMediaTypeEncoding =
  | "json"
  | "multipart"
  | "form-url-encoded"
  | "text"
  | "binary"

export interface ParsedOperationMediaTypeSchema {
  readonly contentType: string
  readonly encoding: ParsedOperationMediaTypeEncoding
  readonly schema: string
}

export interface ParsedOperationResponse {
  readonly status: string
  readonly description: string | undefined
  readonly contentTypes: Array<string>
  readonly hasHeaders: boolean
  readonly isEmpty: boolean
  readonly representable: ReadonlyArray<ParsedOperationMediaTypeSchema>
}

export type ParsedOperationSecurityRequirement = Readonly<OpenAPISecurityRequirement>

export interface ParsedOperation {
  readonly id: string
  readonly operationId: string | undefined
  readonly path: string
  readonly method: OpenAPISpecMethodName
  readonly tags: ReadonlyArray<string>
  readonly metadata: ParsedOperationMetadata
  readonly parameters: {
    readonly path: ReadonlyArray<ParsedOperationParameter>
    readonly query: ReadonlyArray<ParsedOperationParameter>
    readonly header: ReadonlyArray<ParsedOperationParameter>
    readonly cookie: ReadonlyArray<ParsedOperationParameter>
  }
  readonly requestBody: ParsedOperationRequestBody | undefined
  readonly responses: ReadonlyArray<ParsedOperationResponse>
  readonly defaultResponse: ParsedOperationResponse | undefined
  readonly effectiveSecurity: ReadonlyArray<ParsedOperationSecurityRequirement>
  readonly description: string | undefined
  readonly params?: string
  readonly paramsOptional: boolean
  readonly urlParams: ReadonlyArray<string>
  readonly headers: ReadonlyArray<string>
  readonly cookies: ReadonlyArray<string>
  readonly payload?: string
  readonly payloadFormData: boolean
  readonly payloadFormUrlEncoded: boolean
  readonly pathSchema: string | undefined
  readonly querySchema: string | undefined
  readonly querySchemaOptional: boolean
  readonly headersSchema: string | undefined
  readonly headersSchemaOptional: boolean
  readonly requestBodyRepresentable: ReadonlyArray<ParsedOperationMediaTypeSchema>
  readonly pathIds: ReadonlyArray<string>
  readonly pathTemplate: string
  readonly successSchemas: ReadonlyMap<string, string>
  readonly errorSchemas: ReadonlyMap<string, string>
  readonly voidSchemas: ReadonlySet<string>
  // SSE streaming response schema (text/event-stream)
  readonly sseSchema?: string
  // Binary stream response (application/octet-stream)
  readonly binaryResponse: boolean
}

export const makeDeepMutable = (options: {
  readonly id: string
  readonly method: OpenAPISpecMethodName
  readonly pathIds: Array<string>
  readonly pathTemplate: string
  readonly description: string | undefined
}): Types.DeepMutable<ParsedOperation> => ({
  ...options,
  operationId: undefined,
  path: "",
  tags: [],
  metadata: {
    summary: undefined,
    description: options.description,
    deprecated: false,
    externalDocs: undefined
  },
  parameters: {
    path: [],
    query: [],
    header: [],
    cookie: []
  },
  requestBody: undefined,
  responses: [],
  defaultResponse: undefined,
  effectiveSecurity: [],
  urlParams: [],
  headers: [],
  cookies: [],
  payloadFormData: false,
  payloadFormUrlEncoded: false,
  pathSchema: undefined,
  querySchema: undefined,
  querySchemaOptional: true,
  headersSchema: undefined,
  headersSchemaOptional: true,
  requestBodyRepresentable: [],
  successSchemas: new Map(),
  errorSchemas: new Map(),
  voidSchemas: new Set(),
  paramsOptional: true,
  binaryResponse: false
})
