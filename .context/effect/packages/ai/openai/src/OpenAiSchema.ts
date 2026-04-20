/**
 * Minimal local OpenAI schemas used by the handwritten Responses client path.
 *
 * @since 1.0.0
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

const MessageRole = Schema.Literals(["system", "developer", "user", "assistant"])

const ImageDetail = Schema.Literals(["low", "high", "auto"])

/**
 * @since 1.0.0
 */
export const IncludeEnum = Schema.Literals([
  "message.input_image.image_url",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
  "code_interpreter_call.outputs",
  "web_search_call.action.sources"
])

/**
 * @since 1.0.0
 */
export type IncludeEnum = typeof IncludeEnum.Type

/**
 * @since 1.0.0
 */
export const MessageStatus = Schema.Literals(["in_progress", "completed", "incomplete"])

/**
 * @since 1.0.0
 */
export type MessageStatus = typeof MessageStatus.Type

const InputTextContent = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String
})

const InputImageContent = Schema.Struct({
  type: Schema.Literal("input_image"),
  image_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  file_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  detail: Schema.optionalKey(Schema.NullOr(ImageDetail))
})

const InputFileContent = Schema.Struct({
  type: Schema.Literal("input_file"),
  file_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  filename: Schema.optionalKey(Schema.String),
  file_url: Schema.optionalKey(Schema.String),
  file_data: Schema.optionalKey(Schema.String)
})

/**
 * @since 1.0.0
 */
export const InputContent = Schema.Union([
  InputTextContent,
  InputImageContent,
  InputFileContent
])

/**
 * @since 1.0.0
 */
export type InputContent = typeof InputContent.Type

/**
 * @since 1.0.0
 */
export const SummaryTextContent = Schema.Struct({
  type: Schema.Literal("summary_text"),
  text: Schema.String
})

/**
 * @since 1.0.0
 */
export type SummaryTextContent = typeof SummaryTextContent.Type

const ReasoningTextContent = Schema.Struct({
  type: Schema.Literal("reasoning_text"),
  text: Schema.String
})

const RefusalContent = Schema.Struct({
  type: Schema.Literal("refusal"),
  refusal: Schema.String
})

const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

const ComputerScreenshotContent = Schema.Struct({
  type: Schema.Literal("computer_screenshot"),
  image_url: Schema.NullOr(Schema.String),
  file_id: Schema.NullOr(Schema.String)
})

const FileCitationAnnotation = Schema.Struct({
  type: Schema.Literal("file_citation"),
  file_id: Schema.String,
  index: Schema.Number,
  filename: Schema.String
})

const UrlCitationAnnotation = Schema.Struct({
  type: Schema.Literal("url_citation"),
  url: Schema.String,
  start_index: Schema.Number,
  end_index: Schema.Number,
  title: Schema.String
})

const ContainerFileCitationAnnotation = Schema.Struct({
  type: Schema.Literal("container_file_citation"),
  container_id: Schema.String,
  file_id: Schema.String,
  start_index: Schema.Number,
  end_index: Schema.Number,
  filename: Schema.String
})

const FilePathAnnotation = Schema.Struct({
  type: Schema.Literal("file_path"),
  file_id: Schema.String,
  index: Schema.Number
})

/**
 * @since 1.0.0
 */
export const Annotation = Schema.Union([
  FileCitationAnnotation,
  UrlCitationAnnotation,
  ContainerFileCitationAnnotation,
  FilePathAnnotation
])

/**
 * @since 1.0.0
 */
export type Annotation = typeof Annotation.Type

const OutputTextContent = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.Array(Annotation),
  logprobs: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

const OutputMessageContent = Schema.Union([
  InputTextContent,
  OutputTextContent,
  TextContent,
  SummaryTextContent,
  ReasoningTextContent,
  RefusalContent,
  InputImageContent,
  ComputerScreenshotContent,
  InputFileContent
])

const OutputMessage = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  content: Schema.Array(OutputMessageContent),
  status: MessageStatus
})

/**
 * @since 1.0.0
 */
export const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  encrypted_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  summary: Schema.Array(SummaryTextContent),
  content: Schema.optionalKey(Schema.Array(ReasoningTextContent)),
  status: Schema.optionalKey(MessageStatus)
})

/**
 * @since 1.0.0
 */
export type ReasoningItem = typeof ReasoningItem.Type

const FunctionCall = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: Schema.optionalKey(MessageStatus)
})

const FunctionCallOutput = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.Union([
    Schema.String,
    Schema.Array(InputContent)
  ]),
  status: Schema.optionalKey(Schema.NullOr(MessageStatus))
})

const ItemReference = Schema.Struct({
  type: Schema.Literal("item_reference"),
  id: Schema.String
})

const LocalShellCall = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("local_shell_call"),
  call_id: Schema.String,
  action: Schema.Unknown,
  status: Schema.optionalKey(MessageStatus)
})

const LocalShellCallOutput = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("local_shell_call_output"),
  call_id: Schema.String,
  output: Schema.Unknown,
  status: Schema.optionalKey(MessageStatus)
})

const ShellCall = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("shell_call"),
  call_id: Schema.String,
  action: Schema.Unknown,
  status: Schema.optionalKey(MessageStatus)
})

const ShellCallOutput = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("shell_call_output"),
  call_id: Schema.String,
  output: Schema.Unknown,
  status: Schema.optionalKey(MessageStatus)
})

const ApplyPatchCallOutput = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.Literal("apply_patch_call_output"),
  call_id: Schema.String,
  status: Schema.optionalKey(MessageStatus),
  output: Schema.optionalKey(Schema.Unknown)
})

const McpApprovalResponse = Schema.Struct({
  type: Schema.Literal("mcp_approval_response"),
  approval_request_id: Schema.String,
  approve: Schema.Boolean
})

const RequestMessageItem = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("message")),
  role: MessageRole,
  status: Schema.optionalKey(MessageStatus),
  content: Schema.Union([
    Schema.String,
    Schema.Array(InputContent)
  ])
})

/**
 * @since 1.0.0
 */
export const InputItem = Schema.Union([
  RequestMessageItem,
  OutputMessage,
  FunctionCall,
  FunctionCallOutput,
  ReasoningItem,
  ItemReference,
  LocalShellCall,
  LocalShellCallOutput,
  ShellCall,
  ShellCallOutput,
  ApplyPatchCallOutput,
  McpApprovalResponse
])

/**
 * @since 1.0.0
 */
export type InputItem = typeof InputItem.Type

const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parameters: Schema.optionalKey(Schema.NullOr(JsonObject)),
  strict: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})

const CustomTool = Schema.Struct({
  type: Schema.Literal("custom"),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.Unknown)
})

const ProviderDefinedTool = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals([
      "apply_patch",
      "code_interpreter",
      "file_search",
      "image_generation",
      "local_shell",
      "mcp",
      "shell",
      "web_search",
      "web_search_preview"
    ])
  }),
  [UnknownRecord]
)

/**
 * @since 1.0.0
 */
export const Tool = Schema.Union([
  FunctionTool,
  CustomTool,
  ProviderDefinedTool
])

/**
 * @since 1.0.0
 */
export type Tool = typeof Tool.Type

/**
 * @since 1.0.0
 */
export const ToolChoice = Schema.Union([
  Schema.Literals(["none", "auto", "required"]),
  Schema.Struct({
    type: Schema.Literal("allowed_tools"),
    mode: Schema.Literals(["auto", "required"]),
    tools: Schema.Array(JsonObject)
  }),
  Schema.Struct({
    type: Schema.Literal("function"),
    name: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    name: Schema.String
  }),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.Literals([
        "apply_patch",
        "code_interpreter",
        "file_search",
        "image_generation",
        "local_shell",
        "mcp",
        "shell",
        "web_search",
        "web_search_preview"
      ])
    }),
    [UnknownRecord]
  )
])

/**
 * @since 1.0.0
 */
export type ToolChoice = typeof ToolChoice.Type

/**
 * @since 1.0.0
 */
export const TextResponseFormatConfiguration = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text") }),
  Schema.Struct({
    type: Schema.Literal("json_schema"),
    description: Schema.optionalKey(Schema.String),
    name: Schema.String,
    schema: JsonObject,
    strict: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
  }),
  Schema.Struct({ type: Schema.Literal("json_object") })
])

/**
 * @since 1.0.0
 */
export type TextResponseFormatConfiguration = typeof TextResponseFormatConfiguration.Type

/**
 * @since 1.0.0
 */
export const CreateResponse = Schema.Struct({
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  top_logprobs: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  user: Schema.optional(Schema.String),
  service_tier: Schema.optional(Schema.String),
  previous_response_id: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Struct({
    effort: Schema.optional(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"])),

    summary: Schema.optional(Schema.Literals(["auto", "concise", "detailed"])),
    generate_summary: Schema.optional(Schema.Literals(["auto", "concise", "detailed"]))
  })),
  background: Schema.optional(Schema.Boolean),
  max_output_tokens: Schema.optional(Schema.Number),
  max_tool_calls: Schema.optional(Schema.Number),
  text: Schema.optional(
    Schema.Struct({
      format: Schema.optional(TextResponseFormatConfiguration),
      verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"]))
    })
  ),
  tools: Schema.optional(Schema.Array(Tool)),
  tool_choice: Schema.optional(ToolChoice),
  truncation: Schema.optional(Schema.Literals(["auto", "disabled"])),
  input: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Array(InputItem)
    ])
  ),
  include: Schema.optional(Schema.Array(IncludeEnum)),
  store: Schema.optional(Schema.Boolean),
  instructions: Schema.optional(Schema.String),
  stream: Schema.optional(Schema.Boolean),
  conversation: Schema.optional(Schema.String),
  modalities: Schema.optional(Schema.Array(Schema.Literals(["text", "audio"]))),
  seed: Schema.optional(Schema.Number)
})

/**
 * @since 1.0.0
 */
export type CreateResponse = typeof CreateResponse.Type

/**
 * @since 1.0.0
 */
export const ResponseUsage = Schema.StructWithRest(
  Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    total_tokens: Schema.Number,
    input_tokens_details: Schema.optionalKey(Schema.Unknown),
    output_tokens_details: Schema.optionalKey(Schema.Unknown)
  }),
  [UnknownRecord]
)

/**
 * @since 1.0.0
 */
export type ResponseUsage = typeof ResponseUsage.Type

const ApplyPatchOperation = Schema.Struct({
  type: Schema.String,
  path: Schema.String,
  diff: Schema.optionalKey(Schema.String)
})

const ApplyPatchCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("apply_patch_call"),
  call_id: Schema.String,
  operation: ApplyPatchOperation,
  status: Schema.optionalKey(MessageStatus)
})

const CodeInterpreterCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("code_interpreter_call"),
  code: Schema.optionalKey(Schema.String),
  container_id: Schema.String,
  outputs: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  status: Schema.optionalKey(MessageStatus)
})

const ComputerCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("computer_call"),
  status: Schema.optionalKey(MessageStatus)
})

const FileSearchCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file_search_call"),
  status: Schema.optionalKey(Schema.String),
  queries: Schema.optionalKey(Schema.Array(Schema.String)),
  results: Schema.optionalKey(Schema.NullOr(Schema.Unknown))
})

const ImageGenerationCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("image_generation_call"),
  result: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(MessageStatus)
})

const McpCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("mcp_call"),
  approval_request_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.String,
  arguments: Schema.Unknown,
  output: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  server_label: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const McpListTools = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("mcp_list_tools")
})

const McpApprovalRequest = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("mcp_approval_request"),
  approval_request_id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  arguments: Schema.Unknown
})

const WebSearchCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("web_search_call"),
  action: Schema.optionalKey(Schema.Unknown),
  status: Schema.optionalKey(Schema.String)
})

const OutputItem = Schema.Union([
  ApplyPatchCall,
  CodeInterpreterCall,
  ComputerCall,
  FileSearchCall,
  FunctionCall,
  ImageGenerationCall,
  LocalShellCall,
  McpCall,
  McpListTools,
  McpApprovalRequest,
  OutputMessage,
  ReasoningItem,
  ShellCall,
  WebSearchCall
])

/**
 * @since 1.0.0
 */
export const Response = Schema.Struct({
  id: Schema.String,
  object: Schema.optionalKey(Schema.Literal("response")),
  model: Schema.String,
  status: Schema.optionalKey(
    Schema.Literals(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"])
  ),
  created_at: Schema.Number,
  output: Schema.Array(OutputItem),
  usage: Schema.optionalKey(Schema.NullOr(ResponseUsage)),
  incomplete_details: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        reason: Schema.optionalKey(Schema.Literals(["max_output_tokens", "content_filter"]))
      })
    )
  ),
  service_tier: Schema.optionalKey(Schema.String)
})

/**
 * @since 1.0.0
 */
export type Response = typeof Response.Type

const ResponseCreatedEvent = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Response,
  sequence_number: Schema.Number
})

const ResponseCompletedEvent = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Response,
  sequence_number: Schema.Number
})

const ResponseIncompleteEvent = Schema.Struct({
  type: Schema.Literal("response.incomplete"),
  response: Response,
  sequence_number: Schema.Number
})

const ResponseFailedEvent = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Response,
  sequence_number: Schema.Number
})

const ResponseOutputItemAddedEvent = Schema.Struct({
  type: Schema.Literal("response.output_item.added"),
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  item: OutputItem
})

const ResponseOutputItemDoneEvent = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  item: OutputItem
})

const ResponseOutputTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  delta: Schema.String,
  sequence_number: Schema.Number,
  logprobs: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

const ResponseOutputTextAnnotationAddedEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.annotation.added"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  annotation_index: Schema.Number,
  sequence_number: Schema.Number,
  annotation: Annotation
})

const ResponseReasoningSummaryPartAddedEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_part.added"),
  item_id: Schema.String,
  output_index: Schema.Number,
  summary_index: Schema.Number,
  sequence_number: Schema.Number,
  part: SummaryTextContent
})

const ResponseReasoningSummaryPartDoneEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_part.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  summary_index: Schema.Number,
  sequence_number: Schema.Number,
  part: SummaryTextContent
})

const ResponseReasoningSummaryTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  summary_index: Schema.Number,
  delta: Schema.String,
  sequence_number: Schema.Number
})

const ResponseFunctionCallArgumentsDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  delta: Schema.String
})

const ResponseFunctionCallArgumentsDoneEvent = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  arguments: Schema.String
})

const ResponseCodeInterpreterCallCodeDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.code_interpreter_call_code.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  delta: Schema.String
})

const ResponseCodeInterpreterCallCodeDoneEvent = Schema.Struct({
  type: Schema.Literal("response.code_interpreter_call_code.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  code: Schema.String
})

const ResponseApplyPatchCallOperationDiffDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.apply_patch_call_operation_diff.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  delta: Schema.String
})

const ResponseApplyPatchCallOperationDiffDoneEvent = Schema.Struct({
  type: Schema.Literal("response.apply_patch_call_operation_diff.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  delta: Schema.optionalKey(Schema.String)
})

const ResponseImageGenerationCallPartialImageEvent = Schema.Struct({
  type: Schema.Literal("response.image_generation_call.partial_image"),
  item_id: Schema.String,
  output_index: Schema.Number,
  sequence_number: Schema.Number,
  partial_image_b64: Schema.String
})

const ResponseErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
  param: Schema.NullOr(Schema.String),
  sequence_number: Schema.Number,
  status: Schema.optionalKey(Schema.Number)
})

const knownResponseStreamEventTypes = new Set([
  "response.created",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.annotation.added",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
  "response.apply_patch_call_operation_diff.delta",
  "response.apply_patch_call_operation_diff.done",
  "response.image_generation_call.partial_image",
  "error"
])

/**
 * @since 1.0.0
 */
export type UnknownResponseStreamEvent = {
  readonly type: string
  readonly [key: string]: unknown
}

const UnknownResponseStreamEvent = Schema.declare<UnknownResponseStreamEvent>(
  (value): value is UnknownResponseStreamEvent =>
    Predicate.hasProperty(value, "type") &&
    typeof value.type === "string" &&
    !knownResponseStreamEventTypes.has(value.type),
  {
    identifier: "UnknownResponseStreamEvent",
    description: "Fallback for unknown future stream events"
  }
)

/**
 * @since 1.0.0
 */
export const ResponseStreamEvent = Schema.Union([
  ResponseCreatedEvent,
  ResponseCompletedEvent,
  ResponseIncompleteEvent,
  ResponseFailedEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseOutputTextDeltaEvent,
  ResponseOutputTextAnnotationAddedEvent,
  ResponseReasoningSummaryPartAddedEvent,
  ResponseReasoningSummaryPartDoneEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseCodeInterpreterCallCodeDeltaEvent,
  ResponseCodeInterpreterCallCodeDoneEvent,
  ResponseApplyPatchCallOperationDiffDeltaEvent,
  ResponseApplyPatchCallOperationDiffDoneEvent,
  ResponseImageGenerationCallPartialImageEvent,
  ResponseErrorEvent,
  UnknownResponseStreamEvent
])

/**
 * @since 1.0.0
 */
export type ResponseStreamEvent = typeof ResponseStreamEvent.Type

/**
 * @since 1.0.0
 */
export const Embedding = Schema.Struct({
  embedding: Schema.Union([
    Schema.Array(Schema.Number),
    Schema.String
  ]),
  index: Schema.Number,
  object: Schema.optionalKey(Schema.String)
})

/**
 * @since 1.0.0
 */
export type Embedding = typeof Embedding.Type

/**
 * @since 1.0.0
 */
export const CreateEmbeddingRequest = Schema.Struct({
  input: Schema.Union([
    Schema.String,
    Schema.Array(Schema.String),
    Schema.Array(Schema.Number),
    Schema.Array(Schema.Array(Schema.Number))
  ]),
  model: Schema.String,
  encoding_format: Schema.optionalKey(Schema.Literals(["float", "base64"])),
  dimensions: Schema.optionalKey(Schema.Number),
  user: Schema.optionalKey(Schema.String)
})

/**
 * @since 1.0.0
 */
export type CreateEmbeddingRequest = typeof CreateEmbeddingRequest.Type

/**
 * @since 1.0.0
 */
export const CreateEmbeddingResponse = Schema.Struct({
  data: Schema.Array(Embedding),
  model: Schema.String,
  object: Schema.optionalKey(Schema.Literal("list")),
  usage: Schema.optionalKey(
    Schema.Struct({
      prompt_tokens: Schema.Number,
      total_tokens: Schema.Number
    })
  )
})

/**
 * @since 1.0.0
 */
export type CreateEmbeddingResponse = typeof CreateEmbeddingResponse.Type
