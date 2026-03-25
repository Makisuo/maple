# Tool Approval Pre-Resolution Bug Fix

**Status: COMPLETED**

## Problem Statement

Tool call approvals passed back into the SDK via a prompt are not resolved until AFTER the next LLM generation completes. This causes the LLM to error because there are tool calls in the incoming message history without corresponding results.

### Current Flow (Broken)

1. User submits prompt with tool approval responses (e.g., `{ type: "tool-approval-response", approvalId: "abc", approved: true }`)
2. SDK passes prompt to LLM with unresolved tool calls (no tool results yet)
3. LLM sees tool calls without results and errors out

### Expected Flow (Fixed)

1. User submits prompt with tool approval responses
2. SDK resolves approved/denied tool calls BEFORE calling the LLM
3. Tool results are added to the prompt
4. LLM receives complete prompt with tool calls AND their results
5. LLM generates response based on complete conversation

## Root Cause

In `LanguageModel.ts`, the `generateContent` function (line 757) processes tool approvals too late in the flow. The comment at line 771 marks where pre-resolution should occur:

```typescript
// WE NEED TO RESOLVE TOOL APPROVALS HERE
```

Currently, tool approval collection and resolution happens AFTER `params.generateText(providerOptions)` is called (lines 812-824), but the prompt has already been sent to the LLM by then.

## Implementation Plan

### Phase 1: Add `ToolkitRequiredError` to AiError

Add a new error reason for when a toolkit is required but not provided:

**Location**: `packages/effect/src/unstable/ai/AiError.ts`

```typescript
/**
 * Error indicating an operation requires a toolkit but none was provided.
 *
 * This error occurs when tool approval responses are present in the prompt
 * but no toolkit was provided to resolve them.
 *
 * @since 1.0.0
 * @category reason
 */
export class ToolkitRequiredError extends Schema.ErrorClass<ToolkitRequiredError>(
  "effect/ai/AiError/ToolkitRequiredError"
)({
  _tag: Schema.tag("ToolkitRequiredError"),
  pendingApprovals: Schema.Array(Schema.String),
  description: Schema.optional(Schema.String)
}) {
  readonly [ReasonTypeId] = ReasonTypeId

  get isRetryable(): boolean {
    return false
  }

  override get message(): string {
    const tools = this.pendingApprovals.join(", ")
    return `Toolkit required to resolve pending tool approvals: ${tools}`
  }
}
```

Also add to `AiErrorReason` union and schema.

### Phase 2: Augment `collectToolApprovals` Function

Extend the existing `collectToolApprovals` function instead of creating a new one:

**Location**: Around line 1113 in `LanguageModel.ts`

```typescript
interface ApprovalResult {
  readonly approvalId: string
  readonly toolCallId: string
  readonly approved: boolean
  readonly reason?: string | undefined
  readonly toolCall?: Prompt.ToolCallPart | undefined // NEW: include actual tool call
}

interface CollectToolApprovalsOptions {
  readonly excludeResolved?: boolean // NEW: filter out approvals with existing results
}

const collectToolApprovals = (
  messages: ReadonlyArray<Prompt.Message>,
  options?: CollectToolApprovalsOptions
): {
  readonly approved: Array<ApprovalResult>
  readonly denied: Array<ApprovalResult>
} => {
  const requests = new Map<string, Pick<ApprovalResult, "approvalId" | "toolCallId">>()
  const responses: Array<Omit<ApprovalResult, "toolCallId" | "toolCall">> = []
  const toolCallsById = new Map<string, Prompt.ToolCallPart>() // NEW
  const toolResultIds = new Set<string>() // NEW

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          requests.set(part.approvalId, {
            approvalId: part.approvalId,
            toolCallId: part.toolCallId
          })
        }
        if (part.type === "tool-call") { // NEW
          toolCallsById.set(part.id, part)
        }
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-approval-response") {
          responses.push({
            approvalId: part.approvalId,
            approved: part.approved,
            reason: part.reason
          })
        }
        if (part.type === "tool-result") { // NEW
          toolResultIds.add(part.id)
        }
      }
    }
  }

  const approved: Array<ApprovalResult> = []
  const denied: Array<ApprovalResult> = []

  for (const response of responses) {
    const request = requests.get(response.approvalId)
    if (Predicate.isNotUndefined(request)) {
      // NEW: skip if already resolved
      if (options?.excludeResolved && toolResultIds.has(request.toolCallId)) {
        continue
      }

      const result: ApprovalResult = {
        ...response,
        toolCallId: request.toolCallId,
        toolCall: toolCallsById.get(request.toolCallId) // NEW
      }

      if (response.approved) {
        approved.push(result)
      } else {
        denied.push(result)
      }
    }
  }

  return { approved, denied }
}
```

### Phase 3: Create Tool Execution Function for Pre-Resolution

Create a helper to execute approved tools and collect results:

**Location**: After `collectToolApprovals` function

```typescript
const executeApprovedToolCalls = <Tools extends Record<string, Tool.Any>>(
  approvals: ReadonlyArray<ApprovalResult>,
  toolkit: Toolkit.WithHandler<Tools>,
  concurrency: Concurrency | undefined
): Effect.Effect<
  Array<Prompt.ToolResultPart>,
  Tool.HandlerError<Tools[keyof Tools]> | AiError.AiError,
  Tool.HandlerServices<Tools[keyof Tools]>
> => {
  const executeOne = Effect.fnUntraced(function*(approval: ApprovalResult) {
    const toolCall = approval.toolCall
    if (!toolCall) {
      return yield* Effect.die("Approval missing tool call reference")
    }

    const tool = toolkit.tools[toolCall.name]
    if (!tool) {
      return yield* AiError.make({
        module: "LanguageModel",
        method: "generateText",
        reason: new AiError.ToolNotFoundError({
          toolName: toolCall.name,
          toolParams: toolCall.params as Schema.Json,
          availableTools: Object.keys(toolkit.tools)
        })
      })
    }

    const resultStream = yield* toolkit.handle(toolCall.name, toolCall.params as any)

    const finalResult = yield* resultStream.pipe(
      Stream.filter((result) => result.preliminary === false),
      Stream.run(Sink.last()),
      Effect.flatMap(Option.match({
        onNone: () => Effect.die("Tool handler did not produce a final result"),
        onSome: Effect.succeed
      }))
    )

    return Prompt.makePart("tool-result", {
      id: approval.toolCallId,
      name: toolCall.name,
      isFailure: finalResult.isFailure,
      result: finalResult.encodedResult
    })
  })

  return Effect.gen(function*() {
    const resolveConcurrency = concurrency === "inherit"
      ? yield* Effect.service(CurrentConcurrency)
      : concurrency ?? "unbounded"

    return yield* Effect.forEach(approvals, executeOne, { concurrency: resolveConcurrency })
  })
}
```

### Phase 4: Create Denial Results Function

Create a helper to generate denial results:

```typescript
const createDenialResults = (
  denials: ReadonlyArray<ApprovalResult>
): Array<Prompt.ToolResultPart> =>
  denials.flatMap((denial) => {
    if (!denial.toolCall) return []
    return [Prompt.makePart("tool-result", {
      id: denial.toolCallId,
      name: denial.toolCall.name,
      isFailure: true,
      result: { type: "execution-denied", reason: denial.reason }
    })]
  })
```

### Phase 5: Modify `generateContent` Function

Update the `generateContent` function to pre-resolve tool approvals before calling the LLM:

**Location**: Around line 771 in `generateContent`, replacing the comment

```typescript
const generateContent: <...>(...) => ... = Effect.fnUntraced(
  function*<...>(...) {
    const toolChoice = options.toolChoice ?? "auto"

    // Check for pending approvals that need resolution
    const { approved, denied } = collectToolApprovals(
      providerOptions.prompt.content,
      { excludeResolved: true }
    )
    const hasPendingApprovals = approved.length > 0 || denied.length > 0

    // If there is no toolkit but we have pending approvals, error
    if (Predicate.isUndefined(options.toolkit)) {
      if (hasPendingApprovals) {
        return yield* AiError.make({
          module: "LanguageModel",
          method: "generateText",
          reason: new AiError.ToolkitRequiredError({
            pendingApprovals: [...approved, ...denied]
              .map((a) => a.toolCall?.name)
              .filter(Predicate.isNotUndefined)
          })
        })
      }

      const ResponseSchema = Schema.mutable(Schema.Array(Response.Part(Toolkit.empty)))
      const rawContent = yield* params.generateText(providerOptions)
      const content = yield* Schema.decodeEffect(ResponseSchema)(rawContent)
      return content as Array<Response.Part<Tools>>
    }

    // Resolve the toolkit
    const toolkit = yield* resolveToolkit<Tools, any, any>(options.toolkit)

    // If the resolved toolkit is empty but we have pending approvals, error
    if (Object.values(toolkit.tools).length === 0) {
      if (hasPendingApprovals) {
        return yield* AiError.make({
          module: "LanguageModel",
          method: "generateText",
          reason: new AiError.ToolkitRequiredError({
            pendingApprovals: [...approved, ...denied]
              .map((a) => a.toolCall?.name)
              .filter(Predicate.isNotUndefined)
          })
        })
      }

      const ResponseSchema = Schema.mutable(Schema.Array(Response.Part(Toolkit.empty)))
      const rawContent = yield* params.generateText(providerOptions)
      const content = yield* Schema.decodeEffect(ResponseSchema)(rawContent)
      return content as Array<Response.Part<Tools>>
    }

    // ========================================
    // PRE-RESOLVE TOOL APPROVALS
    // ========================================

    if (hasPendingApprovals) {
      // Validate all approved tools exist in the toolkit
      for (const approval of approved) {
        if (approval.toolCall && !toolkit.tools[approval.toolCall.name]) {
          return yield* AiError.make({
            module: "LanguageModel",
            method: "generateText",
            reason: new AiError.ToolNotFoundError({
              toolName: approval.toolCall.name,
              toolParams: approval.toolCall.params as Schema.Json,
              availableTools: Object.keys(toolkit.tools)
            })
          })
        }
      }

      // Execute approved tools and create denial results
      const approvedResults = yield* executeApprovedToolCalls(approved, toolkit, options.concurrency)
      const deniedResults = createDenialResults(denied)
      const preResolvedResults = [...approvedResults, ...deniedResults]

      // Add pre-resolved results to the prompt
      if (preResolvedResults.length > 0) {
        const toolMessage = Prompt.makeMessage("tool", { content: preResolvedResults })
        providerOptions.prompt = Prompt.fromMessages([
          ...providerOptions.prompt.content,
          toolMessage
        ])
      }
    }

    // Continue with the rest of the existing logic...
    const tools = typeof toolChoice === "object" && "oneOf" in toolChoice
      ? Object.values(toolkit.tools).filter((tool) => toolChoice.oneOf.includes(tool.name))
      : Object.values(toolkit.tools)
    providerOptions.tools = tools
    providerOptions.toolChoice = toolChoice

    // ... rest of existing implementation
  }
)
```

### Phase 6: Apply Same Pattern to `streamContent`

Apply the same pre-resolution logic to the `streamContent` function.

**Location**: Around line 840 in `streamContent`, after toolkit resolution

The same checks and pre-resolution logic should be applied before calling `params.streamText()`.

### Phase 7: Clean Up Debug Statement

Remove the `console.log({ approvedToolCallIds })` debug statement at line 1230.

## Error Handling Requirements

1. **Toolkit Required**: If toolkit is undefined/empty but there are pending approvals:
   ```typescript
   AiError.make({
     module: "LanguageModel",
     method: "generateText",
     reason: new AiError.ToolkitRequiredError({
       pendingApprovals: ["GetWeather", "SendEmail"]
     })
   })
   ```

2. **Tool Not Found**: If an approved tool doesn't exist in the toolkit:
   ```typescript
   AiError.make({
     module: "LanguageModel",
     method: "generateText",
     reason: new AiError.ToolNotFoundError({
       toolName: "<tool-name>",
       toolParams: <params>,
       availableTools: [<available-tool-names>]
     })
   })
   ```

3. **Tool Execution Errors**: Propagate tool handler errors as usual via the existing error handling.

## Data Flow Summary

### Input Message Structure

```
[
  { role: "user", content: "What's the weather?" },
  { role: "assistant", content: [
    { type: "tool-call", id: "call_1", name: "GetWeather", params: {...} },
    { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
  ]},
  { role: "tool", content: [
    { type: "tool-approval-response", approvalId: "appr_1", approved: true }
  ]}
]
```

### After Pre-Resolution

```
[
  { role: "user", content: "What's the weather?" },
  { role: "assistant", content: [
    { type: "tool-call", id: "call_1", name: "GetWeather", params: {...} },
    { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
  ]},
  { role: "tool", content: [
    { type: "tool-approval-response", approvalId: "appr_1", approved: true }
  ]},
  { role: "tool", content: [
    { type: "tool-result", id: "call_1", name: "GetWeather", isFailure: false, result: {...} }
  ]}
]
```

Now the LLM sees a complete conversation with tool calls AND their results.

## Files to Modify

1. `packages/effect/src/unstable/ai/AiError.ts`
   - Add `ToolkitRequiredError` class
   - Add to `AiErrorReason` union and schema

2. `packages/effect/src/unstable/ai/LanguageModel.ts`
   - Augment `ApprovalResult` interface with `toolCall` field
   - Augment `collectToolApprovals` with `excludeResolved` option
   - Add `executeApprovedToolCalls` function
   - Add `createDenialResults` function
   - Modify `generateContent` to pre-resolve approvals
   - Modify `streamContent` to pre-resolve approvals
   - Remove debug `console.log` statement

## Comprehensive Test Plan

### Unit Tests for `collectToolApprovals`

#### Test 1.1: Basic approval collection

```typescript
it.effect("collects approved tool approvals from messages", () =>
  Effect.gen(function*() {
    const messages = [
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", { id: "call_1", name: "GetWeather", params: {}, providerExecuted: false }),
          Prompt.makePart("tool-approval-request", { approvalId: "appr_1", toolCallId: "call_1" })
        ]
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-approval-response", { approvalId: "appr_1", approved: true })
        ]
      })
    ]

    const { approved, denied } = collectToolApprovals(messages)

    assert.strictEqual(approved.length, 1)
    assert.strictEqual(denied.length, 0)
    assert.strictEqual(approved[0].toolCallId, "call_1")
    assert.strictEqual(approved[0].toolCall?.name, "GetWeather")
  }))
```

#### Test 1.2: Basic denial collection

```typescript
it.effect("collects denied tool approvals from messages", () =>
  Effect.gen(function*() {
    const messages = [
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", {
            id: "call_1",
            name: "DeleteFile",
            params: { path: "/etc/passwd" },
            providerExecuted: false
          }),
          Prompt.makePart("tool-approval-request", { approvalId: "appr_1", toolCallId: "call_1" })
        ]
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-approval-response", {
            approvalId: "appr_1",
            approved: false,
            reason: "Dangerous operation"
          })
        ]
      })
    ]

    const { approved, denied } = collectToolApprovals(messages)

    assert.strictEqual(approved.length, 0)
    assert.strictEqual(denied.length, 1)
    assert.strictEqual(denied[0].reason, "Dangerous operation")
  }))
```

#### Test 1.3: Mixed approvals and denials

```typescript
it.effect("handles mixed approvals and denials", () =>
  Effect.gen(function*() {
    const messages = [
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", { id: "call_1", name: "GetWeather", params: {}, providerExecuted: false }),
          Prompt.makePart("tool-call", { id: "call_2", name: "DeleteFile", params: {}, providerExecuted: false }),
          Prompt.makePart("tool-approval-request", { approvalId: "appr_1", toolCallId: "call_1" }),
          Prompt.makePart("tool-approval-request", { approvalId: "appr_2", toolCallId: "call_2" })
        ]
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-approval-response", { approvalId: "appr_1", approved: true }),
          Prompt.makePart("tool-approval-response", { approvalId: "appr_2", approved: false })
        ]
      })
    ]

    const { approved, denied } = collectToolApprovals(messages)

    assert.strictEqual(approved.length, 1)
    assert.strictEqual(denied.length, 1)
    assert.strictEqual(approved[0].toolCall?.name, "GetWeather")
    assert.strictEqual(denied[0].toolCall?.name, "DeleteFile")
  }))
```

#### Test 1.4: Excludes already resolved approvals

```typescript
it.effect("excludes approvals with existing tool results when excludeResolved is true", () =>
  Effect.gen(function*() {
    const messages = [
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", { id: "call_1", name: "GetWeather", params: {}, providerExecuted: false }),
          Prompt.makePart("tool-approval-request", { approvalId: "appr_1", toolCallId: "call_1" })
        ]
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-approval-response", { approvalId: "appr_1", approved: true }),
          Prompt.makePart("tool-result", { id: "call_1", name: "GetWeather", isFailure: false, result: { temp: 72 } })
        ]
      })
    ]

    const withExclude = collectToolApprovals(messages, { excludeResolved: true })
    const withoutExclude = collectToolApprovals(messages)

    assert.strictEqual(withExclude.approved.length, 0)
    assert.strictEqual(withoutExclude.approved.length, 1)
  }))
```

#### Test 1.5: Ignores orphaned approval responses

```typescript
it.effect("ignores approval responses without matching requests", () =>
  Effect.gen(function*() {
    const messages = [
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-approval-response", { approvalId: "orphan_appr", approved: true })
        ]
      })
    ]

    const { approved, denied } = collectToolApprovals(messages)

    assert.strictEqual(approved.length, 0)
    assert.strictEqual(denied.length, 0)
  }))
```

### Unit Tests for `createDenialResults`

#### Test 2.1: Creates execution-denied results

```typescript
it.effect("creates tool result with execution-denied for denials", () =>
  Effect.gen(function*() {
    const denials: Array<ApprovalResult> = [{
      approvalId: "appr_1",
      toolCallId: "call_1",
      approved: false,
      reason: "User declined",
      toolCall: Prompt.makePart("tool-call", { id: "call_1", name: "DeleteFile", params: {}, providerExecuted: false })
    }]

    const results = createDenialResults(denials)

    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].id, "call_1")
    assert.strictEqual(results[0].name, "DeleteFile")
    assert.strictEqual(results[0].isFailure, true)
    assert.deepStrictEqual(results[0].result, { type: "execution-denied", reason: "User declined" })
  }))
```

#### Test 2.2: Handles missing reason

```typescript
it.effect("handles denial without reason", () =>
  Effect.gen(function*() {
    const denials: Array<ApprovalResult> = [{
      approvalId: "appr_1",
      toolCallId: "call_1",
      approved: false,
      toolCall: Prompt.makePart("tool-call", { id: "call_1", name: "DeleteFile", params: {}, providerExecuted: false })
    }]

    const results = createDenialResults(denials)

    assert.deepStrictEqual(results[0].result, { type: "execution-denied", reason: undefined })
  }))
```

#### Test 2.3: Skips denials without tool call reference

```typescript
it.effect("skips denials without toolCall reference", () =>
  Effect.gen(function*() {
    const denials: Array<ApprovalResult> = [{
      approvalId: "appr_1",
      toolCallId: "call_1",
      approved: false,
      toolCall: undefined
    }]

    const results = createDenialResults(denials)

    assert.strictEqual(results.length, 0)
  }))
```

### Integration Tests for `generateText` Pre-Resolution

#### Test 3.1: Approved tool call is executed before LLM call

```typescript
it.effect("executes approved tool calls before calling LLM", () =>
  Effect.gen(function*() {
    let promptSentToLLM: Prompt.Prompt | undefined

    const mockGenerateText = (options: ProviderOptions) => {
      promptSentToLLM = options.prompt
      return Effect.succeed([
        { type: "text", text: "The weather is sunny." },
        { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      ])
    }

    const GetWeather = Tool.make("GetWeather", {
      parameters: { location: Schema.String },
      success: Schema.Struct({ temp: Schema.Number })
    })

    const toolkit = Toolkit.make(GetWeather).toLayer({
      GetWeather: () => Effect.succeed({ temp: 72 })
    })

    const messages = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "GetWeather", params: { location: "NYC" } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true }
        ]
      }
    ]

    const response = yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(GetWeather)
    }).pipe(
      Effect.provide(toolkit),
      Effect.provide(MockLanguageModel.layer(mockGenerateText))
    )

    // Verify tool result was added to prompt before LLM call
    const toolMessages = promptSentToLLM?.content.filter((m) => m.role === "tool") ?? []
    const lastToolMessage = toolMessages[toolMessages.length - 1]
    const toolResults = lastToolMessage?.content.filter((p) => p.type === "tool-result") ?? []

    assert.strictEqual(toolResults.length, 1)
    assert.strictEqual(toolResults[0].id, "call_1")
    assert.deepStrictEqual(toolResults[0].result, { temp: 72 })
  }))
```

#### Test 3.2: Denied tool call creates execution-denied result

```typescript
it.effect("creates execution-denied result for denied tool calls", () =>
  Effect.gen(function*() {
    let promptSentToLLM: Prompt.Prompt | undefined

    const mockGenerateText = (options: ProviderOptions) => {
      promptSentToLLM = options.prompt
      return Effect.succeed([
        { type: "text", text: "I cannot delete that file." },
        { type: "finish", reason: "stop", usage: {} }
      ])
    }

    const DeleteFile = Tool.make("DeleteFile", {
      parameters: { path: Schema.String },
      success: Schema.String,
      needsApproval: true
    })

    const messages = [
      { role: "user", content: "Delete /etc/passwd" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "DeleteFile", params: { path: "/etc/passwd" } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: false, reason: "Dangerous operation" }
        ]
      }
    ]

    yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(DeleteFile)
    }).pipe(
      Effect.provide(Toolkit.make(DeleteFile).toLayer({ DeleteFile: () => Effect.succeed("deleted") })),
      Effect.provide(MockLanguageModel.layer(mockGenerateText))
    )

    const toolMessages = promptSentToLLM?.content.filter((m) => m.role === "tool") ?? []
    const lastToolMessage = toolMessages[toolMessages.length - 1]
    const toolResults = lastToolMessage?.content.filter((p) => p.type === "tool-result") ?? []

    assert.strictEqual(toolResults.length, 1)
    assert.strictEqual(toolResults[0].isFailure, true)
    assert.deepStrictEqual(toolResults[0].result, { type: "execution-denied", reason: "Dangerous operation" })
  }))
```

#### Test 3.3: Missing toolkit with pending approvals fails with ToolkitRequiredError

```typescript
it.effect("fails with ToolkitRequiredError when toolkit missing but approvals pending", () =>
  Effect.gen(function*() {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "GetWeather", params: {} },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true }
        ]
      }
    ]

    const result = yield* LanguageModel.generateText({
      prompt: messages
      // No toolkit provided
    }).pipe(
      Effect.flip,
      Effect.provide(MockLanguageModel.layer(() => Effect.succeed([])))
    )

    assert.strictEqual(result._tag, "AiError")
    assert.strictEqual(result.reason._tag, "ToolkitRequiredError")
    assert.deepStrictEqual(result.reason.pendingApprovals, ["GetWeather"])
  }))
```

#### Test 3.4: Tool not found in toolkit fails with ToolNotFoundError

```typescript
it.effect("fails with ToolNotFoundError when approved tool not in toolkit", () =>
  Effect.gen(function*() {
    const GetTime = Tool.make("GetTime", { success: Schema.Number })

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "GetWeather", params: {} }, // Not in toolkit
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true }
        ]
      }
    ]

    const result = yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(GetTime)
    }).pipe(
      Effect.flip,
      Effect.provide(Toolkit.make(GetTime).toLayer({ GetTime: () => Effect.succeed(Date.now()) })),
      Effect.provide(MockLanguageModel.layer(() => Effect.succeed([])))
    )

    assert.strictEqual(result._tag, "AiError")
    assert.strictEqual(result.reason._tag, "ToolNotFoundError")
    assert.strictEqual(result.reason.toolName, "GetWeather")
    assert.deepStrictEqual(result.reason.availableTools, ["GetTime"])
  }))
```

#### Test 3.5: Already resolved approvals are skipped

```typescript
it.effect("skips approvals that already have tool results", () =>
  Effect.gen(function*() {
    let toolExecutionCount = 0

    const GetWeather = Tool.make("GetWeather", {
      parameters: { location: Schema.String },
      success: Schema.Struct({ temp: Schema.Number })
    })

    const toolkit = Toolkit.make(GetWeather).toLayer({
      GetWeather: () => {
        toolExecutionCount++
        return Effect.succeed({ temp: 72 })
      }
    })

    // Message history already has the tool result
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "GetWeather", params: { location: "NYC" } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true },
          { type: "tool-result", id: "call_1", name: "GetWeather", isFailure: false, result: { temp: 72 } }
        ]
      }
    ]

    yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(GetWeather)
    }).pipe(
      Effect.provide(toolkit),
      Effect.provide(MockLanguageModel.layer(() =>
        Effect.succeed([
          { type: "text", text: "It's 72 degrees." },
          { type: "finish", reason: "stop", usage: {} }
        ])
      ))
    )

    // Tool should NOT be executed again
    assert.strictEqual(toolExecutionCount, 0)
  }))
```

#### Test 3.6: Multiple approvals in single request

```typescript
it.effect("handles multiple tool approvals in single request", () =>
  Effect.gen(function*() {
    let promptSentToLLM: Prompt.Prompt | undefined

    const GetWeather = Tool.make("GetWeather", {
      parameters: { location: Schema.String },
      success: Schema.Struct({ temp: Schema.Number })
    })

    const GetTime = Tool.make("GetTime", {
      success: Schema.Number
    })

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "GetWeather", params: { location: "NYC" } },
          { type: "tool-call", id: "call_2", name: "GetTime", params: {} },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" },
          { type: "tool-approval-request", approvalId: "appr_2", toolCallId: "call_2" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true },
          { type: "tool-approval-response", approvalId: "appr_2", approved: true }
        ]
      }
    ]

    yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(GetWeather, GetTime)
    }).pipe(
      Effect.provide(
        Toolkit.make(GetWeather, GetTime).toLayer({
          GetWeather: () => Effect.succeed({ temp: 72 }),
          GetTime: () => Effect.succeed(1234567890)
        })
      ),
      Effect.provide(MockLanguageModel.layer((options) => {
        promptSentToLLM = options.prompt
        return Effect.succeed([{ type: "finish", reason: "stop", usage: {} }])
      }))
    )

    const toolMessages = promptSentToLLM?.content.filter((m) => m.role === "tool") ?? []
    const lastToolMessage = toolMessages[toolMessages.length - 1]
    const toolResults = lastToolMessage?.content.filter((p) => p.type === "tool-result") ?? []

    assert.strictEqual(toolResults.length, 2)
  }))
```

#### Test 3.7: Tool handler error propagates correctly

```typescript
it.effect("propagates tool handler errors", () =>
  Effect.gen(function*() {
    const FailingTool = Tool.make("FailingTool", {
      success: Schema.String,
      failure: Schema.String
    })

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "FailingTool", params: {} },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true }
        ]
      }
    ]

    const result = yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(FailingTool)
    }).pipe(
      Effect.flip,
      Effect.provide(
        Toolkit.make(FailingTool).toLayer({
          FailingTool: () => Effect.fail("Tool execution failed")
        })
      ),
      Effect.provide(MockLanguageModel.layer(() => Effect.succeed([])))
    )

    // Error should propagate (exact handling depends on tool's failureMode)
    assert.isTrue(result !== undefined)
  }))
```

### Integration Tests for `streamText` Pre-Resolution

#### Test 4.1: Streaming with approved tool call

```typescript
it.effect("pre-resolves approved tool calls in streaming mode", () =>
  Effect.gen(function*() {
    let promptSentToLLM: Prompt.Prompt | undefined

    const GetWeather = Tool.make("GetWeather", {
      parameters: { location: Schema.String },
      success: Schema.Struct({ temp: Schema.Number })
    })

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "GetWeather", params: { location: "NYC" } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true }
        ]
      }
    ]

    const parts = yield* LanguageModel.streamText({
      prompt: messages,
      toolkit: Toolkit.make(GetWeather)
    }).pipe(
      Stream.runCollect,
      Effect.map(Chunk.toArray),
      Effect.provide(
        Toolkit.make(GetWeather).toLayer({
          GetWeather: () => Effect.succeed({ temp: 72 })
        })
      ),
      Effect.provide(MockLanguageModel.streamLayer((options) => {
        promptSentToLLM = options.prompt
        return Stream.make(
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "It's sunny!" },
          { type: "text-end", id: "t1" },
          { type: "finish", reason: "stop", usage: {} }
        )
      }))
    )

    // Verify tool was pre-resolved
    const toolMessages = promptSentToLLM?.content.filter((m) => m.role === "tool") ?? []
    const lastToolMessage = toolMessages[toolMessages.length - 1]
    const toolResults = lastToolMessage?.content.filter((p) => p.type === "tool-result") ?? []

    assert.strictEqual(toolResults.length, 1)
    assert.deepStrictEqual(toolResults[0].result, { temp: 72 })
  }))
```

#### Test 4.2: Streaming with denied tool call

```typescript
it.effect("pre-resolves denied tool calls in streaming mode", () =>
  Effect.gen(function*() {
    let promptSentToLLM: Prompt.Prompt | undefined

    const DeleteFile = Tool.make("DeleteFile", {
      parameters: { path: Schema.String },
      success: Schema.String
    })

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "DeleteFile", params: { path: "/etc/passwd" } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: false, reason: "Dangerous" }
        ]
      }
    ]

    yield* LanguageModel.streamText({
      prompt: messages,
      toolkit: Toolkit.make(DeleteFile)
    }).pipe(
      Stream.runCollect,
      Effect.provide(Toolkit.make(DeleteFile).toLayer({ DeleteFile: () => Effect.succeed("ok") })),
      Effect.provide(MockLanguageModel.streamLayer((options) => {
        promptSentToLLM = options.prompt
        return Stream.make({ type: "finish", reason: "stop", usage: {} })
      }))
    )

    const toolMessages = promptSentToLLM?.content.filter((m) => m.role === "tool") ?? []
    const lastToolMessage = toolMessages[toolMessages.length - 1]
    const toolResults = lastToolMessage?.content.filter((p) => p.type === "tool-result") ?? []

    assert.strictEqual(toolResults.length, 1)
    assert.strictEqual(toolResults[0].isFailure, true)
    assert.deepStrictEqual(toolResults[0].result, { type: "execution-denied", reason: "Dangerous" })
  }))
```

### Edge Case Tests

#### Test 5.1: Empty approval response list

```typescript
it.effect("handles prompt with no approval responses", () =>
  Effect.gen(function*() {
    const messages = [
      { role: "user", content: "Hello" }
    ]

    const response = yield* LanguageModel.generateText({
      prompt: messages
    }).pipe(
      Effect.provide(MockLanguageModel.layer(() =>
        Effect.succeed([
          { type: "text", text: "Hi!" },
          { type: "finish", reason: "stop", usage: {} }
        ])
      ))
    )

    assert.strictEqual(response.text, "Hi!")
  }))
```

#### Test 5.2: Approval response for non-existent tool call

```typescript
it.effect("ignores approval response when tool call is missing", () =>
  Effect.gen(function*() {
    const messages = [
      {
        role: "assistant",
        content: [
          // Note: no tool-call part, only approval request
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true }
        ]
      }
    ]

    const response = yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.empty
    }).pipe(
      Effect.provide(MockLanguageModel.layer(() =>
        Effect.succeed([
          { type: "text", text: "OK" },
          { type: "finish", reason: "stop", usage: {} }
        ])
      ))
    )

    // Should not fail, just ignore the orphaned approval
    assert.strictEqual(response.text, "OK")
  }))
```

#### Test 5.3: Concurrency option is respected

```typescript
it.effect("respects concurrency option for tool execution", () =>
  Effect.gen(function*() {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const SlowTool = Tool.make("SlowTool", {
      parameters: { id: Schema.Number },
      success: Schema.Number
    })

    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call_1", name: "SlowTool", params: { id: 1 } },
          { type: "tool-call", id: "call_2", name: "SlowTool", params: { id: 2 } },
          { type: "tool-call", id: "call_3", name: "SlowTool", params: { id: 3 } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" },
          { type: "tool-approval-request", approvalId: "appr_2", toolCallId: "call_2" },
          { type: "tool-approval-request", approvalId: "appr_3", toolCallId: "call_3" }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "appr_1", approved: true },
          { type: "tool-approval-response", approvalId: "appr_2", approved: true },
          { type: "tool-approval-response", approvalId: "appr_3", approved: true }
        ]
      }
    ]

    yield* LanguageModel.generateText({
      prompt: messages,
      toolkit: Toolkit.make(SlowTool),
      concurrency: 1 // Sequential execution
    }).pipe(
      Effect.provide(
        Toolkit.make(SlowTool).toLayer({
          SlowTool: ({ id }) =>
            Effect.gen(function*() {
              currentConcurrent++
              maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
              yield* Effect.sleep("10 millis")
              currentConcurrent--
              return id
            })
        })
      ),
      Effect.provide(MockLanguageModel.layer(() =>
        Effect.succeed([
          { type: "finish", reason: "stop", usage: {} }
        ])
      ))
    )

    // With concurrency: 1, max concurrent should be 1
    assert.strictEqual(maxConcurrent, 1)
  }))
```

## References

- Vercel AI SDK implementation: `repos/vercel-ai/packages/ai/src/generate-text/collect-tool-approvals.ts`
- Vercel AI SDK message preprocessing: `repos/vercel-ai/packages/ai/src/prompt/convert-to-language-model-prompt.ts`
- Effect AI SDK tool approval protocol spec: `.specs/ai-sdk-tool-approval-protocol.md`
