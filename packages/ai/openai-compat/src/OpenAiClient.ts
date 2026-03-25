/**
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import type * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { identity, pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as Sse from "effect/unstable/encoding/Sse"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Errors from "./internal/errors.ts"
import { OpenAiConfig } from "./OpenAiConfig.ts"

/**
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly client: HttpClient.HttpClient
  readonly createResponse: (
    options: CreateResponseRequestJson
  ) => Effect.Effect<
    [body: CreateResponse200, response: HttpClientResponse.HttpClientResponse],
    AiError.AiError
  >
  readonly createResponseStream: (
    options: Omit<CreateResponseRequestJson, "stream" | "stream_options">
  ) => Effect.Effect<
    [
      response: HttpClientResponse.HttpClientResponse,
      stream: Stream.Stream<CreateResponse200Sse, AiError.AiError>
    ],
    AiError.AiError
  >
  readonly createEmbedding: (
    options: CreateEmbeddingRequestJson
  ) => Effect.Effect<CreateEmbedding200, AiError.AiError>
}

/**
 * @since 1.0.0
 * @category service
 */
export class OpenAiClient extends ServiceMap.Service<OpenAiClient, Service>()(
  "@effect/ai-openai-compat/OpenAiClient"
) {}

/**
 * @since 1.0.0
 * @category models
 */
export type Options = {
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly apiUrl?: string | undefined
  readonly organizationId?: Redacted.Redacted<string> | undefined
  readonly projectId?: Redacted.Redacted<string> | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}

const RedactedOpenAiHeaders = {
  OpenAiOrganization: "OpenAI-Organization",
  OpenAiProject: "OpenAI-Project"
}

/**
 * @since 1.0.0
 * @category constructors
 */
export const make = Effect.fnUntraced(
  function*(options: Options): Effect.fn.Return<Service, never, HttpClient.HttpClient> {
    const baseClient = yield* HttpClient.HttpClient

    const httpClient = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.apiUrl ?? "https://api.openai.com/v1"),
          options.apiKey !== undefined
            ? HttpClientRequest.bearerToken(Redacted.value(options.apiKey))
            : identity,
          options.organizationId !== undefined
            ? HttpClientRequest.setHeader(
              RedactedOpenAiHeaders.OpenAiOrganization,
              Redacted.value(options.organizationId)
            )
            : identity,
          options.projectId !== undefined
            ? HttpClientRequest.setHeader(
              RedactedOpenAiHeaders.OpenAiProject,
              Redacted.value(options.projectId)
            )
            : identity,
          HttpClientRequest.acceptJson
        )
      ),
      options.transformClient !== undefined
        ? options.transformClient
        : identity
    )

    const resolveHttpClient = Effect.map(
      OpenAiConfig.getOrUndefined,
      (config) =>
        config?.transformClient !== undefined
          ? config.transformClient(httpClient)
          : httpClient
    )

    const decodeResponse = HttpClientResponse.schemaBodyJson(ChatCompletionResponse)

    const createResponse = (
      payload: CreateResponseRequestJson
    ): Effect.Effect<
      [body: CreateResponse200, response: HttpClientResponse.HttpClientResponse],
      AiError.AiError
    > =>
      Effect.flatMap(resolveHttpClient, (client) =>
        pipe(
          HttpClientRequest.post("/chat/completions"),
          HttpClientRequest.bodyJsonUnsafe(payload),
          HttpClient.filterStatusOk(client).execute,
          Effect.flatMap((response) =>
            Effect.map(decodeResponse(response), (
              body
            ): [CreateResponse200, HttpClientResponse.HttpClientResponse] => [
              body,
              response
            ])
          ),
          Effect.catchTags({
            HttpClientError: (error) => Errors.mapHttpClientError(error, "createResponse"),
            SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createResponse"))
          })
        ))

    const buildResponseStream = (
      response: HttpClientResponse.HttpClientResponse
    ): [
      HttpClientResponse.HttpClientResponse,
      Stream.Stream<CreateResponse200Sse, AiError.AiError>
    ] => {
      const stream = response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.flatMap((event) => {
          const data = decodeChatCompletionSseData(event.data)
          return Stream.fromIterable(data !== undefined ? [data] : [])
        }),
        Stream.takeUntil((event) => event === "[DONE]"),
        Stream.catchTags({
          Retry: (error) => Stream.die(error),
          HttpClientError: (error) => Stream.fromEffect(Errors.mapHttpClientError(error, "createResponseStream"))
        })
      ) as any
      return [response, stream]
    }

    const createResponseStream: Service["createResponseStream"] = (payload) =>
      Effect.flatMap(resolveHttpClient, (client) =>
        pipe(
          HttpClientRequest.post("/chat/completions"),
          HttpClientRequest.bodyJsonUnsafe({
            ...payload,
            stream: true,
            stream_options: {
              include_usage: true
            }
          }),
          HttpClient.filterStatusOk(client).execute,
          Effect.map(buildResponseStream),
          Effect.catchTag(
            "HttpClientError",
            (error) => Errors.mapHttpClientError(error, "createResponseStream")
          )
        ))

    const decodeEmbedding = HttpClientResponse.schemaBodyJson(CreateEmbeddingResponseSchema)

    const createEmbedding = (
      payload: CreateEmbeddingRequestJson
    ): Effect.Effect<CreateEmbedding200, AiError.AiError> =>
      Effect.flatMap(resolveHttpClient, (client) =>
        pipe(
          HttpClientRequest.post("/embeddings"),
          HttpClientRequest.bodyJsonUnsafe(payload),
          HttpClient.filterStatusOk(client).execute,
          Effect.flatMap(decodeEmbedding),
          Effect.catchTags({
            HttpClientError: (error) => Errors.mapHttpClientError(error, "createEmbedding"),
            SchemaError: (error) => Effect.fail(Errors.mapSchemaError(error, "createEmbedding"))
          })
        ))

    return OpenAiClient.of({
      client: httpClient,
      createResponse,
      createResponseStream,
      createEmbedding
    })
  },
  Effect.updateService(
    Headers.CurrentRedactedNames,
    Array.appendAll(Object.values(RedactedOpenAiHeaders))
  )
)

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<OpenAiClient, never, HttpClient.HttpClient> =>
  Layer.effect(OpenAiClient, make(options))

/**
 * @since 1.0.0
 * @category layers
 */
export const layerConfig = (options?: {
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
  readonly apiUrl?: Config.Config<string> | undefined
  readonly organizationId?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
  readonly projectId?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}): Layer.Layer<OpenAiClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    OpenAiClient,
    Effect.gen(function*() {
      const apiKey = options?.apiKey !== undefined
        ? yield* options.apiKey :
        undefined
      const apiUrl = options?.apiUrl !== undefined
        ? yield* options.apiUrl :
        undefined
      const organizationId = options?.organizationId !== undefined
        ? yield* options.organizationId
        : undefined
      const projectId = options?.projectId !== undefined
        ? yield* options.projectId :
        undefined
      return yield* make({
        apiKey,
        apiUrl,
        organizationId,
        projectId,
        transformClient: options?.transformClient
      })
    })
  )

type JsonObject = { readonly [x: string]: Schema.Json }

/**
 * @since 1.0.0
 */
export type IncludeEnum =
  | "message.input_image.image_url"
  | "reasoning.encrypted_content"
  | "message.output_text.logprobs"

/**
 * @since 1.0.0
 */
export type MessageStatus = "in_progress" | "completed" | "incomplete"

type InputTextContent = {
  readonly type: "input_text"
  readonly text: string
}

type InputImageContent = {
  readonly type: "input_image"
  readonly image_url?: string | null | undefined
  readonly file_id?: string | null | undefined
  readonly detail?: "low" | "high" | "auto" | null | undefined
}

type InputFileContent = {
  readonly type: "input_file"
  readonly file_id?: string | null | undefined
  readonly filename?: string | undefined
  readonly file_url?: string | undefined
  readonly file_data?: string | undefined
}

/**
 * @since 1.0.0
 */
export type InputContent = InputTextContent | InputImageContent | InputFileContent

/**
 * @since 1.0.0
 */
export type SummaryTextContent = {
  readonly type: "summary_text"
  readonly text: string
}

type ReasoningTextContent = {
  readonly type: "reasoning_text"
  readonly text: string
}

type RefusalContent = {
  readonly type: "refusal"
  readonly refusal: string
}

type TextContent = {
  readonly type: "text"
  readonly text: string
}

type ComputerScreenshotContent = {
  readonly type: "computer_screenshot"
  readonly image_url: string | null
  readonly file_id: string | null
}

type FileCitationAnnotation = {
  readonly type: "file_citation"
  readonly file_id: string
  readonly index: number
  readonly filename: string
}

type UrlCitationAnnotation = {
  readonly type: "url_citation"
  readonly url: string
  readonly start_index: number
  readonly end_index: number
  readonly title: string
}

type ContainerFileCitationAnnotation = {
  readonly type: "container_file_citation"
  readonly container_id: string
  readonly file_id: string
  readonly start_index: number
  readonly end_index: number
  readonly filename: string
}

type FilePathAnnotation = {
  readonly type: "file_path"
  readonly file_id: string
  readonly index: number
}

/**
 * @since 1.0.0
 */
export type Annotation =
  | FileCitationAnnotation
  | UrlCitationAnnotation
  | ContainerFileCitationAnnotation
  | FilePathAnnotation

type OutputTextContent = {
  readonly type: "output_text"
  readonly text: string
  readonly annotations?: ReadonlyArray<Annotation> | undefined
  readonly logprobs?: ReadonlyArray<unknown> | undefined
}

type OutputMessageContent =
  | InputTextContent
  | OutputTextContent
  | TextContent
  | SummaryTextContent
  | ReasoningTextContent
  | RefusalContent
  | InputImageContent
  | ComputerScreenshotContent
  | InputFileContent

type OutputMessage = {
  readonly id: string
  readonly type: "message"
  readonly role: "assistant"
  readonly content: ReadonlyArray<OutputMessageContent>
  readonly status: MessageStatus
}

/**
 * @since 1.0.0
 */
export type ReasoningItem = {
  readonly type: "reasoning"
  readonly id: string
  readonly encrypted_content?: string | null | undefined
  readonly summary: ReadonlyArray<SummaryTextContent>
  readonly content?: ReadonlyArray<ReasoningTextContent> | undefined
  readonly status?: MessageStatus | undefined
}

type FunctionCall = {
  readonly id?: string | undefined
  readonly type: "function_call"
  readonly call_id: string
  readonly name: string
  readonly arguments: string
  readonly status?: MessageStatus | undefined
}

type FunctionCallOutput = {
  readonly id?: string | null | undefined
  readonly call_id: string
  readonly type: "function_call_output"
  readonly output: string | ReadonlyArray<InputTextContent | InputImageContent | InputFileContent>
  readonly status?: MessageStatus | null | undefined
}

type CustomToolCall = {
  readonly type: "custom_tool_call"
  readonly id?: string | undefined
  readonly call_id: string
  readonly name: string
  readonly input: string
}

type CustomToolCallOutput = {
  readonly type: "custom_tool_call_output"
  readonly id?: string | undefined
  readonly call_id: string
  readonly output: string | ReadonlyArray<InputTextContent | InputImageContent | InputFileContent>
}

type ItemReference = {
  readonly type?: "item_reference" | null | undefined
  readonly id: string
}

/**
 * @since 1.0.0
 */
export type InputItem =
  | {
    readonly role: "user" | "assistant" | "system" | "developer"
    readonly content: string | ReadonlyArray<InputContent>
    readonly type?: "message" | undefined
  }
  | {
    readonly type?: "message" | undefined
    readonly role: "user" | "system" | "developer"
    readonly status?: MessageStatus | undefined
    readonly content: ReadonlyArray<InputContent>
  }
  | OutputMessage
  | FunctionCall
  | FunctionCallOutput
  | ReasoningItem
  | CustomToolCallOutput
  | CustomToolCall
  | ItemReference

type FunctionTool = {
  readonly type: "function"
  readonly name: string
  readonly description?: string | null | undefined
  readonly parameters?: JsonObject | null | undefined
  readonly strict?: boolean | null | undefined
}

type CustomToolParam = {
  readonly type: "custom"
  readonly name: string
  readonly description?: string | undefined
  readonly format?: unknown
}

/**
 * @since 1.0.0
 */
export type Tool =
  | FunctionTool
  | CustomToolParam

type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
    readonly type: "allowed_tools"
    readonly mode: "auto" | "required"
    readonly tools: ReadonlyArray<JsonObject>
  }
  | {
    readonly type: "function"
    readonly name: string
  }
  | {
    readonly type: "custom"
    readonly name: string
  }

/**
 * @since 1.0.0
 */
export type TextResponseFormatConfiguration =
  | {
    readonly type: "text"
  }
  | {
    readonly type: "json_schema"
    readonly description?: string | undefined
    readonly name: string
    readonly schema: JsonObject
    readonly strict?: boolean | null | undefined
  }
  | {
    readonly type: "json_object"
  }

/**
 * @since 1.0.0
 */
export type CreateResponse = {
  readonly metadata?: Readonly<Record<string, string>> | null | undefined
  readonly top_logprobs?: number | undefined
  readonly temperature?: number | null | undefined
  readonly top_p?: number | null | undefined
  readonly user?: string | null | undefined
  readonly safety_identifier?: string | null | undefined
  readonly prompt_cache_key?: string | null | undefined
  readonly service_tier?: string | undefined
  readonly prompt_cache_retention?: "in-memory" | "24h" | null | undefined
  readonly previous_response_id?: string | null | undefined
  readonly model?: string | undefined
  readonly reasoning?: unknown
  readonly background?: boolean | null | undefined
  readonly max_output_tokens?: number | null | undefined
  readonly max_tool_calls?: number | null | undefined
  readonly text?: {
    readonly format?: TextResponseFormatConfiguration | undefined
    readonly verbosity?: "low" | "medium" | "high" | null | undefined
  } | undefined
  readonly tools?: ReadonlyArray<Tool> | undefined
  readonly tool_choice?: ToolChoice | undefined
  readonly truncation?: "auto" | "disabled" | null | undefined
  readonly input?: string | ReadonlyArray<InputItem> | undefined
  readonly include?: ReadonlyArray<IncludeEnum> | null | undefined
  readonly parallel_tool_calls?: boolean | null | undefined
  readonly store?: boolean | null | undefined
  readonly instructions?: string | null | undefined
  readonly stream?: boolean | null | undefined
  readonly conversation?: string | null | undefined
  readonly modalities?: ReadonlyArray<"text" | "audio"> | undefined
  readonly seed?: number | undefined
}

/**
 * @since 1.0.0
 */
export type ResponseUsage = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
  readonly input_tokens_details?: unknown
  readonly output_tokens_details?: unknown
}

type OutputItem =
  | OutputMessage
  | FunctionCall
  | ReasoningItem
  | CustomToolCall

/**
 * @since 1.0.0
 */
export type Response = {
  readonly id: string
  readonly object?: "response" | undefined
  readonly model: string
  readonly status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete" | undefined
  readonly created_at: number
  readonly output: ReadonlyArray<OutputItem>
  readonly usage?: ResponseUsage | null | undefined
  readonly incomplete_details?:
    | {
      readonly reason?: "max_output_tokens" | "content_filter" | undefined
    }
    | null
    | undefined
  readonly service_tier?: string | undefined
}

type ResponseCreatedEvent = {
  readonly type: "response.created"
  readonly response: Response
  readonly sequence_number: number
}

type ResponseCompletedEvent = {
  readonly type: "response.completed"
  readonly response: Response
  readonly sequence_number: number
}

type ResponseIncompleteEvent = {
  readonly type: "response.incomplete"
  readonly response: Response
  readonly sequence_number: number
}

type ResponseFailedEvent = {
  readonly type: "response.failed"
  readonly response: Response
  readonly sequence_number: number
}

type ResponseOutputItemAddedEvent = {
  readonly type: "response.output_item.added"
  readonly output_index: number
  readonly sequence_number: number
  readonly item: OutputItem
}

type ResponseOutputItemDoneEvent = {
  readonly type: "response.output_item.done"
  readonly output_index: number
  readonly sequence_number: number
  readonly item: OutputItem
}

type ResponseTextDeltaEvent = {
  readonly type: "response.output_text.delta"
  readonly item_id: string
  readonly output_index: number
  readonly content_index: number
  readonly delta: string
  readonly sequence_number: number
  readonly logprobs?: ReadonlyArray<unknown> | undefined
}

type ResponseOutputTextAnnotationAddedEvent = {
  readonly type: "response.output_text.annotation.added"
  readonly item_id: string
  readonly output_index: number
  readonly content_index: number
  readonly annotation_index: number
  readonly sequence_number: number
  readonly annotation: Annotation
}

type ResponseFunctionCallArgumentsDeltaEvent = {
  readonly type: "response.function_call_arguments.delta"
  readonly item_id: string
  readonly output_index: number
  readonly sequence_number: number
  readonly delta: string
}

type ResponseReasoningSummaryPartAddedEvent = {
  readonly type: "response.reasoning_summary_part.added"
  readonly item_id: string
  readonly output_index: number
  readonly summary_index: number
  readonly sequence_number: number
  readonly part: SummaryTextContent
}

type ResponseReasoningSummaryPartDoneEvent = {
  readonly type: "response.reasoning_summary_part.done"
  readonly item_id: string
  readonly output_index: number
  readonly summary_index: number
  readonly sequence_number: number
  readonly part: SummaryTextContent
}

type ResponseReasoningSummaryTextDeltaEvent = {
  readonly type: "response.reasoning_summary_text.delta"
  readonly item_id: string
  readonly output_index: number
  readonly summary_index: number
  readonly delta: string
  readonly sequence_number: number
}

type ResponseErrorEvent = {
  readonly type: "error"
  readonly code: string | null
  readonly message: string
  readonly param: string | null
  readonly sequence_number: number
}

type UnknownResponseStreamEvent = {
  readonly type: string
  readonly [key: string]: unknown
}

/**
 * @since 1.0.0
 */
export type ResponseStreamEvent =
  | ResponseCreatedEvent
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseTextDeltaEvent
  | ResponseOutputTextAnnotationAddedEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseReasoningSummaryPartAddedEvent
  | ResponseReasoningSummaryPartDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseErrorEvent
  | UnknownResponseStreamEvent

/**
 * @since 1.0.0
 */
export type Embedding = {
  readonly embedding: ReadonlyArray<number> | string
  readonly index: number
  readonly object?: string | undefined
}

/**
 * @since 1.0.0
 */
export type CreateEmbeddingRequest = {
  readonly input: string | ReadonlyArray<string> | ReadonlyArray<number> | ReadonlyArray<ReadonlyArray<number>>
  readonly model: string
  readonly encoding_format?: "float" | "base64" | undefined
  readonly dimensions?: number | undefined
  readonly user?: string | undefined
}

/**
 * @since 1.0.0
 */
export type CreateEmbeddingResponse = {
  readonly data: ReadonlyArray<Embedding>
  readonly model: string
  readonly object?: "list" | undefined
  readonly usage?: {
    readonly prompt_tokens: number
    readonly total_tokens: number
  } | undefined
}

/**
 * @since 1.0.0
 */
export type CreateEmbeddingRequestJson = CreateEmbeddingRequest
/**
 * @since 1.0.0
 */
export type CreateEmbedding200 = CreateEmbeddingResponse
/**
 * @since 1.0.0
 */
export type ChatCompletionContentPart =
  | {
    readonly type: "text"
    readonly text: string
  }
  | {
    readonly type: "image_url"
    readonly image_url: {
      readonly url: string
      readonly detail?: "low" | "high" | "auto" | undefined
    }
  }
/**
 * @since 1.0.0
 */
export type ChatCompletionRequestToolCall = {
  readonly id: string
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}
/**
 * @since 1.0.0
 */
export type ChatCompletionRequestMessage =
  | {
    readonly role: "system" | "developer" | "user" | "assistant"
    readonly content: string | ReadonlyArray<ChatCompletionContentPart> | null
    readonly tool_calls?: ReadonlyArray<ChatCompletionRequestToolCall> | undefined
  }
  | {
    readonly role: "tool"
    readonly tool_call_id: string
    readonly content: string
  }
/**
 * @since 1.0.0
 */
export type ChatCompletionTool = {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description?: string | null | undefined
    readonly parameters?: JsonObject | undefined
    readonly strict?: boolean | undefined
  }
}
/**
 * @since 1.0.0
 */
export type ChatCompletionToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
    readonly type: "function"
    readonly function: {
      readonly name: string
    }
  }
/**
 * @since 1.0.0
 */
export type ChatCompletionResponseFormat =
  | {
    readonly type: "json_object"
  }
  | {
    readonly type: "json_schema"
    readonly json_schema: {
      readonly name: string
      readonly schema: JsonObject
      readonly description?: string | undefined
      readonly strict?: boolean | undefined
    }
  }
/**
 * @since 1.0.0
 */
export type ChatCompletionRequest = {
  readonly model: string
  readonly messages: ReadonlyArray<ChatCompletionRequestMessage>
  readonly temperature?: number | null | undefined
  readonly top_p?: number | null | undefined
  readonly max_tokens?: number | null | undefined
  readonly user?: string | null | undefined
  readonly seed?: number | undefined
  readonly parallel_tool_calls?: boolean | null | undefined
  readonly response_format?: ChatCompletionResponseFormat | undefined
  readonly tools?: ReadonlyArray<ChatCompletionTool> | undefined
  readonly tool_choice?: ChatCompletionToolChoice | undefined
  readonly service_tier?: string | undefined
  readonly reasoning?: unknown
  readonly stream?: boolean | undefined
  readonly stream_options?: {
    readonly include_usage?: boolean | undefined
  } | undefined
  readonly [x: string]: unknown
}
/**
 * @since 1.0.0
 */
export type CreateResponseRequestJson = ChatCompletionRequest
/**
 * @since 1.0.0
 */
export type CreateResponse200 = ChatCompletionResponse
/**
 * @since 1.0.0
 */
export type CreateResponse200Sse = ChatCompletionStreamEvent

const EmbeddingSchema = Schema.Struct({
  embedding: Schema.Union([Schema.Array(Schema.Number), Schema.String]),
  index: Schema.Number,
  object: Schema.optionalKey(Schema.String)
})

const CreateEmbeddingResponseSchema = Schema.Struct({
  data: Schema.Array(EmbeddingSchema),
  model: Schema.String,
  object: Schema.optionalKey(Schema.Literal("list")),
  usage: Schema.optionalKey(Schema.Struct({
    prompt_tokens: Schema.Number,
    total_tokens: Schema.Number
  }))
})

const ChatCompletionToolFunction = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.String)
})

const ChatCompletionToolFunctionDelta = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.String)
})

const ChatCompletionToolCall = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Number),
  type: Schema.optionalKey(Schema.String),
  function: Schema.optionalKey(ChatCompletionToolFunction)
})

const ChatCompletionToolCallDelta = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Number),
  type: Schema.optionalKey(Schema.String),
  function: Schema.optionalKey(ChatCompletionToolFunctionDelta)
})

const ChatCompletionMessage = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optionalKey(Schema.Array(ChatCompletionToolCall))
})

const ChatCompletionDelta = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optionalKey(Schema.Array(ChatCompletionToolCallDelta))
})

const ChatCompletionChoice = Schema.Struct({
  index: Schema.Number,
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(ChatCompletionMessage),
  delta: Schema.optionalKey(ChatCompletionDelta)
})

const ChatCompletionUsage = Schema.Struct({
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  total_tokens: Schema.Number,
  prompt_tokens_details: Schema.optionalKey(Schema.Any),
  completion_tokens_details: Schema.optionalKey(Schema.Any)
})

const ChatCompletionResponse = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  created: Schema.Number,
  choices: Schema.Array(ChatCompletionChoice),
  usage: Schema.optionalKey(Schema.NullOr(ChatCompletionUsage)),
  service_tier: Schema.optionalKey(Schema.String)
})

const ChatCompletionChunk = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  created: Schema.Number,
  choices: Schema.Array(ChatCompletionChoice),
  usage: Schema.optionalKey(Schema.NullOr(ChatCompletionUsage)),
  service_tier: Schema.optionalKey(Schema.String)
})

/**
 * @since 1.0.0
 */
export type ChatCompletionToolCall = typeof ChatCompletionToolCall.Type
/**
 * @since 1.0.0
 */
export type ChatCompletionMessage = typeof ChatCompletionMessage.Type
/**
 * @since 1.0.0
 */
export type ChatCompletionChoice = typeof ChatCompletionChoice.Type
/**
 * @since 1.0.0
 */
export type ChatCompletionUsage = typeof ChatCompletionUsage.Type
/**
 * @since 1.0.0
 */
export type ChatCompletionResponse = typeof ChatCompletionResponse.Type
/**
 * @since 1.0.0
 */
export type ChatCompletionChunk = typeof ChatCompletionChunk.Type
/**
 * @since 1.0.0
 */
export type ChatCompletionStreamEvent = ChatCompletionChunk | "[DONE]"

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const isChatCompletionChunk = Schema.is(ChatCompletionChunk)

const decodeChatCompletionSseData = (
  data: string
): ChatCompletionStreamEvent | undefined => {
  if (data === "[DONE]") {
    return data
  }
  const parsed = parseJson(data)
  return isChatCompletionChunk(parsed)
    ? parsed
    : undefined
}
