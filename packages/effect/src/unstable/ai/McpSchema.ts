/**
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import { constFalse, constTrue } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"
import type * as Scope from "../../Scope.ts"
import * as Rpc from "../rpc/Rpc.ts"
import type * as RpcClient from "../rpc/RpcClient.ts"
import type { RpcClientError } from "../rpc/RpcClientError.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import * as RpcMiddleware from "../rpc/RpcMiddleware.ts"

/**
 * @since 4.0.0
 */
export interface optionalWithDefault<S extends Schema.Top & Schema.WithoutConstructorDefault>
  extends Schema.withConstructorDefault<Schema.decodeTo<Schema.toType<Schema.optionalKey<S>>, Schema.optionalKey<S>>>
{}

/**
 * @since 4.0.0
 */
export const optionalWithDefault = <S extends Schema.Top & Schema.WithoutConstructorDefault>(
  schema: S,
  defaultValue: () => Schema.optionalKey<S>["Type"]
): optionalWithDefault<S> => {
  const effect = Effect.sync(defaultValue)
  return Schema.optionalKey(schema).pipe(
    Schema.decode<Schema.optionalKey<S>>({
      decode: Getter.withDefault(effect),
      encode: Getter.passthrough()
    }),
    Schema.withConstructorDefault<
      Schema.decodeTo<Schema.toType<Schema.optionalKey<S>>, Schema.optionalKey<S>>
    >(effect)
  )
}

/**
 * @since 4.0.0
 */
export const optional = <S extends Schema.Top>(schema: S): Schema.decodeTo<Schema.optional<S>, Schema.optionalKey<S>> =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: Getter.passthrough() as any,
      encode: Getter.transformOptional(Option.flatMap(Option.fromUndefinedOr))
    })
  )

// =============================================================================
// Common
// =============================================================================

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 *
 * @since 4.0.0
 * @category common
 */
export const RequestId: Schema.Union<[
  typeof Schema.String,
  typeof Schema.Number
]> = Schema.Union([Schema.String, Schema.Number])

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 *
 * @since 4.0.0
 * @category common
 */
export type RequestId = typeof RequestId.Type

/**
 * A progress token, used to associate progress notifications with the original
 * request.
 *
 * @since 4.0.0
 * @category common
 */
export const ProgressToken: Schema.Union<[
  typeof Schema.String,
  typeof Schema.Number
]> = Schema.Union([Schema.String, Schema.Number])

/**
 * A progress token, used to associate progress notifications with the original
 * request.
 *
 * @since 4.0.0
 * @category common
 */
export type ProgressToken = typeof ProgressToken.Type

/**
 * @since 4.0.0
 * @category common
 */
export class RequestMeta extends Schema.Opaque<RequestMeta>()(Schema.Struct({
  _meta: optional(Schema.Struct({
    /**
     * If specified, the caller is requesting out-of-band progress notifications
     * for this request (as represented by notifications/progress). The value of
     * this parameter is an opaque token that will be attached to any subsequent
     * notifications. The receiver is not obligated to provide these
     * notifications.
     */
    progressToken: optional(ProgressToken)
  }))
})) {}

/**
 * @since 4.0.0
 * @category common
 */
export class ResultMeta extends Schema.Opaque<ResultMeta>()(Schema.Struct({
  /**
   * This result property is reserved by the protocol to allow clients and
   * servers to attach additional metadata to their responses.
   */
  _meta: optional(Schema.Record(Schema.String, Schema.Json))
})) {}

/**
 * @since 4.0.0
 * @category common
 */
export class NotificationMeta extends Schema.Opaque<NotificationMeta>()(Schema.Struct({
  /**
   * This parameter name is reserved by MCP to allow clients and servers to
   * attach additional metadata to their notifications.
   */
  _meta: optional(Schema.Record(Schema.String, Schema.Json))
})) {}

/**
 * An opaque token used to represent a cursor for pagination.
 *
 * @since 4.0.0
 * @category common
 */
export const Cursor: typeof Schema.String = Schema.String

/**
 * @since 4.0.0
 * @category common
 */
export type Cursor = typeof Cursor.Type

/**
 * @since 4.0.0
 * @category common
 */
export class PaginatedRequestMeta extends Schema.Opaque<PaginatedRequestMeta>()(Schema.Struct({
  ...RequestMeta.fields,
  /**
   * An opaque token representing the current pagination position.
   * If provided, the server should return results starting after this cursor.
   */
  cursor: optional(Cursor)
})) {}

/**
 * @since 4.0.0
 * @category common
 */
export class PaginatedResultMeta extends Schema.Opaque<PaginatedResultMeta>()(Schema.Struct({
  ...ResultMeta.fields,
  /**
   * An opaque token representing the pagination position after the last returned result.
   * If present, there may be more results available.
   */
  nextCursor: optional(Cursor)
})) {}

/**
 * The sender or recipient of messages and data in a conversation.
 * @since 4.0.0
 * @category common
 */
export const Role: Schema.Literals<["user", "assistant"]> = Schema.Literals(["user", "assistant"])

/**
 * @since 4.0.0
 * @category common
 */
export type Role = typeof Role.Type

/**
 * Optional annotations for the client. The client can use annotations to
 * inform how objects are used or displayed
 *
 * @since 4.0.0
 * @category common
 */
export class Annotations extends Schema.Opaque<Annotations>()(Schema.Struct({
  /**
   * Describes who the intended customer of this object or data is.
   *
   * It can include multiple entries to indicate content useful for multiple
   * audiences (e.g., `["user", "assistant"]`).
   */
  audience: optional(Schema.Array(Role)),
  /**
   * Describes how important this data is for operating the server.
   *
   * A value of 1 means "most important," and indicates that the data is
   * effectively required, while 0 means "least important," and indicates that
   * the data is entirely optional.
   */
  priority: optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
})) {}

/**
 * Describes the name and version of an MCP implementation.
 *
 * @since 4.0.0
 * @category common
 */
export class Implementation extends Schema.Opaque<Implementation>()(Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  version: Schema.String
})) {}

/**
 * Capabilities a client may support. Known capabilities are defined here, in
 * this schema, but this is not a closed set: any client can define its own,
 * additional capabilities.
 *
 * @since 4.0.0
 * @category common
 */
export class ClientCapabilities extends Schema.Class<ClientCapabilities>(
  "@effect/ai/McpSchema/ClientCapabilities"
)({
  /**
   * Experimental, non-standard capabilities that the client supports.
   */
  experimental: optional(Schema.Record(Schema.String, Schema.Struct({}))),
  /**
   * Optional extensions capabilities advertised by the client.
   * Keys are extension identifiers following <vendor-prefix>/<extension-name> (e.g. "io.modelcontextprotocol/ui").
   */
  extensions: optional(Schema.Record(Schema.TemplateLiteral([Schema.String, "/", Schema.String]), Schema.Json)),
  /**
   * Present if the client supports listing roots.
   */
  roots: optional(Schema.Struct({
    /**
     * Whether the client supports notifications for changes to the roots list.
     */
    listChanged: optional(Schema.Boolean)
  })),
  /**
   * Present if the client supports sampling from an LLM.
   */
  sampling: optional(Schema.Struct({})),
  /**
   * Present if the client supports elicitation from the server.
   */
  elicitation: optional(Schema.Struct({}))
}) {}

/**
 * Capabilities that a server may support. Known capabilities are defined
 * here, in this schema, but this is not a closed set: any server can define
 * its own, additional capabilities.
 *
 * @since 4.0.0
 * @category common
 */
export class ServerCapabilities extends Schema.Opaque<ServerCapabilities>()(Schema.Struct({
  /**
   * Experimental, non-standard capabilities that the server supports.
   */
  experimental: optional(Schema.Record(Schema.String, Schema.Struct({}))),
  /**
   * Optional extensions capabilities advertised by the server.
   * Keys are extension identifiers following <vendor-prefix>/<extension-name> (e.g. "io.modelcontextprotocol/ui").
   */
  extensions: optional(Schema.Record(Schema.TemplateLiteral([Schema.String, "/", Schema.String]), Schema.Json)),
  /**
   * Present if the server supports sending log messages to the client.
   */
  logging: optional(Schema.Struct({})),
  /**
   * Present if the server supports argument autocompletion suggestions.
   */
  completions: optional(Schema.Struct({})),
  /**
   * Present if the server offers any prompt templates.
   */
  prompts: optional(Schema.Struct({
    /**
     * Whether this server supports notifications for changes to the prompt list.
     */
    listChanged: optional(Schema.Boolean)
  })),
  /**
   * Present if the server offers any resources to read.
   */
  resources: optional(Schema.Struct({
    /**
     * Whether this server supports subscribing to resource updates.
     */
    subscribe: optional(Schema.Boolean),
    /**
     * Whether this server supports notifications for changes to the resource list.
     */
    listChanged: optional(Schema.Boolean)
  })),
  /**
   * Present if the server offers any tools to call.
   */
  tools: optional(Schema.Struct({
    /**
     * Whether this server supports notifications for changes to the tool list.
     */
    listChanged: optional(Schema.Boolean)
  }))
})) {}

// =============================================================================
// Errors
// =============================================================================

/**
 * @since 4.0.0
 * @category errors
 */
export class McpErrorBase extends Schema.Class<McpErrorBase>(
  "@effect/ai/McpSchema/McpErrorBase"
)({
  /**
   * The error type that occurred.
   */
  code: Schema.Number,
  /**
   * A short description of the error. The message SHOULD be limited to a
   * concise single sentence.
   */
  message: Schema.String,
  /**
   * Additional information about the error. The value of this member is
   * defined by the sender (e.g. detailed error information, nested errors etc.).
   */
  data: optional(Schema.Any)
}) {}

/**
 * @since 4.0.0
 * @category errors
 */
export const INVALID_REQUEST_ERROR_CODE = -32600 as const
/**
 * @since 4.0.0
 * @category errors
 */
export const METHOD_NOT_FOUND_ERROR_CODE = -32601 as const
/**
 * @since 4.0.0
 * @category errors
 */
export const INVALID_PARAMS_ERROR_CODE = -32602 as const
/**
 * @since 4.0.0
 * @category errors
 */
export const INTERNAL_ERROR_CODE = -32603 as const
/**
 * @since 4.0.0
 * @category errors
 */
export const PARSE_ERROR_CODE = -32700 as const

/**
 * @since 4.0.0
 * @category errors
 */
export class ParseError extends Schema.ErrorClass<ParseError>("effect/ai/McpSchema/ParseError")({
  ...McpErrorBase.fields,
  _tag: Schema.tag("ParseError"),
  code: Schema.tag(PARSE_ERROR_CODE)
}) {}

/**
 * @since 4.0.0
 * @category errors
 */
export class InvalidRequest extends Schema.ErrorClass<InvalidRequest>("effect/ai/McpSchema/InvalidRequest")({
  ...McpErrorBase.fields,
  _tag: Schema.tag("InvalidRequest"),
  code: Schema.tag(INVALID_REQUEST_ERROR_CODE)
}) {}

/**
 * @since 4.0.0
 * @category errors
 */
export class MethodNotFound extends Schema.ErrorClass<MethodNotFound>("effect/ai/McpSchema/MethodNotFound")({
  ...McpErrorBase.fields,
  _tag: Schema.tag("MethodNotFound"),
  code: Schema.tag(METHOD_NOT_FOUND_ERROR_CODE)
}) {}

/**
 * @since 4.0.0
 * @category errors
 */
export class InvalidParams extends Schema.ErrorClass<InvalidParams>("effect/ai/McpSchema/InvalidParams")({
  ...McpErrorBase.fields,
  _tag: Schema.tag("InvalidParams"),
  code: Schema.tag(INVALID_PARAMS_ERROR_CODE)
}) {}

/**
 * @since 4.0.0
 * @category errors
 */
export class InternalError extends Schema.ErrorClass<InternalError>("effect/ai/McpSchema/InternalError")({
  ...McpErrorBase.fields,
  _tag: Schema.tag("InternalError"),
  code: Schema.tag(INTERNAL_ERROR_CODE)
}) {
  static readonly notImplemented = new InternalError({ message: "Not implemented" })
}

/**
 * @since 4.0.0
 * @category errors
 */
export const McpError = Schema.Union([
  ParseError,
  InvalidRequest,
  MethodNotFound,
  InvalidParams,
  InternalError,
  McpErrorBase
])

// =============================================================================
// Ping
// =============================================================================

/**
 * A ping, issued by either the server or the client, to check that the other
 * party is still alive. The receiver must promptly respond, or else may be
 * disconnected.
 *
 * @since 4.0.0
 * @category ping
 */
export class Ping extends Rpc.make("ping", {
  success: Schema.Struct({}),
  error: McpError,
  payload: Schema.UndefinedOr(RequestMeta)
}) {}

// =============================================================================
// Initialization
// =============================================================================

/**
 * After receiving an initialize request from the client, the server sends this
 * response.
 *
 * @since 4.0.0
 * @category initialization
 */
export class InitializeResult extends Schema.Opaque<InitializeResult>()(Schema.Struct({
  ...ResultMeta.fields,
  /**
   * The version of the Model Context Protocol that the server wants to use.
   * This may not match the version that the client requested. If the client
   * cannot support this version, it MUST disconnect.
   */
  protocolVersion: Schema.String,
  capabilities: ServerCapabilities,
  serverInfo: Implementation,
  /**
   * Instructions describing how to use the server and its features.
   *
   * This can be used by clients to improve the LLM's understanding of available
   * tools, resources, etc. It can be thought of like a "hint" to the model.
   * For example, this information MAY be added to the system prompt.
   */
  instructions: optional(Schema.String)
})) {}

/**
 * This request is sent from the client to the server when it first connects,
 * asking it to begin initialization.
 *
 * @since 4.0.0
 * @category initialization
 */
export class Initialize extends Rpc.make("initialize", {
  success: InitializeResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    /**
     * The latest version of the Model Context Protocol that the client
     * supports. The client MAY decide to support older versions as well.
     */
    protocolVersion: Schema.String,
    /**
     * Capabilities a client may support. Known capabilities are defined here,
     * in this schema, but this is not a closed set: any client can define its
     * own, additional capabilities.
     */
    capabilities: ClientCapabilities,
    /**
     * Describes the name and version of an MCP implementation.
     */
    clientInfo: Implementation
  }
}) {}

/**
 * This notification is sent from the client to the server after initialization
 * has finished.
 *
 * @since 4.0.0
 * @category initialization
 */
export class InitializedNotification extends Rpc.make("notifications/initialized", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

// =============================================================================
// Cancellation
// =============================================================================

/**
 * @since 4.0.0
 * @category cancellation
 */
export class CancelledNotification extends Rpc.make("notifications/cancelled", {
  payload: {
    ...NotificationMeta.fields,
    /**
     * The ID of the request to cancel.
     *
     * This MUST correspond to the ID of a request previously issued in the
     * same direction.
     */
    requestId: RequestId,
    /**
     * An optional string describing the reason for the cancellation. This MAY
     * be logged or presented to the user.
     */
    reason: optional(Schema.String)
  }
}) {}

// =============================================================================
// Progress
// =============================================================================

/**
 * An out-of-band notification used to inform the receiver of a progress update
 * for a long-running request.
 *
 * @since 4.0.0
 * @category progress
 */
export class ProgressNotification extends Rpc.make("notifications/progress", {
  payload: {
    ...NotificationMeta.fields,
    /**
     * The progress token which was given in the initial request, used to
     * associate this notification with the request that is proceeding.
     */
    progressToken: ProgressToken,
    /**
     * The progress thus far. This should increase every time progress is made,
     * even if the total is unknown.
     */
    progress: optional(Schema.Number),
    /**
     * Total number of items to process (or total progress required), if known.
     */
    total: optional(Schema.Number),
    /**
     * An optional message describing the current progress.
     */
    message: optional(Schema.String)
  }
}) {}

// =============================================================================
// Resources
// =============================================================================

/**
 * A known resource that the server is capable of reading.
 *
 * @since 4.0.0
 * @category resources
 */
export class Resource extends Schema.Class<Resource>(
  "@effect/ai/McpSchema/Resource"
)({
  /**
   * The URI of this resource.
   */
  uri: Schema.String,
  /**
   * A human-readable name for this resource.
   *
   * This can be used by clients to populate UI elements.
   */
  name: Schema.String,
  title: optional(Schema.String),
  /**
   * A description of what this resource represents.
   *
   * This can be used by clients to improve the LLM's understanding of available
   * resources. It can be thought of like a "hint" to the model.
   */
  description: optional(Schema.String),
  /**
   * The MIME type of this resource, if known.
   */
  mimeType: optional(Schema.String),
  /**
   * Optional annotations for the client.
   */
  annotations: optional(Annotations),
  /**
   * The size of the raw resource content, in bytes (i.e., before base64
   * encoding or any tokenization), if known.
   *
   * This can be used by Hosts to display file sizes and estimate context
   * window usage.
   */
  size: optional(Schema.Number),
  /**
   * Optional additional metadata for the client.
   *
   * This parameter name is reserved by MCP to allow clients and servers to
   * attach additional metadata to resources.
   */
  _meta: optional(Schema.Record(Schema.String, Schema.Json))
}) {}

/**
 * A template description for resources available on the server.
 *
 * @since 4.0.0
 * @category resources
 */
export class ResourceTemplate extends Schema.Class<ResourceTemplate>(
  "@effect/ai/McpSchema/ResourceTemplate"
)({
  /**
   * A URI template (according to RFC 6570) that can be used to construct
   * resource URIs.
   */
  uriTemplate: Schema.String,
  /**
   * A human-readable name for the type of resource this template refers to.
   *
   * This can be used by clients to populate UI elements.
   */
  name: Schema.String,
  title: optional(Schema.String),
  /**
   * A description of what this template is for.
   *
   * This can be used by clients to improve the LLM's understanding of available
   * resources. It can be thought of like a "hint" to the model.
   */
  description: optional(Schema.String),

  /**
   * The MIME type for all resources that match this template. This should only
   * be included if all resources matching this template have the same type.
   */
  mimeType: optional(Schema.String),

  /**
   * Optional annotations for the client.
   */
  annotations: optional(Annotations),

  /**
   * Optional additional metadata for the client.
   */
  _meta: optional(Schema.Record(Schema.String, Schema.Json))
}) {}

/**
 * The contents of a specific resource or sub-resource.
 *
 * @since 4.0.0
 * @category resources
 */
export class ResourceContents extends Schema.Opaque<ResourceContents>()(Schema.Struct({
  /**
   * The URI of this resource.
   */
  uri: Schema.String,
  /**
   * The MIME type of this resource, if known.
   */
  mimeType: optional(Schema.String),
  /**
   * Optional additional metadata for the client.
   */
  _meta: optional(Schema.Record(Schema.String, Schema.Json))
})) {}

/**
 * The contents of a text resource, which can be represented as a string.
 *
 * @since 4.0.0
 * @category resources
 */
export class TextResourceContents extends Schema.Opaque<TextResourceContents>()(Schema.Struct({
  ...ResourceContents.fields,
  /**
   * The text of the item. This must only be set if the item can actually be
   * represented as text (not binary data).
   */
  text: Schema.String
})) {}

/**
 * The contents of a binary resource, which can be represented as an Uint8Array
 *
 * @since 4.0.0
 * @category resources
 */
export class BlobResourceContents extends Schema.Opaque<BlobResourceContents>()(Schema.Struct({
  ...ResourceContents.fields,
  /**
   * The binary data of the item decoded from a base64-encoded string.
   */
  blob: Schema.Uint8Array
})) {}

/**
 * The server's response to a resources/list request from the client.
 *
 * @since 4.0.0
 * @category resources
 */
export class ListResourcesResult extends Schema.Class<ListResourcesResult>(
  "@effect/ai/McpSchema/ListResourcesResult"
)({
  ...PaginatedResultMeta.fields,
  resources: Schema.Array(Resource)
}) {}

/**
 * Sent from the client to request a list of resources the server has.
 *
 * @since 4.0.0
 * @category resources
 */
export class ListResources extends Rpc.make("resources/list", {
  success: ListResourcesResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequestMeta)
}) {}

/**
 * The server's response to a resources/templates/list request from the client.
 *
 * @since 4.0.0
 * @category resources
 */
export class ListResourceTemplatesResult extends Schema.Class<ListResourceTemplatesResult>(
  "@effect/ai/McpSchema/ListResourceTemplatesResult"
)({
  ...PaginatedResultMeta.fields,
  resourceTemplates: Schema.Array(ResourceTemplate)
}) {}

/**
 * Sent from the client to request a list of resource templates the server has.
 *
 * @since 4.0.0
 * @category resources
 */
export class ListResourceTemplates extends Rpc.make("resources/templates/list", {
  success: ListResourceTemplatesResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequestMeta)
}) {}

/**
 * The server's response to a resources/read request from the client.
 *
 * @since 4.0.0
 * @category resources
 */
export class ReadResourceResult extends Schema.Opaque<ReadResourceResult>()(Schema.Struct({
  ...ResultMeta.fields,
  contents: Schema.Array(Schema.Union([TextResourceContents, BlobResourceContents]))
})) {}

/**
 * Sent from the client to the server, to read a specific resource URI.
 *
 * @since 4.0.0
 * @category resources
 */
export class ReadResource extends Rpc.make("resources/read", {
  success: ReadResourceResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    /**
     * The URI of the resource to read. The URI can use any protocol; it is up
     * to the server how to interpret it.
     */
    uri: Schema.String
  }
}) {}

/**
 * An optional notification from the server to the client, informing it that the
 * list of resources it can read from has changed. This may be issued by servers
 * without any previous subscription from the client.
 *
 * @since 4.0.0
 * @category resources
 */
export class ResourceListChangedNotification extends Rpc.make("notifications/resources/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

/**
 * Sent from the client to request resources/updated notifications from the
 * server whenever a particular resource changes.
 *
 * @since 4.0.0
 * @category resources
 */
export class Subscribe extends Rpc.make("resources/subscribe", {
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    /**
     * The URI of the resource to subscribe to. The URI can use any protocol;
     * it is up to the server how to interpret it.
     */
    uri: Schema.String
  }
}) {}

/**
 * Sent from the client to request cancellation of resources/updated
 * notifications from the server. This should follow a previous
 * resources/subscribe request.
 *
 * @since 4.0.0
 * @category resources
 */
export class Unsubscribe extends Rpc.make("resources/unsubscribe", {
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    /**
     * The URI of the resource to subscribe to. The URI can use any protocol;
     * it is up to the server how to interpret it.
     */
    uri: Schema.String
  }
}) {}

/**
 * @since 4.0.0
 * @category resources
 */
export class ResourceUpdatedNotification extends Rpc.make("notifications/resources/updated", {
  payload: {
    ...NotificationMeta.fields,
    /**
     * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
     */
    uri: Schema.String
  }
}) {}

// =============================================================================
// Prompts
// =============================================================================

/**
 * Describes an argument that a prompt can accept.
 *
 * @since 4.0.0
 * @category prompts
 */
export class PromptArgument extends Schema.Opaque<PromptArgument>()(Schema.Struct({
  /**
   * The name of the argument.
   */
  name: Schema.String,
  title: optional(Schema.String),
  /**
   * A human-readable description of the argument.
   */
  description: optional(Schema.String),
  /**
   * Whether this argument must be provided.
   */
  required: optional(Schema.Boolean)
})) {}

/**
 * A prompt or prompt template that the server offers.
 *
 * @since 4.0.0
 * @category prompts
 */
export class Prompt extends Schema.Class<Prompt>(
  "@effect/ai/McpSchema/Prompt"
)({
  /**
   * The name of the prompt or prompt template.
   */
  name: Schema.String,
  title: optional(Schema.String),
  /**
   * An optional description of what this prompt provides
   */
  description: optional(Schema.String),
  /**
   * A list of arguments to use for templating the prompt.
   */
  arguments: optional(Schema.Array(PromptArgument))
}) {}

/**
 * Text provided to or from an LLM.
 *
 * @since 4.0.0
 * @category prompts
 */
export class TextContent extends Schema.Opaque<TextContent>()(Schema.Struct({
  type: Schema.tag("text"),
  /**
   * The text content of the message.
   */
  text: Schema.String,
  /**
   * Optional annotations for the client.
   */
  annotations: optional(Annotations)
})) {}

/**
 * An image provided to or from an LLM.
 *
 * @since 4.0.0
 * @category prompts
 */
export class ImageContent extends Schema.Opaque<ImageContent>()(Schema.Struct({
  type: Schema.tag("image"),
  /**
   * The image data.
   */
  data: Schema.Uint8Array,
  /**
   * The MIME type of the image. Different providers may support different
   * image types.
   */
  mimeType: Schema.String,
  /**
   * Optional annotations for the client.
   */
  annotations: optional(Annotations)
})) {}

/**
 * Audio provided to or from an LLM.
 *
 * @since 4.0.0
 * @category prompts
 */
export class AudioContent extends Schema.Opaque<AudioContent>()(Schema.Struct({
  type: Schema.tag("audio"),
  /**
   * The audio data.
   */
  data: Schema.Uint8Array,
  /**
   * The MIME type of the audio. Different providers may support different
   * audio types.
   */
  mimeType: Schema.String,
  /**
   * Optional annotations for the client.
   */
  annotations: optional(Annotations)
})) {}

/**
 * The contents of a resource, embedded into a prompt or tool call result.
 *
 * It is up to the client how best to render embedded resources for the benefit
 * of the LLM and/or the user.
 *
 * @since 4.0.0
 * @category prompts
 */
export class EmbeddedResource extends Schema.Opaque<EmbeddedResource>()(Schema.Struct({
  type: Schema.tag("resource"),
  resource: Schema.Union([TextResourceContents, BlobResourceContents]),
  /**
   * Optional annotations for the client.
   */
  annotations: optional(Annotations)
})) {}

/**
 * A resource that the server is capable of reading, included in a prompt or tool call result.
 *
 * Note: resource links returned by tools are not guaranteed to appear in the results of `resources/list` requests.
 *
 * @since 4.0.0
 * @category prompts
 */
export class ResourceLink extends Schema.Opaque<ResourceLink>()(Schema.Struct({
  ...Resource.fields,
  type: Schema.tag("resource_link")
})) {}

/**
 * @since 4.0.0
 * @category prompts
 */
export const ContentBlock = Schema.Union([
  TextContent,
  ImageContent,
  AudioContent,
  EmbeddedResource,
  ResourceLink
])

/**
 * Describes a message returned as part of a prompt.
 *
 * This is similar to `SamplingMessage`, but also supports the embedding of
 * resources from the MCP server.
 *
 * @since 4.0.0
 * @category prompts
 */
export class PromptMessage extends Schema.Opaque<PromptMessage>()(Schema.Struct({
  role: Role,
  content: ContentBlock
})) {}

/**
 * The server's response to a prompts/list request from the client.
 *
 * @since 4.0.0
 * @category prompts
 */
export class ListPromptsResult extends Schema.Class<ListPromptsResult>(
  "@effect/ai/McpSchema/ListPromptsResult"
)({
  ...PaginatedResultMeta.fields,
  prompts: Schema.Array(Prompt)
}) {}

/**
 * Sent from the client to request a list of prompts and prompt templates the
 * server has.
 *
 * @since 4.0.0
 * @category prompts
 */
export class ListPrompts extends Rpc.make("prompts/list", {
  success: ListPromptsResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequestMeta)
}) {}

/**
 * The server's response to a prompts/get request from the client.
 *
 * @since 4.0.0
 * @category prompts
 */
export class GetPromptResult extends Schema.Class<GetPromptResult>(
  "@effect/ai/McpSchema/GetPromptResult"
)({
  ...ResultMeta.fields,
  messages: Schema.Array(PromptMessage),
  /**
   * An optional description for the prompt.
   */
  description: optional(Schema.String)
}) {}

/**
 * Used by the client to get a prompt provided by the server.
 *
 * @since 4.0.0
 * @category prompts
 */
export class GetPrompt extends Rpc.make("prompts/get", {
  success: GetPromptResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    /**
     * The name of the prompt or prompt template.
     */
    name: Schema.String,
    title: optional(Schema.String),
    /**
     * Arguments to use for templating the prompt.
     */
    arguments: optional(Schema.Record(Schema.String, Schema.String))
  }
}) {}

/**
 * An optional notification from the server to the client, informing it that
 * the list of prompts it offers has changed. This may be issued by servers
 * without any previous subscription from the client.
 *
 * @since 4.0.0
 * @category prompts
 */
export class PromptListChangedNotification extends Rpc.make("notifications/prompts/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

// =============================================================================
// Tools
// =============================================================================

/**
 * Additional properties describing a Tool to clients.
 *
 * NOTE: all properties in ToolAnnotations are **hints**. They are not
 * guaranteed to provide a faithful description of tool behavior (including
 * descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on ToolAnnotations
 * received from untrusted servers.
 *
 * @since 4.0.0
 * @category tools
 */
export class ToolAnnotations extends Schema.Opaque<ToolAnnotations>()(Schema.Struct({
  /**
   * A human-readable title for the tool.
   */
  title: optional(Schema.String),
  /**
   * If true, the tool does not modify its environment.
   *
   * Default: `false`
   */
  readOnlyHint: optionalWithDefault(Schema.Boolean, constFalse),
  /**
   * If true, the tool may perform destructive updates to its environment.
   * If false, the tool performs only additive updates.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: `true`
   */
  destructiveHint: optionalWithDefault(Schema.Boolean, constTrue),
  /**
   * If true, calling the tool repeatedly with the same arguments
   * will have no additional effect on the its environment.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: `false`
   */
  idempotentHint: optionalWithDefault(Schema.Boolean, constFalse),
  /**
   * If true, this tool may interact with an "open world" of external
   * entities. If false, the tool's domain of interaction is closed.
   * For example, the world of a web search tool is open, whereas that
   * of a memory tool is not.
   *
   * Default: `true`
   */
  openWorldHint: optionalWithDefault(Schema.Boolean, constTrue)
})) {}

/**
 * Definition for a tool the client can call.
 *
 * @since 4.0.0
 * @category tools
 */
export class Tool extends Schema.Class<Tool>(
  "@effect/ai/McpSchema/Tool"
)({
  /**
   * The name of the tool.
   */
  name: Schema.String,
  title: optional(Schema.String),
  /**
   * A human-readable description of the tool.
   *
   * This can be used by clients to improve the LLM's understanding of available tools. It can be thought of like a "hint" to the model.
   */
  description: optional(Schema.String),
  /**
   * A JSON Schema object defining the expected parameters for the tool.
   */
  inputSchema: Schema.Any,
  /**
   * Optional additional tool information.
   */
  annotations: optional(ToolAnnotations),
  /**
   * Optional additional metadata for the client.
   *
   * This parameter name is reserved by MCP to allow clients and servers to
   * attach additional metadata to resources.
   */
  _meta: optional(Schema.Record(Schema.String, Schema.Json))
}) {}

/**
 * The server's response to a tools/list request from the client.
 *
 * @since 4.0.0
 * @category tools
 */
export class ListToolsResult extends Schema.Class<ListToolsResult>(
  "@effect/ai/McpSchema/ListToolsResult"
)({
  ...PaginatedResultMeta.fields,
  tools: Schema.Array(Tool)
}) {}

/**
 * Sent from the client to request a list of tools the server has.
 *
 * @since 4.0.0
 * @category tools
 */
export class ListTools extends Rpc.make("tools/list", {
  success: ListToolsResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequestMeta)
}) {}

/**
 * The server's response to a tool call.
 *
 * Any errors that originate from the tool SHOULD be reported inside the result
 * object, with `isError` set to true, _not_ as an MCP protocol-level error
 * response. Otherwise, the LLM would not be able to see that an error occurred
 * and self-correct.
 *
 * However, any errors in _finding_ the tool, an error indicating that the
 * server does not support tool calls, or any other exceptional conditions,
 * should be reported as an MCP error response.
 *
 * @since 4.0.0
 * @category tools
 */
export class CallToolResult extends Schema.Class<CallToolResult>("@effect/ai/McpSchema/CallToolResult")({
  ...ResultMeta.fields,
  content: Schema.Array(ContentBlock),
  structuredContent: optional(Schema.Any),
  /**
   * Whether the tool call ended in an error.
   *
   * If not set, this is assumed to be false (the call was successful).
   */
  isError: optional(Schema.Boolean)
}) {}

/**
 * Used by the client to invoke a tool provided by the server.
 *
 * @since 4.0.0
 * @category tools
 */
export class CallTool extends Rpc.make("tools/call", {
  success: CallToolResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    name: Schema.String,
    arguments: Schema.Record(
      Schema.String,
      Schema.Any
    )
  }
}) {}

/**
 * An optional notification from the server to the client, informing it that
 * the list of tools it offers has changed. This may be issued by servers
 * without any previous subscription from the client.
 *
 * @since 4.0.0
 * @category tools
 */
export class ToolListChangedNotification extends Rpc.make("notifications/tools/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

// =============================================================================
// Logging
// =============================================================================

/**
 * The severity of a log message.
 *
 * These map to syslog message severities, as specified in RFC-5424:
 * https://datatracker.ietf.org/doc/html/rfc5424#section-6.2.1
 *
 * @since 4.0.0
 * @category logging
 */
export const LoggingLevel: Schema.Literals<[
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency"
]> = Schema.Literals([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency"
])

/**
 * The severity of a log message.
 *
 * These map to syslog message severities, as specified in RFC-5424:
 * https://datatracker.ietf.org/doc/html/rfc5424#section-6.2.1
 *
 * @since 4.0.0
 * @category logging
 */
export type LoggingLevel = typeof LoggingLevel.Type

/**
 * A request from the client to the server, to enable or adjust logging.
 *
 * @since 4.0.0
 * @category logging
 */
export class SetLevel extends Rpc.make("logging/setLevel", {
  payload: {
    ...RequestMeta.fields,
    /**
     * The level of logging that the client wants to receive from the server.
     * The server should send all logs at this level and higher (i.e., more
     * severe) to the client as notifications/message.
     */
    level: LoggingLevel
  },
  error: McpError
}) {}

/**
 * @since 4.0.0
 * @category logging
 */
export class LoggingMessageNotification extends Rpc.make("notifications/message", {
  payload: Schema.Struct({
    ...NotificationMeta.fields,
    /**
     * The severity of this log message.
     */
    level: LoggingLevel,
    /**
     * An optional name of the logger issuing this message.
     */
    logger: optional(Schema.String),
    /**
     * The data to be logged, such as a string message or an object. Any JSON
     * serializable type is allowed here.
     */
    data: Schema.Any
  })
}) {}

// =============================================================================
// Sampling
// =============================================================================

/**
 * Describes a message issued to or received from an LLM API.
 *
 * @since 4.0.0
 * @category sampling
 */
export class SamplingMessage extends Schema.Opaque<SamplingMessage>()(Schema.Struct({
  role: Role,
  content: Schema.Union([TextContent, ImageContent, AudioContent])
})) {}

/**
 * Hints to use for model selection.
 *
 * Keys not declared here are currently left unspecified by the spec and are up
 * to the client to interpret.
 *
 * @since 4.0.0
 * @category sampling
 */
export class ModelHint extends Schema.Opaque<ModelHint>()(Schema.Struct({
  /**
   * A hint for a model name.
   *
   * The client SHOULD treat this as a substring of a model name; for example:
   *  - `claude-3-5-sonnet` should match `claude-3-5-sonnet-20241022`
   *  - `sonnet` should match `claude-3-5-sonnet-20241022`, `claude-3-sonnet-20240229`, etc.
   *  - `claude` should match any Claude model
   *
   * The client MAY also map the string to a different provider's model name or
   * a different model family, as long as it fills a similar niche; for example:
   *  - `gemini-1.5-flash` could match `claude-3-haiku-20240307`
   */
  name: optional(Schema.String)
})) {}

/**
 * The server's preferences for model selection, requested of the client during sampling.
 *
 * Because LLMs can vary along multiple dimensions, choosing the "best" model is
 * rarely straightforward.  Different models excel in different areas—some are
 * faster but less capable, others are more capable but more expensive, and so
 * on. This interface allows servers to express their priorities across multiple
 * dimensions to help clients make an appropriate selection for their use case.
 *
 * These preferences are always advisory. The client MAY ignore them. It is also
 * up to the client to decide how to interpret these preferences and how to
 * balance them against other considerations.
 *
 * @since 4.0.0
 * @category sampling
 */
export class ModelPreferences extends Schema.Class<ModelPreferences>(
  "@effect/ai/McpSchema/ModelPreferences"
)({
  /**
   * Optional hints to use for model selection.
   *
   * If multiple hints are specified, the client MUST evaluate them in order
   * (such that the first match is taken).
   *
   * The client SHOULD prioritize these hints over the numeric priorities, but
   * MAY still use the priorities to select from ambiguous matches.
   */
  hints: optional(Schema.Array(ModelHint)),
  /**
   * How much to prioritize cost when selecting a model. A value of 0 means cost
   * is not important, while a value of 1 means cost is the most important
   * factor.
   */
  costPriority: optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /**
   * How much to prioritize sampling speed (latency) when selecting a model. A
   * value of 0 means speed is not important, while a value of 1 means speed is
   * the most important factor.
   */
  speedPriority: optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /**
   * How much to prioritize intelligence and capabilities when selecting a
   * model. A value of 0 means intelligence is not important, while a value of 1
   * means intelligence is the most important factor.
   */
  intelligencePriority: optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
}) {}

/**
 * The client's response to a sampling/create_message request from the server.
 * The client should inform the user before returning the sampled message, to
 * allow them to inspect the response (human in the loop) and decide whether to
 * allow the server to see it.
 *
 * @since 4.0.0
 * @category sampling
 */
export class CreateMessageResult extends Schema.Class<CreateMessageResult>(
  "@effect/ai/McpSchema/CreateMessageResult"
)({
  /**
   * The name of the model that generated the message.
   */
  model: Schema.String,
  /**
   * The reason why sampling stopped, if known.
   */
  stopReason: optional(Schema.String)
}) {}

/**
 * A request from the server to sample an LLM via the client. The client has
 * full discretion over which model to select. The client should also inform the
 * user before beginning sampling, to allow them to inspect the request (human
 * in the loop) and decide whether to approve it.
 *
 * @since 4.0.0
 * @category sampling
 */
export class CreateMessage extends Rpc.make("sampling/createMessage", {
  success: CreateMessageResult,
  error: McpError,
  payload: {
    messages: Schema.Array(SamplingMessage),
    /**
     * The server's preferences for which model to select. The client MAY ignore
     * these preferences.
     */
    modelPreferences: optional(ModelPreferences),
    /**
     * An optional system prompt the server wants to use for sampling. The
     * client MAY modify or omit this prompt.
     */
    systemPrompt: optional(Schema.String),
    /**
     * A request to include context from one or more MCP servers (including the
     * caller), to be attached to the prompt. The client MAY ignore this request.
     */
    includeContext: optional(Schema.Literals(["none", "thisServer", "allServers"])),
    temperature: optional(Schema.Number),
    /**
     * The maximum number of tokens to sample, as requested by the server. The
     * client MAY choose to sample fewer tokens than requested.
     */
    maxTokens: Schema.Number,
    stopSequences: optional(Schema.Array(Schema.String)),
    /**
     * Optional metadata to pass through to the LLM provider. The format of
     * this metadata is provider-specific.
     */
    metadata: Schema.Any
  }
}) {}

// =============================================================================
// Autocomplete
// =============================================================================

/**
 * A reference to a resource or resource template definition.
 *
 * @since 4.0.0
 * @category autocomplete
 */
export class ResourceReference extends Schema.Opaque<ResourceReference>()(Schema.Struct({
  type: Schema.tag("ref/resource"),
  /**
   * The URI or URI template of the resource.
   */
  uri: Schema.String
})) {}

/**
 * Identifies a prompt.
 *
 * @since 4.0.0
 * @category autocomplete
 */
export class PromptReference extends Schema.Opaque<PromptReference>()(Schema.Struct({
  type: Schema.tag("ref/prompt"),
  /**
   * The name of the prompt or prompt template
   */
  name: Schema.String,
  title: optional(Schema.String)
})) {}

/**
 * The server's response to a completion/complete request
 *
 * @since 4.0.0
 * @category autocomplete
 */
export class CompleteResult extends Schema.Opaque<CompleteResult>()(Schema.Struct({
  completion: Schema.Struct({
    /**
     * An array of completion values. Must not exceed 100 items.
     */
    values: Schema.Array(Schema.String),
    /**
     * The total number of completion options available. This can exceed the
     * number of values actually sent in the response.
     */
    total: optional(Schema.Number),
    /**
     * Indicates whether there are additional completion options beyond those
     * provided in the current response, even if the exact total is unknown.
     */
    hasMore: optional(Schema.Boolean)
  })
})) {
  /**
   * @since 4.0.0
   */
  static readonly empty = CompleteResult.make({
    completion: {
      values: [],
      total: 0,
      hasMore: false
    }
  })
}

/**
 * A request from the client to the server, to ask for completion options.
 *
 * @since 4.0.0
 * @category autocomplete
 */
export class Complete extends Rpc.make("completion/complete", {
  success: CompleteResult,
  error: McpError,
  payload: Schema.Struct({
    ref: Schema.Union([PromptReference, ResourceReference]),
    /**
     * The argument's information
     */
    argument: Schema.Struct({
      /**
       * The name of the argument
       */
      name: Schema.String,
      /**
       * The value of the argument to use for completion matching.
       */
      value: Schema.String
    }),
    /**
     * Additional, optional context for completions
     */
    context: optionalWithDefault(
      Schema.Struct({
        /**
         * Previously-resolved variables in a URI template or prompt.
         */
        arguments: optionalWithDefault(
          Schema.Record(Schema.String, Schema.String),
          () => ({})
        )
      }),
      () => ({ arguments: {} })
    )
  })
}) {}

// =============================================================================
// Roots
// =============================================================================

/**
 * Represents a root directory or file that the server can operate on.
 *
 * @since 4.0.0
 * @category roots
 */
export class Root extends Schema.Class<Root>(
  "@effect/ai/McpSchema/Root"
)({
  /**
   * The URI identifying the root. This *must* start with file:// for now.
   * This restriction may be relaxed in future versions of the protocol to allow
   * other URI schemes.
   */
  uri: Schema.String,
  /**
   * An optional name for the root. This can be used to provide a human-readable
   * identifier for the root, which may be useful for display purposes or for
   * referencing the root in other parts of the application.
   */
  name: optional(Schema.String)
}) {}

/**
 * The client's response to a roots/list request from the server. This result
 * contains an array of Root objects, each representing a root directory or file
 * that the server can operate on.
 *
 * @since 4.0.0
 * @category roots
 */
export class ListRootsResult extends Schema.Class<ListRootsResult>(
  "@effect/ai/McpSchema/ListRootsResult"
)({
  roots: Schema.Array(Root)
}) {}

/**
 * Sent from the server to request a list of root URIs from the client. Roots
 * allow servers to ask for specific directories or files to operate on. A
 * common example for roots is providing a set of repositories or directories a
 * server should operate
 * on.
 *
 * This request is typically used when the server needs to understand the file
 * system structure or access specific locations that the client has permission
 * to read from.
 *
 * @since 4.0.0
 * @category roots
 */
export class ListRoots extends Rpc.make("roots/list", {
  success: ListRootsResult,
  error: McpError,
  payload: Schema.UndefinedOr(RequestMeta)
}) {}

/**
 * A notification from the client to the server, informing it that the list of
 * roots has changed. This notification should be sent whenever the client adds,
 * removes, or modifies any root. The server should then request an updated list
 * of roots using the ListRootsRequest.
 *
 * @since 4.0.0
 * @category roots
 */
export class RootsListChangedNotification extends Rpc.make("notifications/roots/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

// =============================================================================
// Elicitation
// =============================================================================

/**
 * The client's response to an elicitation request
 *
 * @since 4.0.0
 * @category elicitation
 */
export class ElicitAcceptResult extends Schema.Class<ElicitAcceptResult>(
  "@effect/ai/McpSchema/ElicitAcceptResult"
)({
  ...ResultMeta.fields,
  /**
   * The user action in response to the elicitation.
   * - "accept": User submitted the form/confirmed the action
   * - "decline": User explicitly declined the action
   * - "cancel": User dismissed without making an explicit choice
   */
  action: Schema.Literal("accept"),
  /**
   * The submitted form data, only present when action is "accept".
   * Contains values matching the requested schema.
   */
  content: Schema.Any
}) {}

/**
 * The client's response to an elicitation request
 *
 * @since 4.0.0
 * @category elicitation
 */
export class ElicitDeclineResult extends Schema.Class<ElicitDeclineResult>(
  "@effect/ai/McpSchema/ElicitDeclineResult"
)({
  ...ResultMeta.fields,
  /**
   * The user action in response to the elicitation.
   * - "accept": User submitted the form/confirmed the action
   * - "decline": User explicitly declined the action
   * - "cancel": User dismissed without making an explicit choice
   */
  action: Schema.Literals(["cancel", "decline"])
}) {}

/**
 * The client's response to an elicitation request
 *
 * @since 4.0.0
 * @category elicitation
 */
export const ElicitResult = Schema.Union([
  ElicitAcceptResult,
  ElicitDeclineResult
])

/**
 * @since 4.0.0
 * @category elicitation
 */
export class Elicit extends Rpc.make("elicitation/create", {
  success: ElicitResult,
  error: McpError,
  payload: {
    /**
     * A message to display to the user, explaining what they are being
     * elicited for.
     */
    message: Schema.String,
    /**
     * A restricted subset of JSON Schema.
     * Only top-level properties are allowed, without nesting.
     */
    requestedSchema: Schema.Any
  }
}) {}

/**
 * @since 4.0.0
 * @category elicitation
 */
export class ElicitationDeclined
  extends Schema.ErrorClass<ElicitationDeclined>("@effect/ai/McpSchema/ElicitationDeclined")({
    _tag: Schema.tag("ElicitationDeclined"),
    request: Elicit.payloadSchema,
    cause: optional(Schema.Defect)
  })
{}

// =============================================================================
// McpServerClient
// =============================================================================

/**
 * @since 4.0.0
 * @category client
 */
export class McpServerClient extends Context.Service<McpServerClient, {
  readonly clientId: number
  readonly initializePayload: typeof Initialize.payloadSchema["Type"]
  readonly getClient: Effect.Effect<
    RpcClient.RpcClient<RpcGroup.Rpcs<typeof ServerRequestRpcs>, RpcClientError>,
    never,
    Scope.Scope
  >
}>()("effect/ai/McpSchema/McpServerClient") {}

/**
 * @since 4.0.0
 * @category middleware
 */
export class McpServerClientMiddleware extends RpcMiddleware.Service<McpServerClientMiddleware, {
  provides: McpServerClient
}>()("effect/ai/McpSchema/McpServerClientMiddleware") {}

// =============================================================================
// Protocol
// =============================================================================

/**
 * @since 4.0.0
 * @category protocol
 */
export type RequestEncoded<Group extends RpcGroup.Any> = RpcGroup.Rpcs<
  Group
> extends infer Rpc ? Rpc extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware
  > ? {
      readonly _tag: "Request"
      readonly id: string | number
      readonly method: _Tag
      readonly payload: _Payload["Encoded"]
    }
  : never
  : never

/**
 * @since 4.0.0
 * @category protocol
 */
export type NotificationEncoded<Group extends RpcGroup.Any> = RpcGroup.Rpcs<
  Group
> extends infer Rpc ? Rpc extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware
  > ? {
      readonly _tag: "Notification"
      readonly method: _Tag
      readonly payload: _Payload["Encoded"]
    }
  : never
  : never

/**
 * @since 4.0.0
 * @category protocol
 */
export type SuccessEncoded<Group extends RpcGroup.Any> = RpcGroup.Rpcs<
  Group
> extends infer Rpc ? Rpc extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware
  > ? {
      readonly _tag: "Success"
      readonly id: string | number
      readonly result: _Success["Encoded"]
    }
  : never
  : never

/**
 * @since 4.0.0
 * @category protocol
 */
export type FailureEncoded<Group extends RpcGroup.Any> = RpcGroup.Rpcs<
  Group
> extends infer Rpc ? Rpc extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware
  > ? {
      readonly _tag: "Failure"
      readonly id: string | number
      readonly error: _Error["Encoded"]
    }
  : never
  : never

/**
 * @since 4.0.0
 * @category protocol
 */
export class ClientRequestRpcs extends RpcGroup.make(
  Ping,
  Initialize,
  Complete,
  SetLevel,
  GetPrompt,
  ListPrompts,
  ListResources,
  ListResourceTemplates,
  ReadResource,
  Subscribe,
  Unsubscribe,
  CallTool,
  ListTools
).middleware(McpServerClientMiddleware) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export type ClientRequestEncoded = RequestEncoded<typeof ClientRequestRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export class ClientNotificationRpcs extends RpcGroup.make(
  CancelledNotification,
  ProgressNotification,
  InitializedNotification,
  RootsListChangedNotification
) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export type ClientNotificationEncoded = NotificationEncoded<typeof ClientNotificationRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export class ClientRpcs extends ClientRequestRpcs.merge(ClientNotificationRpcs) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export type ClientSuccessEncoded = SuccessEncoded<typeof ServerRequestRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export type ClientFailureEncoded = FailureEncoded<typeof ServerRequestRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export class ServerRequestRpcs extends RpcGroup.make(
  Ping,
  CreateMessage,
  ListRoots,
  Elicit
) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export type ServerRequestEncoded = RequestEncoded<typeof ServerRequestRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export class ServerNotificationRpcs extends RpcGroup.make(
  CancelledNotification,
  ProgressNotification,
  LoggingMessageNotification,
  ResourceUpdatedNotification,
  ResourceListChangedNotification,
  ToolListChangedNotification,
  PromptListChangedNotification
) {}

/**
 * @since 4.0.0
 * @category protocol
 */
export type ServerNotificationEncoded = NotificationEncoded<typeof ServerNotificationRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export type ServerSuccessEncoded = SuccessEncoded<typeof ClientRequestRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export type ServerFailureEncoded = FailureEncoded<typeof ClientRequestRpcs>

/**
 * @since 4.0.0
 * @category protocol
 */
export type ServerResultEncoded = ServerSuccessEncoded | ServerFailureEncoded

/**
 * @since 4.0.0
 * @category protocol
 */
export type FromClientEncoded = ClientRequestEncoded | ClientNotificationEncoded

/**
 * @since 4.0.0
 * @category protocol
 */
export type FromServerEncoded = ServerResultEncoded | ServerNotificationEncoded

const ParamSchemaTypeId = "~effect/ai/McpSchema/ParamSchema"

/**
 * @since 4.0.0
 * @category parameters
 */
export function isParam(schema: Schema.Top): schema is Param<string, Schema.Top> {
  return Predicate.hasProperty(schema, ParamSchemaTypeId)
}

/**
 * @since 4.0.0
 * @category parameters
 */
export interface Param<Name extends string, S extends Schema.Top> extends
  Schema.Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    Param<Name, S>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly "Rebuild": Param<Name, S>
  readonly [ParamSchemaTypeId]: typeof ParamSchemaTypeId
  readonly name: Name
  readonly schema: S
}

/**
 * Helper to create a param for a resource URI template.
 *
 * @since 4.0.0
 * @category parameters
 */
export function param<const Name extends string, S extends Schema.Top>(
  name: Name,
  schema: S
): Param<Name, S> {
  return Schema.make(schema.ast, { [ParamSchemaTypeId]: ParamSchemaTypeId, name, schema })
}

/**
 * Annotation to conditionally enable or disable tools based on client
 * information.
 *
 * @since 4.0.0
 * @category annotations
 */
export class EnabledWhen
  extends Context.Service<EnabledWhen, Predicate.Predicate<typeof Initialize.payloadSchema.Type>>()(
    "effect/unstable/ai/McpSchema/EnabledWhen"
  )
{}
