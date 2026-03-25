# OpenRouter `makeResponse` Implementation

## Overview

Implement the `makeResponse` function for the OpenRouter language model provider, converting OpenRouter chat completion API responses (`SendChatCompletionRequest200`) into Effect AI SDK response parts (`Array<Response.PartEncoded>`).

**Status**: DONE

**References**:

- [OpenRouter Vercel AI SDK `doGenerate`](https://github.com/OpenRouterTeam/ai-sdk-provider/blob/7c043a085f796fa89b7181eedac356e8e53bf237/src/chat/index.ts#L205)
- [Effect v3 AI SDK `makeResponse`](https://github.com/Effect-TS/effect/blob/c3e706ff4d01c70ae1754b13c9cbc1f001c09068/packages/ai/openrouter/src/OpenRouterLanguageModel.ts#L546)

---

## 1. Motivation

The `makeResponse` function in `packages/ai/openrouter/src/OpenRouterLanguageModel.ts` is currently a stub returning `[]`. The `generateText` method (line 228) has a TODO comment. Without this implementation, the OpenRouter provider cannot return any content from non-streaming chat completions.

---

## 2. Design Decisions

| Decision                         | Choice                                                  | Rationale                                                                                                             |
| -------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **No `toolNameMapper`**          | Omit from function signature                            | OpenRouter rejects provider-defined tools (line 519-529), so name mapping is unnecessary                              |
| **Reasoning details per-part**   | Each detail gets its own reasoning part with metadata   | Enables fine-grained access to encrypted/summary/text reasoning details                                               |
| **First tool call gets details** | Attach `reasoningDetails` only to first tool call       | Prevents duplication across parallel tool calls (matches Vercel AI SDK pattern)                                       |
| **`message.reasoning` fallback** | Only emit when `reasoning_details` absent               | When both present, `reasoning` contains the same content as the details; skip to avoid duplication                    |
| **Gemini 3 finish reason fix**   | Override `"stop"` to `"tool_calls"` when conditions met | When encrypted reasoning + tool calls present but finish_reason is `"stop"`, the model incorrectly reports completion |
| **Timestamp source**             | `DateTime.fromDateUnsafe(new Date(created * 1000))`     | Matches OpenAI provider pattern (line 948-953)                                                                        |
| **Image handling**               | Data URIs -> `file` parts, URLs -> `source` parts       | Data URIs contain inline binary data; URLs are references                                                             |

---

## 3. API Response Types

### `SendChatCompletionRequest200`

```typescript
// packages/ai/openrouter/src/Generated.ts:8637
{
  id: string
  choices: ReadonlyArray<ChatResponseChoice>
  created: number
  model: string
  object: "chat.completion"
  system_fingerprint?: string | null
  usage?: ChatGenerationTokenUsage
}
```

### `ChatResponseChoice`

```typescript
// Generated.ts:4791
{
  finish_reason: "tool_calls" | "stop" | "length" | "content_filter" | "error" | null
  index: number
  message: AssistantMessage
  logprobs?: ChatMessageTokenLogprobs | null
}
```

### `AssistantMessage`

```typescript
// Generated.ts:4568
{
  role: "assistant"
  content?: string | ReadonlyArray<ChatMessageContentItem> | null
  name?: string
  tool_calls?: ReadonlyArray<ChatMessageToolCall>
  refusal?: string | null
  reasoning?: string | null
  reasoning_details?: ReadonlyArray<ReasoningDetails>
  images?: ReadonlyArray<{ image_url: { url: string } }>
}
```

### `ChatMessageToolCall`

```typescript
// Generated.ts:2758
{
  id: string
  type: "function"
  function: { name: string, arguments: string }
}
```

### `ChatGenerationTokenUsage`

```typescript
// Generated.ts:2788
{
  completion_tokens: number
  prompt_tokens: number
  total_tokens: number
  completion_tokens_details?: {
    reasoning_tokens?: number | null
    audio_tokens?: number | null
    accepted_prediction_tokens?: number | null
    rejected_prediction_tokens?: number | null
  } | null
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
    audio_tokens?: number
    video_tokens?: number
  } | null
}
```

---

## 4. Implementation Phases

### Phase 1: Utility Functions

**Goal**: Add `resolveFinishReason` to internal utilities.

**Files to modify**:

- `packages/ai/openrouter/src/internal/utilities.ts`

**Tasks**:

- [x] **1.1** Add `import type * as Response from "effect/unstable/ai/Response"` to `internal/utilities.ts`
- [x] **1.2** Add `finishReasonMap` constant mapping OpenRouter finish reasons (`content_filter`, `stop`, `length`, `tool_calls`, `error`) to Effect SDK `FinishReason` values. Pattern: `packages/ai/openai/src/internal/utilities.ts:9-15`
- [x] **1.3** Add `resolveFinishReason(finishReason: string | null | undefined, hasToolCalls: boolean): Response.FinishReason` function. When `finishReason` is null, return `"tool-calls"` if `hasToolCalls`, else `"stop"`. When mapped value is null, return `"tool-calls"` if `hasToolCalls`, else `"unknown"`. Pattern: `packages/ai/openai/src/internal/utilities.ts:21-33`
- [x] **1.4** Run `pnpm lint-fix`

**Verification**: `pnpm check` passes

### Phase 2: Module Augmentation and Imports

**Goal**: Add required imports and populate the empty `Response` module augmentation with provider metadata types.

**Files to modify**:

- `packages/ai/openrouter/src/OpenRouterLanguageModel.ts`

**Tasks**:

- [x] **2.1** Add imports: `import * as DateTime from "effect/DateTime"`, `import * as Redactable from "effect/Redactable"`, `import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"`, `import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"`
- [x] **2.2** Update import at line 27 to: `import { ReasoningDetailsDuplicateTracker, resolveFinishReason } from "./internal/utilities.ts"`
- [x] **2.3** Populate `declare module "effect/unstable/ai/Response" {}` (line 167) with:

```typescript
declare module "effect/unstable/ai/Response" {
  export interface ReasoningPartMetadata extends ProviderMetadata {
    readonly openrouter?: {
      readonly reasoningDetails?: ReasoningDetails | null
    } | null
  }

  export interface ToolCallPartMetadata extends ProviderMetadata {
    readonly openrouter?: {
      readonly reasoningDetails?: ReasoningDetails | null
    } | null
  }

  export interface FinishPartMetadata extends ProviderMetadata {
    readonly openrouter?: {
      readonly systemFingerprint?: string | null
      readonly usage?: typeof Generated.ChatGenerationTokenUsage.Encoded | null
    } | null
  }
}
```

- [x] **2.4** Run `pnpm lint-fix`

**Verification**: `pnpm check` passes

### Phase 3: HTTP Detail Helpers

**Goal**: Add HTTP request/response detail builders for telemetry.

**Files to modify**:

- `packages/ai/openrouter/src/OpenRouterLanguageModel.ts`

**Tasks**:

- [x] **3.1** Add `buildHttpRequestDetails` function above the Response Conversion section (near line 490). Pattern: `packages/ai/openai/src/OpenAiLanguageModel.ts:896-904`

```typescript
const buildHttpRequestDetails = (
  request: HttpClientRequest.HttpClientRequest
): typeof Response.HttpRequestDetails.Type => ({
  method: request.method,
  url: request.url,
  urlParams: Array.from(request.urlParams),
  hash: request.hash,
  headers: Redactable.redact(request.headers) as Record<string, string>
})
```

- [x] **3.2** Add `buildHttpResponseDetails` function. Pattern: `packages/ai/openai/src/OpenAiLanguageModel.ts:906-911`

```typescript
const buildHttpResponseDetails = (
  response: HttpClientResponse.HttpClientResponse
): typeof Response.HttpResponseDetails.Type => ({
  status: response.status,
  headers: Redactable.redact(response.headers) as Record<string, string>
})
```

- [x] **3.3** Run `pnpm lint-fix`

**Verification**: `pnpm check` passes

### Phase 4: Usage Helper

**Goal**: Add token usage mapping from OpenRouter format to Effect SDK format.

**Files to modify**:

- `packages/ai/openrouter/src/OpenRouterLanguageModel.ts`

**Tasks**:

- [x] **4.1** Add `getUsage` function that maps `ChatGenerationTokenUsage` to `Response.Usage`. Pattern: `packages/ai/openai/src/OpenAiLanguageModel.ts:2551-2586`

```typescript
const getUsage = (usage: Generated.ChatGenerationTokenUsage | undefined): Response.Usage => {
  if (Predicate.isUndefined(usage)) {
    return {
      inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined }
    }
  }
  const promptTokens = usage.prompt_tokens
  const completionTokens = usage.completion_tokens
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    inputTokens: {
      uncached: promptTokens - cachedTokens - cacheWriteTokens,
      total: promptTokens,
      cacheRead: cachedTokens,
      cacheWrite: cacheWriteTokens
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens - reasoningTokens,
      reasoning: reasoningTokens
    }
  }
}
```

- [x] **4.2** Run `pnpm lint-fix`

**Verification**: `pnpm check` passes

### Phase 5: Implement `makeResponse`

**Goal**: Replace the `makeResponse` stub with the full implementation.

**Files to modify**:

- `packages/ai/openrouter/src/OpenRouterLanguageModel.ts`

**Tasks**:

- [x] **5.1** Replace the stub at lines 493-501 with new function signature:

```typescript
const makeResponse = Effect.fnUntraced(
  function*({ options, rawResponse, response }: {
    readonly options: LanguageModel.ProviderOptions
    readonly rawResponse: Generated.SendChatCompletionRequest200
    readonly response: HttpClientResponse.HttpClientResponse
  }): Effect.fn.Return<Array<Response.PartEncoded>, AiError.AiError, IdGenerator.IdGenerator> {
```

- [x] **5.2** Add response-metadata part:

```typescript
const parts: Array<Response.PartEncoded> = []
let hasToolCalls = false
let hasEncryptedReasoning = false

const createdAt = new Date(rawResponse.created * 1000)
parts.push({
  type: "response-metadata",
  id: rawResponse.id,
  modelId: rawResponse.model,
  timestamp: DateTime.formatIso(DateTime.fromDateUnsafe(createdAt)),
  request: buildHttpRequestDetails(response.request)
})
```

- [x] **5.3** Extract first choice and process `reasoning_details`. For each detail:
  - `reasoning.summary` -> reasoning part with `text: detail.summary`
  - `reasoning.encrypted` -> reasoning part with `text: ""`, set `hasEncryptedReasoning = true`
  - `reasoning.text` -> reasoning part with `text: detail.text ?? ""`
  - Each gets `metadata: { openrouter: { reasoningDetails: [detail] } }`

- [x] **5.4** Process `message.reasoning` as fallback - only emit a reasoning part when `reasoning_details` is absent/empty, to avoid duplication

- [x] **5.5** Process `message.content` - handle both `string` and `ReadonlyArray<ChatMessageContentItem>` cases. For strings, push a text part if non-empty. For arrays, iterate and push text parts for `type: "text"` items.

- [x] **5.6** Process `message.tool_calls`:
  - Set `hasToolCalls = true`
  - Parse arguments with `Tool.unsafeSecureJsonParse`, catch errors and wrap in `AiError.ToolParameterValidationError`
  - Attach `reasoningDetails` metadata only to the first tool call (prevents duplication in parallel tool calls)

- [x] **5.7** Process `message.images` - for data URIs (`url.startsWith("data:")`), parse into `{ type: "file", mediaType, data }`. For regular URLs, emit `{ type: "source", sourceType: "url", id, url, title }` using `idGenerator.generateId()`.

- [x] **5.8** Add Gemini 3 finish reason workaround: if `hasEncryptedReasoning && hasToolCalls && finishReason === "stop"`, override `finishReason` to `"tool_calls"`

- [x] **5.9** Add finish part with `resolveFinishReason(finishReason, hasToolCalls)`, `getUsage(rawResponse.usage)`, `buildHttpResponseDetails(response)`, and metadata `{ openrouter: { systemFingerprint, usage } }`

- [x] **5.10** Run `pnpm lint-fix`

**Verification**: `pnpm check` passes

### Phase 6: Wire Up `generateText`

**Goal**: Connect `makeResponse` to the `generateText` method.

**Files to modify**:

- `packages/ai/openrouter/src/OpenRouterLanguageModel.ts`

**Tasks**:

- [x] **6.1** Replace lines 228-229:

```typescript
// Before:
return [] // TODO
// return yield* makeResponse({ options, rawResponse, response })

// After:
return yield * makeResponse({ options, rawResponse, response })
```

- [x] **6.2** Run `pnpm lint-fix`
- [x] **6.3** Run `pnpm check`
- [x] **6.4** Run `pnpm build`

**Verification**: `pnpm check` and `pnpm build` pass

---

## 5. Response Conversion Flow

Processing order within `makeResponse`:

```
1. response-metadata (id, model, timestamp, HTTP request details)
2. reasoning_details -> reasoning parts (with per-detail metadata)
3. message.reasoning -> reasoning part (fallback only if no details)
4. message.content -> text parts (string or array of content items)
5. message.tool_calls -> tool-call parts (secure JSON parse, first gets reasoning metadata)
6. message.images -> file parts (data URIs) or source parts (URLs)
7. Gemini 3 workaround (override finish_reason if needed)
8. finish part (reason, usage, HTTP response details, provider metadata)
```

---

## 6. Files Summary

| File                                                    | Changes                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/ai/openrouter/src/internal/utilities.ts`      | Add `resolveFinishReason` utility                                              |
| `packages/ai/openrouter/src/OpenRouterLanguageModel.ts` | Imports, Response augmentation, HTTP helpers, `getUsage`, `makeResponse`, wire |

### Reference Files (read-only)

| File                                                  | What to reference                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/ai/openai/src/OpenAiLanguageModel.ts`       | `makeResponse` at :919, `getUsage` at :2551, HTTP helpers at :896 |
| `packages/ai/anthropic/src/AnthropicLanguageModel.ts` | `makeResponse` at :1243, finish part at :1626                     |
| `packages/ai/openai/src/internal/utilities.ts`        | `resolveFinishReason` at :21                                      |
| `packages/effect/src/unstable/ai/Response.ts`         | All response part type definitions                                |
| `packages/ai/openrouter/src/Generated.ts`             | API response types                                                |

---

## 7. Verification

1. `pnpm lint-fix`
2. `pnpm check` (if fails, `pnpm clean && pnpm check`)
3. `pnpm build`
4. `pnpm docgen`
