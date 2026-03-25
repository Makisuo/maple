# Previous Response ID Tracking

## Overview

Add a core mechanism for tracking provider response IDs (e.g., OpenAI's `resp_123`)
and filtering prompts to only include unsent parts. A `ResponseIdTracker` is created
per client (e.g., one per `OpenAiClient` instance) and passed as an optional parameter
to `LanguageModel.make`. The tracker owns both the response ID state and the
incremental prompt computation, exposing a `prepareUnsafe` method that returns an `Option`
of `previousResponseId` and `incrementalPrompt` together. The core `LanguageModel`
module calls `prepareUnsafe` before each provider invocation and passes the result through
`ProviderOptions`. Providers ignore these new fields for now — this spec builds the
foundation for a future change where providers that support incremental input (OpenAI
Responses API) use the filtered prompt + `previous_response_id`.

This is transport-agnostic: the same filtered prompt will serve both HTTP and future
WebSocket mode, where each turn sends `{ type: "response.create", previous_response_id, input: <incremental> }`.

## Goals

- Add a `ResponseIdTracker` module that stores response IDs per prompt part via a `WeakMap`. One tracker is created per client (e.g., `OpenAiClient`) and shared across all `LanguageModel` instances backed by that client.
- Accept an optional `tracker` parameter in `LanguageModel.make`'s `ConstructorParams`, so providers that support response ID tracking can pass their client's tracker. Providers that don't (Anthropic, OpenRouter) simply omit it.
- Expose a `prepareUnsafe` method on the tracker that takes the current prompt and returns `Option<{ previousResponseId, prompt }>` — `Some` when incremental input is possible, `None` otherwise.
- Automatically extract `ResponseMetadataPart.id` from provider responses and associate it with sent prompt parts via `markParts`.
- Pass both the full prompt and the incremental prompt to providers via `ProviderOptions`.
- Proactively clear the tracker when a session/connection is known to have dropped, avoiding a wasted round-trip with a stale response ID.
- Ensure the architecture enables a future WebSocket transport without changes to the filtering logic.

## Non-Goals

- Changing provider behavior. All providers continue to use `options.prompt` (the full prompt). The new `ProviderOptions` fields are populated by the core but ignored by providers. A future spec will wire `incrementalPrompt` and `previousResponseId` into provider request construction, `previous_response_not_found` retry logic, etc.
- WebSocket transport implementation (separate spec). This spec provides the foundation: response ID tracking, prompt filtering, and `ProviderOptions` fields that a WebSocket transport will consume.
- WebSocket connection lifecycle management (connect, 60-min reconnect, `generate: false` warmup).
- Persistence of response IDs across process restarts (in-memory only).
- Changes to the `Chat` service — `Chat` implicitly benefits since it calls `LanguageModel.generateText`/`streamText`.
- Changes to `Prompt` or `Response` module schemas.

## Current State

### Response ID Capture

`Response.ResponseMetadataPart` already has an `id` field (`Response.ts:2191-2195`) populated by providers:

- **OpenAI non-streaming** (`OpenAiLanguageModel.ts:954-955`): `id: rawResponse.id`
- **OpenAI streaming** (`OpenAiLanguageModel.ts:1392-1393`): `id: event.response.id`

### Response ID Not Forwarded

The response ID is captured in `ResponseMetadataPart` but never forwarded to subsequent requests:

1. `Prompt.fromResponseParts()` (`Prompt.ts:1930-2041`) drops `ResponseMetadataPart` — no `case "response-metadata"`.
2. `LanguageModel.ProviderOptions` (`LanguageModel.ts:571-625`) has no field for a previous response ID.
3. The OpenAI provider's `Config` includes `previous_response_id` implicitly (via `Partial<Omit<CreateResponse.Encoded, ...>>`) but it is static configuration, not automatically managed.

### OpenAI Config Mechanism

`Config` (`OpenAiLanguageModel.ts:62-102`) spreads into the request at line 377-378:

```ts
const request: typeof Generated.CreateResponse.Encoded = {
  ...config,
  input: messages,
  ...
}
```

`previous_response_id` from Config already flows into the request. The gap is that nothing automatically sets it.

### Transport Surface

`OpenAiClient` (`OpenAiClient.ts`) exposes two methods:

- `createResponse` (line 187) — HTTP POST to `/responses`, returns `[body, response]`
- `createResponseStream` (line 224) — HTTP POST to `/responses` with `stream: true`, returns `[response, eventStream]`

Both consume the same request body shape (`Generated.CreateResponse.Encoded`). A future WebSocket transport would wrap this same body in `{ type: "response.create", ...body }` and send it over `wss://api.openai.com/v1/responses`. The request body construction (`makeRequest`) is already decoupled from transport — no changes needed for WebSocket readiness.

### Other Providers

- **Anthropic**: Emits `response-metadata` parts but does not support `previous_response_id`. No changes needed.
- **OpenRouter**: Same as Anthropic.

### Existing Implementation

`ResponseIdTracker.ts` already exists with a `Service` interface providing `get`, `set`, `clear`, `onSessionDrop`, `markParts`, and `hasPart`. The `make` constructor uses a `Ref` for the response ID and a `WeakSet<object>` for tracking sent prompt parts. After this refactor, `get`, `set`, and `hasPart` are removed from the public interface. The `Ref` and `WeakSet` are replaced by a single `WeakMap<object, string>` mapping each sent prompt part to the response ID from that request. `set` merges into `markParts`, which now accepts a `responseId` parameter. `prepareUnsafe` returns `Option<{ previousResponseId, prompt }>`, subsumes the external use cases of `get` and `hasPart`. The `ServiceMap.Service` class and `layer` export are removed — the tracker is created per client and passed as a value, not resolved from context.

`LanguageModel.ts` contains `computeIncrementalPrompt` and `IncrementalResult` as standalone entities (lines 557-604), but they are currently voided (not wired into the orchestrator).

## Proposed Design

### Step 1: Add Fields to `ProviderOptions`

Add two optional fields to `LanguageModel.ProviderOptions`:

```ts
// LanguageModel.ts:621
export interface ProviderOptions {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly responseFormat: ...
  readonly toolChoice: ToolChoice<any>
  readonly span: Span
  readonly previousResponseId: string | undefined       // NEW
  readonly incrementalPrompt: Prompt.Prompt | undefined  // NEW
}
```

- `prompt` — always the full conversation prompt (unchanged).
- `previousResponseId` — the response ID from the prior turn (if tracked). Provider-agnostic hint.
- `incrementalPrompt` — the prompt filtered to only include messages after the last assistant turn. `undefined` when no prior response ID exists (first turn) or when the tracker is not active.

Providers that support incremental input use `incrementalPrompt` when available, falling back to `prompt` for retry or when `incrementalPrompt` is undefined. Providers that don't support incremental input ignore both new fields and use `prompt` as before. Adding optional fields to a parameter type is non-breaking.

### Step 2: Move Filtering Logic into `ResponseIdTracker.prepareUnsafe`

The `computeIncrementalPrompt` function and `IncrementalResult` type are deleted from
`LanguageModel.ts`. Their logic is inlined into the `prepareUnsafe` method on the tracker,
which combines per-part response ID lookup with incremental prompt computation in a
single call. No separate internal helper is needed since the `WeakMap` serves as both
the part-tracking set and the response ID store.

#### Updated Service Interface

```ts
export interface Service {
  readonly clear: Effect.Effect<void>
  readonly onSessionDrop: Effect.Effect<void>
  readonly markParts: (parts: ReadonlyArray<object>, responseId: string) => void
  readonly prepareUnsafe: (prompt: Prompt.Prompt) => Option.Option<{
    readonly previousResponseId: string
    readonly prompt: Prompt.Prompt
  }>
}
```

**Removed from previous interface:**

- `get` — subsumed by `prepareUnsafe`, which reads response IDs from the `WeakMap` internally.
  No external consumer needs the raw `Option<string>`.
- `set` — merged into `markParts`. The response ID is now stored per-part in the
  `WeakMap` when parts are marked, rather than in a separate `Ref`. This enables a
  single tracker to be shared across multiple conversations since each conversation's
  parts map to their own response IDs.
- `hasPart` — `prepareUnsafe` accesses the `WeakMap` directly. No external code checks
  individual parts.

#### `prepareUnsafe` Return Type

`prepareUnsafe` returns `Option<{ previousResponseId: string; prompt: Prompt.Prompt }>`:

- `Some({ previousResponseId, prompt })` — prompt parts before the last assistant turn are tracked in the `WeakMap` and the prompt extends beyond it. Contains the response ID (from the `WeakMap`) and the filtered prompt (messages after the last assistant turn).
- `None` — any non-incremental case: no tracked parts (first turn, post-clear, post-session-drop), diverged prefix (system prompt replaced, message edited), no assistant turn, or no new content after the last assistant turn. The caller sends the full prompt with no `previousResponseId`.

Using `Option` instead of a discriminated union reflects the fact that all non-incremental cases are handled identically — send full prompt, no `previousResponseId`, no tracker clear. The distinction between "diverged" and "no tracked parts" is not actionable.

#### `prepareUnsafe` Implementation

The filtering logic is inlined into `prepareUnsafe` rather than delegated to a separate
helper. The `WeakMap` serves as both the part-tracking set and the response ID store.

```ts
prepareUnsafe: (prompt) => {
  const messages = prompt.content

  // Quick check: if no prompt parts are tracked at all, no prior context exists
  let anyTracked = false
  for (const msg of messages) {
    if (sentParts.has(msg)) {
      anyTracked = true
      break
    }
  }
  if (!anyTracked) {
    return Option.none()
  }

  // Find last assistant message
  let lastAssistantIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i
      break
    }
  }
  if (lastAssistantIndex === -1) {
    return Option.none()
  }

  // Verify all parts before last assistant are tracked; extract response ID
  let responseId: string | undefined
  for (let i = 0; i < lastAssistantIndex; i++) {
    const id = sentParts.get(messages[i])
    if (id === undefined) {
      // Diverged: untracked part in prefix (system prompt changed, message edited).
      // Return None — same action as no tracked parts. Old parts naturally GC'd.
      return Option.none()
    }
    responseId = id
  }
  if (responseId === undefined) {
    return Option.none()
  }

  const partsAfterLastAssistant = messages.slice(lastAssistantIndex + 1)
  if (partsAfterLastAssistant.length === 0) {
    return Option.none()
  }

  return Option.some({
    previousResponseId: responseId,
    prompt: Prompt.fromMessages(partsAfterLastAssistant)
  })
}
```

**`anyTracked` guard:** Distinguishes "never tracked / post-clear" from
"tracked but prefix is broken" at the logging level, though both return `Option.none()`.
Without this guard, a cleared tracker whose prompt still contains an assistant turn
would hit the per-part check and waste cycles scanning parts that can't possibly be
in the `WeakMap`.

**Why check parts before the last assistant message, not including it?** The last assistant message corresponds to the response the server generated for `previousResponseId`. The server inherently has it — we never sent it. It won't be in the `WeakMap` because only parts from the *sent prompt* are marked. Everything before it was part of a prompt we sent in a prior request and should be in the `WeakMap` if the context hasn't changed.

**Automatic system prompt change detection:** A changed system prompt is a new object that won't be in the `WeakMap`, so `prepareUnsafe` returns `None` automatically. The orchestrator sends the full prompt — no caller awareness needed. After the re-send, `markParts` populates the new parts.

**Multi-conversation safety:** Since the `WeakMap` keys on object identity, parts from different conversations are naturally isolated. Conversation A's parts map to conversation A's response IDs, and conversation B's parts map to conversation B's. A single tracker instance can be shared across conversations without interference.

**Boundary cases:**

| Scenario | Result |
|----------|--------|
| First turn: `[sys, user1]` | `None` (no parts tracked, no assistant turn) |
| No parts tracked (fresh/post-clear) | `None` (`anyTracked` is false) |
| Simple follow-up: `[sys, user1, asst1, user2]` | `Some({ previousResponseId: "resp_1", prompt: [user2] })` |
| Tool results: `[sys, user1, asst1(calls), tool(results)]` | `Some({ previousResponseId: "resp_1", prompt: [tool(results)] })` |
| Multi-step: `[..., asst(calls), tool(results), user2]` | `Some({ previousResponseId: "resp_1", prompt: [tool(results), user2] })` |
| No new messages after assistant: `[sys, user1, asst1]` | `None` (server already has everything) |
| Multi-turn, no new: `[sys, user1, asst1, user2, asst2]` | `None` (nothing after last assistant) |
| System prompt changed: `[sys_new, user1, asst1, user2]` | `None` — `sys_new` not in WeakMap (diverged) |
| Middle user message edited: `[sys, user1_edited, asst1, user2]` | `None` — `user1_edited` not in WeakMap (diverged) |
| Multiple edits: `[sys_new, user1_edited, asst1, user2]` | `None` — `sys_new` not in WeakMap (first miss short-circuits) |
| After session drop + reconnect (fresh full send): `[sys, user1, asst1, user2]` | `Some` — all pre-assistant parts re-marked by the full send |
| Multi-conversation: conv A `[sysA, u1A, asst1A, u2A]`, conv B `[sysB, u1B]` on shared tracker | Conv A → `Some` (parts map to A's ID); Conv B → `None` (no assistant yet) |

#### Updated `ResponseIdTracker.ts` (Full File)

```ts
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Prompt from "./Prompt.ts"

export interface PrepareResult {
  readonly previousResponseId: string
  readonly prompt: Prompt.Prompt
}

export interface Service {
  readonly clear: Effect.Effect<void>
  readonly onSessionDrop: Effect.Effect<void>
  readonly markParts: (parts: ReadonlyArray<object>, responseId: string) => void
  readonly prepareUnsafe: (prompt: Prompt.Prompt) => Option.Option<PrepareResult>
}

// -- constructor -------------------------------------------------------------

export const make: Effect.Effect<Service> = Effect.sync(() => {
  let sentParts = new WeakMap<object, string>()

  const clear = Effect.sync(() => {
    sentParts = new WeakMap<object, string>()
  })

  return {
    clear,
    onSessionDrop: clear,
    markParts: (parts, responseId) => {
      for (const part of parts) {
        sentParts.set(part, responseId)
      }
    },
    prepareUnsafe: (prompt) => {
      const messages = prompt.content

      let anyTracked = false
      for (const msg of messages) {
        if (sentParts.has(msg)) {
          anyTracked = true
          break
        }
      }
      if (!anyTracked) {
        return Option.none()
      }

      let lastAssistantIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          lastAssistantIndex = i
          break
        }
      }
      if (lastAssistantIndex === -1) {
        return Option.none()
      }

      let responseId: string | undefined
      for (let i = 0; i < lastAssistantIndex; i++) {
        const id = sentParts.get(messages[i])
        if (id === undefined) {
          return Option.none()
        }
        responseId = id
      }
      if (responseId === undefined) {
        return Option.none()
      }

      const partsAfterLastAssistant = messages.slice(lastAssistantIndex + 1)
      if (partsAfterLastAssistant.length === 0) {
        return Option.none()
      }

      return Option.some({
        previousResponseId: responseId,
        prompt: Prompt.fromMessages(partsAfterLastAssistant)
      })
    }
  }
})
```

### Step 3: Core Integration in `LanguageModel.make`

With filtering logic moved into the tracker, the `LanguageModel.make` orchestrator
becomes simpler. The `computeIncrementalPrompt` function and `IncrementalResult`
type are **removed** from `LanguageModel.ts` (including the `void computeIncrementalPrompt`
suppression line). Tracker access is no longer resolved from context inside
`LanguageModel.make`; it is received via constructor params. A type-only
`ResponseIdTracker` import remains for `ConstructorParams`.

#### `ConstructorParams` Change

Add an optional `tracker` field:

```ts
export interface ConstructorParams {
  readonly generateText: ...
  readonly streamText: ...
  readonly tracker?: ResponseIdTracker.Service  // NEW
}
```

When `tracker` is provided, `LanguageModel.make` calls `tracker.prepareUnsafe` and
`tracker.markParts`. When omitted, tracking is skipped — `previousResponseId`
and `incrementalPrompt` stay `undefined`.

#### Integration in `LanguageModel.make`

```ts
export const make: (params: ConstructorParams) => Effect.Effect<Service> =
  Effect.fnUntraced(function*(params) {
    const tracker = params.tracker
    // ... existing setup ...
  })
```

**All three methods (`generateText`, `generateObject`, `streamText`):**

Both `generateText` and `generateObject` delegate to the shared `generateContent` helper (`LanguageModel.ts:932`), which constructs `ProviderOptions` and calls `params.generateText(providerOptions)`. The tracker logic should be placed at the `generateContent` level — not duplicated in each call site. `streamText` has its own path via `streamContent` (`LanguageModel.ts:1093`).

`tracker.prepareUnsafe` must be called **after** tool approval resolution, because
`generateContent` may mutate `providerOptions.prompt` during approval resolution
(`LanguageModel.ts:1006-1049`), appending tool result messages and stripping
resolved approval artifacts. The `prepareUnsafe` call must see the final prompt.

In `generateContent`, the call goes immediately before the provider invocation
(after line ~1049, after approval resolution and prompt stripping):

```ts
// ... tool approval resolution and prompt stripping above ...

if (tracker) {
  const prepared = tracker.prepareUnsafe(providerOptions.prompt)
  if (Option.isSome(prepared)) {
    providerOptions.previousResponseId = prepared.value.previousResponseId
    providerOptions.incrementalPrompt = prepared.value.prompt
  }
}

// ... provider invocation below (params.generateText(providerOptions)) ...
```

The same pattern applies in `streamContent` (after approval resolution, before
`params.streamText(providerOptions)`).

**`None` handling:** When `prepareUnsafe` returns `None` — whether because no parts are
tracked, the prefix diverged, or there's nothing new after the last assistant turn
— the orchestrator sends the full prompt with no `previousResponseId`. The tracker
is never cleared on divergence because the `WeakMap` is shared across conversations;
clearing would wipe all conversations' tracked parts. Old diverged parts are naturally
GC'd by the `WeakMap` when no longer referenced. After the full re-send succeeds,
`markParts` populates the new parts. When `tracker` is not provided (e.g., Anthropic),
all tracking is skipped and `ProviderOptions` fields stay `undefined`.

After the provider returns, mark sent parts in the `WeakMap` with the response ID:

**Non-streaming (`generateText`, `generateObject`):**

```ts
const content = yield* generateContent(options, providerOptions)

if (tracker) {
  const metadataPart = content.find((p) => p.type === "response-metadata")
  if (metadataPart && metadataPart.id) {
    tracker.markParts(providerOptions.prompt.content, metadataPart.id)
  }
}
```

**Streaming (`streamText`):**

```ts
const stream = yield* streamContent(options, providerOptions)

return stream.pipe(
  Stream.mapArrayEffect((part) => {
    if (tracker && part.type === "response-metadata" && part.id) {
      tracker.markParts(providerOptions.prompt.content, part.id)
    }
    return Effect.succeed(part)
  })
)
```

**Note on `markParts` timing:** Parts are marked after the response ID is known — non-streaming after the response completes, streaming when the `response-metadata` part arrives. If the request fails or no response ID is emitted, parts are not marked, which is correct — the server context can't be resumed.

### Step 4: Create Tracker Per Client

The `ResponseIdTracker` is created once per `OpenAiClient` instance and exposed as
a field on the client's service interface. `OpenAiLanguageModel.make` reads it from
the client and passes it to `LanguageModel.make` via the `tracker` constructor param.

#### `OpenAiClient` Changes

Add a `tracker` field to the `OpenAiClient` service interface:

```ts
export interface Service {
  readonly createResponse: ...
  readonly createResponseStream: ...
  readonly tracker: ResponseIdTracker.Service  // NEW
}
```

In the client's Layer/constructor, create the tracker alongside the HTTP client:

```ts
const tracker = yield* ResponseIdTracker.make

return {
  createResponse,
  createResponseStream,
  tracker
}
```

Every `OpenAiClient` instance gets its own tracker. The tracker lifecycle is tied
to the client — all `OpenAiLanguageModel` instances sharing the same client share
the same tracker, which matches server-side state (one response chain per API key /
connection context).

The same change applies to the OpenAI compat client (`packages/ai/openai-compat`).

#### `OpenAiLanguageModel.make` Changes

```ts
export const make = Effect.fnUntraced(function*({ model, config: providerConfig }) {
  const client = yield* OpenAiClient

  // ... existing makeConfig, makeRequest, etc. ...

  return yield* LanguageModel.make({
    generateText,
    streamText,
    tracker: client.tracker  // NEW — pass client's tracker
  })
})
```

No `Effect.provideService` needed. The tracker flows as a plain value.

#### Anthropic / OpenRouter — No Changes

These providers don't support `previous_response_id`. Since `tracker` is optional
in `ConstructorParams`, they simply don't pass it. No dummy tracker, no type
satisfaction boilerplate.

**No provider behavior changes.** The OpenAI provider continues to use `options.prompt` (the full prompt) for all requests. The new `ProviderOptions` fields (`previousResponseId`, `incrementalPrompt`) are populated by the core but ignored by all providers for now. A future spec will wire these fields into the provider's `prepareMessages` and `makeRequest` to enable incremental input and `previous_response_not_found` retry.

The tracker reference on the client is also available to the transport layer. A future WebSocket transport reads `client.tracker` and calls `tracker.onSessionDrop` whenever the connection closes (network error, 60-min limit, explicit server close). For the current HTTP transport, no session lifecycle exists, so no wiring is needed.

## WebSocket Mode Compatibility

This design is explicitly structured to enable a future WebSocket transport with no changes to the filtering or tracking logic.

### What WebSocket mode requires (from OpenAI docs)

1. Persistent connection to `wss://api.openai.com/v1/responses`
2. Each turn sends `{ type: "response.create", previous_response_id, input: <incremental>, model, tools, ... }`
3. Server keeps ONE previous-response state in connection-local memory — continuing from that is fast
4. One in-flight response at a time per connection (sequential, no multiplexing)
5. 60-minute connection limit; must reconnect
6. `previous_response_not_found` when cached ID is evicted (or `store=false` + reconnect)
7. Server events match HTTP streaming event model

### How this spec provides the foundation

| WebSocket need | Provided by this spec |
|----------------|----------------------|
| `previous_response_id` | `ProviderOptions.previousResponseId` via `tracker.prepareUnsafe` |
| Incremental input items | `ProviderOptions.incrementalPrompt` via `tracker.prepareUnsafe` |
| `previous_response_not_found` recovery | `tracker.clear` + `ProviderOptions.prompt` (full) available for future retry logic |
| Session drop / reconnect | `client.tracker.onSessionDrop` clears stale ID; next request sends full prompt |
| Same request body shape | `makeRequest` produces transport-neutral `CreateResponse.Encoded` body |
| Sequential processing | `Chat` serializes via semaphore; tracker resolves per-part IDs |

### What a future WebSocket spec adds (not in this spec)

- **WebSocket transport service**: An alternative to `OpenAiClient.createResponse`/`createResponseStream` that wraps the request body in `{ type: "response.create", ...body }` and sends over WebSocket.
- **Connection lifecycle**: Connect, reconnect on 60-min limit, handle `websocket_connection_limit_reached`. On any connection close, call `client.tracker.onSessionDrop` before reconnecting.
- **Error normalization**: WebSocket error events (`{ "type": "error", ... }`) must be normalized to the same `AiError` shape so `isPreviousResponseNotFound` works unchanged.
- **`generate: false` warmup**: Pre-warm server state by sending `response.create` with `generate: false`. Returns a response ID storable in the tracker.
- **Compaction integration**: After standalone `/responses/compact`, start a new chain with compacted input by clearing the tracker and sending full compacted prompt.

### Reconnection and tracker behavior

When a session or connection drops, the transport MUST call `client.tracker.onSessionDrop` immediately. This proactively clears the stale response ID so the next request sends the full prompt without first attempting (and failing with) the old ID.

**WebSocket reconnection flow:**
1. WebSocket connection drops (network error, 60-min limit, server close).
2. Transport detects the close event and calls `client.tracker.onSessionDrop`.
3. Tracker replaces `WeakMap` with a fresh instance (all tracked parts forgotten).
4. Transport establishes a new connection.
5. Next `prepareUnsafe` call sees no tracked parts → returns `None` → caller sends full prompt.
6. Response ID from the new response is stored in the tracker, resuming the chain on the new connection.

**HTTP transport:** No persistent session exists, so there is no session drop to detect. If the server evicts a cached response between HTTP requests, a future `previous_response_not_found` retry mechanism (deferred to the provider consumption spec) will handle recovery.

**Safety net:** Even with proactive clearing via `onSessionDrop`, a future `previous_response_not_found` retry mechanism will provide an additional safety net for edge cases where the drop notification races with an in-flight request, or where the server evicts the response for reasons unrelated to a connection drop (e.g., `store: false`, server-side TTL expiry).

## Impacted Files

### Core

- `packages/effect/src/unstable/ai/ResponseIdTracker.ts` — Replace `Ref<Option<string>>` + `WeakSet<object>` with `WeakMap<object, string>`. Remove `set` from service interface. Update `markParts` to accept `responseId` parameter. Add `prepareUnsafe` method returning `Option<PrepareResult>` and `PrepareResult` interface. Replace `Ref` import with `Option` import. Add `Prompt` import. Remove `ServiceMap.Service` class and `layer` export.
- `packages/effect/src/unstable/ai/LanguageModel.ts` — Add `previousResponseId` and `incrementalPrompt` to `ProviderOptions`. Add optional `tracker` field to `ConstructorParams` (with a type-only `ResponseIdTracker` import). Remove `computeIncrementalPrompt`, `IncrementalResult`, and the void suppression line. Guard tracker calls on `params.tracker` presence in `generateContent`/`streamContent`.

### OpenAI Client

- `packages/ai/openai/src/OpenAiClient.ts` — Add `tracker: ResponseIdTracker.Service` field to the client service interface. Create tracker via `ResponseIdTracker.make` in the client's Layer constructor.
- `packages/ai/openai-compat/src/OpenAiClient.ts` — Same as OpenAI client: add `tracker` field, create in Layer.

### OpenAI Provider

- `packages/ai/openai/src/OpenAiLanguageModel.ts` — Pass `client.tracker` to `LanguageModel.make` via the `tracker` constructor param. No `Effect.provideService` needed.

### OpenAI Compat Provider

- `packages/ai/openai-compat/src/OpenAiLanguageModel.ts` — Same as OpenAI provider: pass `client.tracker` to `LanguageModel.make`.

### Unaffected

- `packages/ai/anthropic/src/AnthropicLanguageModel.ts` — No changes. `tracker` is optional; Anthropic doesn't pass one.
- `packages/ai/openrouter/src/OpenRouterLanguageModel.ts` — No changes. OpenRouter doesn't pass a tracker.
- `packages/effect/src/unstable/ai/Prompt.ts` — No changes.
- `packages/effect/src/unstable/ai/Response.ts` — No changes.
- `packages/effect/src/unstable/ai/Chat.ts` — No changes. Implicitly benefits.
- `packages/effect/test/unstable/ai/utils.ts` — No changes. Test helper doesn't need to provide a tracker since it's an optional constructor param.

### Barrel Files

- `packages/effect/src/unstable/ai/index.ts` — Auto-generated via `pnpm codegen`.

## Implementation Plan (PR Sequence)

### PR 1: Refactor ResponseIdTracker to WeakMap + Add ProviderOptions Fields

- Replace `Ref<Option<string>>` + `WeakSet<object>` with `WeakMap<object, string>` in `ResponseIdTracker.ts`
- Remove `set`, `get`, `hasPart` from `Service` interface
- Remove `ServiceMap.Service` class and `layer` export — tracker is a plain value, not a context service
- Update `markParts` signature to `(parts: ReadonlyArray<object>, responseId: string) => void`
- Add `PrepareResult` interface and `prepareUnsafe` method returning `Option<PrepareResult>` to `Service` interface
- Implement `prepareUnsafe` in the `make` constructor (inlined filtering logic)
- Replace `Ref` import with `Option` import in `ResponseIdTracker.ts`; add `Prompt` import. Remove `Layer` and `ServiceMap` imports.
- Move `computeIncrementalPrompt` and `IncrementalResult` from `LanguageModel.ts` (they are now inlined in `prepareUnsafe`, so simply delete them)
- Remove `void computeIncrementalPrompt` suppression line from `LanguageModel.ts`
- Add a type-only `import type * as ResponseIdTracker` in `LanguageModel.ts` for the optional `tracker` constructor parameter
- Add `previousResponseId` and `incrementalPrompt` to `ProviderOptions`
- Add optional `tracker` field to `ConstructorParams`
- Update all three `providerOptions` construction sites in `LanguageModel.make` to include the new fields (set to `undefined`): `generateText` (line 751), `generateObject` (line 811), `streamText` (line 883)
- Run `pnpm codegen` for barrel files
- Unit tests for `ResponseIdTracker.prepareUnsafe` covering all boundary cases (including divergence returning `None`)
- Unit tests for `ResponseIdTracker` basic operations (markParts/clear/onSessionDrop verified via `prepareUnsafe`)
- **Risk:** Low. Additive changes to `ProviderOptions` and `ConstructorParams` are non-breaking; filtering logic is moved, not changed.

### PR 2: Core Integration (Wire Tracker Through Clients)

- Add `tracker: ResponseIdTracker.Service` field to `OpenAiClient` service interface
- Create tracker via `ResponseIdTracker.make` in `OpenAiClient`'s Layer constructor
- Same for `openai-compat` client
- Pass `client.tracker` to `LanguageModel.make` in `OpenAiLanguageModel.make` (both `openai` and `openai-compat` packages)
- Guard `tracker.prepareUnsafe` and `tracker.markParts` calls on `params.tracker` presence in `generateContent` and `streamContent`
- Populate `ProviderOptions.previousResponseId` and `ProviderOptions.incrementalPrompt` when `Option.isSome`
- Mark sent parts via `tracker.markParts(prompt.content, responseId)` after provider returns (non-streaming) or when `response-metadata` part arrives (streaming)
- Integration tests verifying tracker lifecycle, prompt filtering, divergence recovery (full prompt re-send), and multi-conversation isolation
- **Risk:** Medium. Modifies client service interfaces and core orchestration. Anthropic/OpenRouter are unaffected.

### Future: Provider Consumption (separate spec)
- Wire `incrementalPrompt` and `previousResponseId` into OpenAI provider's `prepareMessages` and `makeRequest`
- Add `previous_response_not_found` error detection and retry logic
- Port to OpenAI compat provider

### Future: WebSocket Transport (separate spec)
- PRs 1-2 provide the full foundation. A WebSocket transport PR would:
  - Add a `WebSocketTransport` service as an alternative to HTTP `createResponse`/`createResponseStream`
  - Wrap request body in `{ type: "response.create", ...body }`
  - Parse server events (same event model as HTTP streaming)
  - Normalize WebSocket error events to `AiError`
  - Manage connection lifecycle (60-min limit, reconnection)
- **No changes to filtering, tracking, or ProviderOptions needed.**

## Test Plan

### `ResponseIdTracker.prepareUnsafe` Unit Tests

All tests below assume a tracker whose `WeakMap` has been populated by prior `markParts` calls as noted.

- No parts tracked, `[sys, user1]` → `None` (first turn, `anyTracked` is false)
- `markParts([sys, user1], "resp_1")`, `[sys, user1]` (no assistant message) → `None`
- `markParts([sys, user1], "resp_1")`, `[sys, user1, asst1, user2]` → `Some({ previousResponseId: "resp_1", prompt: [user2] })`
- `markParts([sys, user1], "resp_1")`, `[sys, user1, asst1(tool-calls), tool(results)]` → `Some({ previousResponseId: "resp_1", prompt: [tool(results)] })`
- `markParts([..prior..], "resp_1")`, `[..., asst(calls), tool(results), user2]` → `Some({ previousResponseId: "resp_1", prompt: [tool(results), user2] })`
- `markParts([sys, user1], "resp_1")`, `[sys, user1, asst1]` → `None` (no new messages)
- `markParts([sys, user1, asst1, user2], "resp_2")`, `[sys, user1, asst1, user2, asst2]` → `None` (multi-turn, no new messages after last assistant)
- Empty messages → `None`

**Context divergence (system prompt / message edits):**

- `markParts([sys, user1], "resp_1")`, `[sys_new, user1, asst1, user2]` (sys ≠ sys_new) → `None` (diverged prefix)
- `markParts([sys, user1], "resp_1")`, `[sys, user1_edited, asst1, user2]` (user1 ≠ user1_edited) → `None` (diverged prefix)
- `markParts([sys, user1], "resp_1")`, `[sys_new, user1_edited, asst1, user2]` → `None` (first miss short-circuits)

**After divergence recovery:**

- `markParts([sys_new, user1], "resp_2")` (after full re-send), `[sys_new, user1, asst1, user2]` → `Some({ previousResponseId: "resp_2", prompt: [user2] })`

**Full lifecycle (`markParts` → `prepareUnsafe` → `markParts` → `prepareUnsafe`):**

- Fresh tracker → `markParts([sys, user1], "resp_1")` → `prepareUnsafe([sys, user1, asst1, user2])` → `Some({ previousResponseId: "resp_1", prompt: [user2] })`
- Continue: `markParts([sys, user1, asst1, user2], "resp_2")` → `prepareUnsafe([sys, user1, asst1, user2, asst2, user3])` → `Some({ previousResponseId: "resp_2", prompt: [user3] })`

**Identity-based divergence (WeakMap invariant):**

- `markParts([msg1], "resp_1")` where `msg1 = makeMessage("user", ...)` → create `msg1Copy` with identical content but different reference → `prepareUnsafe` with `[msg1Copy, asst1, user2]` → `None` (msg1Copy ≠ msg1 by identity, so prefix diverged)

**`prepareUnsafe` after explicit `clear`:**

- `markParts([sys, user1], "resp_1")` → `clear` → `prepareUnsafe([sys, user1, asst1, user2])` → `None` (clear replaced WeakMap; old entries gone)

**Multi-conversation isolation:**

- `markParts([sysA, u1A], "resp_A1")` → `markParts([sysB, u1B], "resp_B1")` → `prepareUnsafe([sysA, u1A, asstA, u2A])` → `Some({ previousResponseId: "resp_A1", prompt: [u2A] })` (conversation A's parts unaffected by B)
- Same tracker, `prepareUnsafe([sysB, u1B, asstB, u2B])` → `Some({ previousResponseId: "resp_B1", prompt: [u2B] })` (conversation B's parts isolated)

### ResponseIdTracker Basic Unit Tests
- Fresh tracker → `prepareUnsafe([msg1])` → `None` (no parts tracked)
- `markParts([msg1], "resp_123")` → `prepareUnsafe([msg1, asst, msg2])` → `Some` with `previousResponseId: "resp_123"`
- `markParts([msg1], "resp_123")` → `clear` → `markParts([msg1_new], "resp_456")` → `prepareUnsafe([msg1_new, asst, msg2])` → `Some` with `previousResponseId: "resp_456"` (clear replaced WeakMap; new markParts works)
- `markParts([msg1], "resp_1")` → `markParts([msg1], "resp_2")` → `prepareUnsafe([msg1, asst, msg2])` → `Some` with `previousResponseId: "resp_2"` (later markParts overwrites)
- `markParts([msg1], "resp_123")` → `onSessionDrop` → `prepareUnsafe([msg1, asst, msg2])` → `None` (session drop replaced WeakMap)
- `markParts([msg1], "resp_123")` → `onSessionDrop` → `markParts([msg1_new], "resp_456")` → `prepareUnsafe([msg1_new, asst, msg2])` → `Some` with `previousResponseId: "resp_456"` (tracker resumes after reconnect)
- Concurrent `markParts`/`clear` from two fibers does not corrupt state

### LanguageModel Integration Tests
- `generateText` with `tracker` param: extracts response ID, marks parts via `markParts(prompt, id)`, `prepareUnsafe` returns `Some` on next call
- `generateObject` with `tracker` param: extracts response ID via shared `generateContent` path, marks parts, `prepareUnsafe` returns `Some` on next call
- `streamText` with `tracker` param: marks parts when `response-metadata` part is emitted with response ID
- With `tracker`: first call → `incrementalPrompt` is `undefined`, `previousResponseId` is `undefined`; second call → `incrementalPrompt` contains only new messages, `previousResponseId` is set
- Without `tracker` (omitted): `incrementalPrompt` and `previousResponseId` are always `undefined`
- Tool approval adds messages → `prepareUnsafe` is called after approval resolution with mutated prompt

### Chat Implicit Integration
- `Chat.generateText` tracks response IDs across sequential turns (implicit via LanguageModel)

### Session Drop / Reconnect Tests
- After `onSessionDrop`, next `prepareUnsafe` returns `None` → full prompt with no `previousResponseId`
- After `onSessionDrop` + new successful request, `prepareUnsafe` returns `Some` again
- `onSessionDrop` during idle (no in-flight request): next request uses full prompt
- Full cycle: track ID → session drop → full prompt → new ID tracked → `prepareUnsafe` returns `Some`

## Validation

- `pnpm lint-fix`
- `pnpm test <affected_test_files>`
- `pnpm check:tsgo` (run `pnpm clean` if check fails)
- `pnpm docgen` — ensure JSDoc examples compile. New exports (`PrepareResult`, `prepareUnsafe`) need `@since 4.0.0` annotations.
