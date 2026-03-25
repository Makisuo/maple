# Tool Approval Protocol for Effect AI SDK

## Overview

Add tool approval protocol support to the Effect AI SDK, enabling human-in-the-loop workflows where tools can request user approval before execution.

**Reference**: Vercel AI SDK implementation in `.repos/vercel-ai`

---

## 1. Protocol Summary

### 1.1 Core Concepts

1. **Tool-level `needsApproval` property**: Tools specify approval requirements
   - `boolean`: Static approval requirement
   - `function(params, context) => boolean | Effect<boolean>`: Dynamic approval

2. **Approval Request**: When approval needed, SDK emits `tool-approval-request` instead of executing

3. **Approval Response**: User responds with `tool-approval-response` in a tool message

4. **Two Sources of Approval Requests**:
   - **Framework-initiated**: SDK checks `needsApproval` before executing user-defined tools
   - **Provider-initiated**: Provider emits approval requests for provider-executed tools (e.g., MCP)

### 1.2 Protocol Types (From Vercel AI SDK)

```typescript
// Provider -> SDK (stream part)
type ToolApprovalRequest = {
  type: "tool-approval-request"
  approvalId: string // Unique ID for this approval flow
  toolCallId: string // The tool call requiring approval
}

// SDK -> Provider (in tool message content)
type ToolApprovalResponse = {
  type: "tool-approval-response"
  approvalId: string // References original request
  approved: boolean // User decision
  reason?: string // Optional justification
  providerExecuted?: boolean // Only provider-executed responses sent to model
}
```

---

## 2. Design Decisions (Based on Vercel SDK Behavior)

### 2.1 Multi-turn Approval Persistence

**Vercel Behavior**: Pending approvals persist across turns.

- `tool-approval-request` parts stored in assistant messages
- `collectToolApprovals()` scans all messages to find requests
- Matches responses by `approvalId`

**Effect AI**: Same approach - approval requests are conversation history.

### 2.2 Denied Execution Result

**Vercel Behavior**: Denied calls sent as `tool-result` with `execution-denied` output:

```typescript
// From generate-text.ts
{
  type: 'tool-result',
  toolCallId: toolApproval.toolCall.toolCallId,
  toolName: toolApproval.toolCall.toolName,
  output: {
    type: 'execution-denied',
    reason: toolApproval.approvalResponse.reason,
  },
}
```

**Effect AI**: Use `ToolResultPart` with special handling for denied executions.

### 2.3 Approval Timeout

**Vercel Behavior**: No built-in timeout. SDK emits request and waits for next call.

**Effect AI**: No built-in timeout. Users can wrap with `Effect.timeout` if needed.

### 2.4 Provider-Executed Approvals

**Vercel Behavior**: Two separate flows:

1. **Framework-initiated** (user-defined tools):
   - SDK checks `needsApproval` before executing
   - On approval, SDK executes tool locally

2. **Provider-initiated** (provider-executed tools):
   - Provider emits `tool-approval-request` in stream
   - On approval/denial, SDK sends `tool-approval-response` to provider
   - Provider executes the tool

```typescript
// Forward provider-executed approval responses
const providerExecutedToolApprovals = [...].filter(
  toolApproval => toolApproval.toolCall.providerExecuted
);

responseMessages.push({
  role: 'tool',
  content: providerExecutedToolApprovals.map(toolApproval => ({
    type: 'tool-approval-response',
    approvalId: toolApproval.approvalResponse.approvalId,
    approved: toolApproval.approvalResponse.approved,
    reason: toolApproval.approvalResponse.reason,
    providerExecuted: true,
  })),
});
```

**Effect AI**: Same approach - track `providerExecuted` flag.

### 2.5 Batch Approvals

**Vercel Behavior**: Fully supported. Multiple `tool-approval-response` parts in one message.

**Effect AI**: Allow multiple `ToolApprovalResponsePart` in a single `ToolMessage`.

---

## 3. Implementation Plan

### 3.1 Tool Module Changes (`packages/effect/src/unstable/ai/Tool.ts`)

Add `needsApproval` property:

```typescript
// New property on Tool interface
readonly needsApproval?: boolean | NeedsApprovalFunction<Parameters<Tool>>

// New type
type NeedsApprovalFunction<Params> = (
  params: Params,
  context: NeedsApprovalContext
) => Effect.Effect<boolean, never, any> | boolean

interface NeedsApprovalContext {
  readonly toolCallId: string
  readonly messages: ReadonlyArray<Prompt.Message>
}
```

Update `Tool.make()` options:

```typescript
export const make = <...>(name: Name, options?: {
  // ... existing options
  readonly needsApproval?: boolean | NeedsApprovalFunction<...>
})
```

### 3.2 Response Module Changes (`packages/effect/src/unstable/ai/Response.ts`)

Add new part type for approval requests:

```typescript
// ============================================================================
// Tool Approval Request Part
// ============================================================================

interface ToolApprovalRequestPart 
  extends BasePart<"tool-approval-request", ToolApprovalRequestPartMetadata> {
  readonly approvalId: string
  readonly toolCallId: string
}

interface ToolApprovalRequestPartEncoded 
  extends BasePartEncoded<"tool-approval-request", ToolApprovalRequestPartMetadata> {
  readonly approvalId: string
  readonly toolCallId: string
}

interface ToolApprovalRequestPartMetadata extends ProviderMetadata {}

const ToolApprovalRequestPart: Schema.Struct<{
  readonly type: Schema.tag<"tool-approval-request">
  readonly approvalId: Schema.String
  readonly toolCallId: Schema.String
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<...>
  readonly metadata: Schema.withDecodingDefault<...>
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.tag("tool-approval-request"),
  approvalId: Schema.String,
  toolCallId: Schema.String
}).annotate({ identifier: "ToolApprovalRequestPart" })
```

Update union types:

```typescript
// Add to AnyPart
export type AnyPart =
  | ...existing parts...
  | ToolApprovalRequestPart

// Add to AnyPartEncoded
export type AnyPartEncoded =
  | ...existing parts...
  | ToolApprovalRequestPartEncoded

// Add to AllParts<Tools>
export type AllParts<Tools extends Record<string, Tool.Any>> =
  | ...existing parts...
  | ToolApprovalRequestPart

// Add to StreamPart<Tools>
export type StreamPart<Tools extends Record<string, Tool.Any>> =
  | ...existing parts...
  | ToolApprovalRequestPart
```

Update schema factories (`AllParts`, `Part`, `StreamPart`) to include new part.

### 3.3 Prompt Module Changes (`packages/effect/src/unstable/ai/Prompt.ts`)

Add approval response part for tool messages:

```typescript
// ============================================================================
// Tool Approval Response Part
// ============================================================================

interface ToolApprovalResponsePart 
  extends BasePart<"tool-approval-response", ToolApprovalResponsePartOptions> {
  readonly approvalId: string
  readonly approved: boolean
  readonly reason?: string | undefined
}

interface ToolApprovalResponsePartEncoded 
  extends BasePartEncoded<"tool-approval-response", ToolApprovalResponsePartOptions> {
  readonly approvalId: string
  readonly approved: boolean
  readonly reason?: string | undefined
}

interface ToolApprovalResponsePartOptions extends ProviderOptions {}

const ToolApprovalResponsePart: Schema.Struct<{
  readonly type: Schema.Literal<"tool-approval-response">
  readonly approvalId: Schema.String
  readonly approved: Schema.Boolean
  readonly reason: Schema.optional<Schema.String>
  readonly "~effect/ai/Prompt/Part": Schema.withDecodingDefaultKey<...>
  readonly options: Schema.withDecodingDefault<...>
}> = Schema.Struct({
  ...BasePart.fields,
  type: Schema.Literal("tool-approval-response"),
  approvalId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optional(Schema.String)
}).annotate({ identifier: "ToolApprovalResponsePart" })

// Constructor
const toolApprovalResponsePart = (
  params: PartConstructorParams<ToolApprovalResponsePart>
): ToolApprovalResponsePart => makePart("tool-approval-response", params as any)
```

Update `ToolMessage`:

```typescript
// Update ToolMessagePart union
export type ToolMessagePart = ToolResultPart | ToolApprovalResponsePart

// Update ToolMessage schema
export const ToolMessage = Schema.Struct({
  ...BaseMessage.fields,
  role: Schema.Literal("tool"),
  content: Schema.Array(Schema.Union([ToolResultPart, ToolApprovalResponsePart]))
})
```

Update `Part` union:

```typescript
export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalResponsePart // Add
```

### 3.4 LanguageModel Module Changes (`packages/effect/src/unstable/ai/LanguageModel.ts`)

Add helper function:

```typescript
const isApprovalNeeded = <T extends Tool.Any>(
  tool: T,
  toolCall: Response.ToolCallPartEncoded,
  messages: ReadonlyArray<Prompt.Message>
): Effect.Effect<boolean, never, Tool.HandlerServices<T>> =>
  Effect.gen(function*() {
    if (tool.needsApproval == null) return false
    if (typeof tool.needsApproval === "boolean") return tool.needsApproval

    const params = yield* Schema.decodeEffect(tool.parametersSchema)(toolCall.params)
    const result = tool.needsApproval(params, {
      toolCallId: toolCall.id,
      messages
    })

    return Effect.isEffect(result) ? yield* result : result
  })
```

Modify `streamText` tool execution flow:

```typescript
// In streamText, before executing a tool call
const executeToolCall = (part: Response.ToolCallPartEncoded) =>
  Effect.gen(function*() {
    const tool = toolkit.tools[part.name]

    // Check if approval is needed (skip for provider-executed tools)
    if (part.providerExecuted !== true) {
      const needsApproval = yield* isApprovalNeeded(tool, part, messages)
      if (needsApproval) {
        const approvalPart = Response.makePart("tool-approval-request", {
          approvalId: generateId(),
          toolCallId: part.id
        })
        yield* Queue.offer(queue, approvalPart)
        return // Don't execute - wait for approval
      }
    }

    // Execute tool if no approval needed
    yield* toolkit.handle(part.name, part.params as any).pipe(
      Stream.unwrap,
      Stream.runForEach((result) => {
        const toolResultPart = Response.makePart("tool-result", {
          id: part.id,
          name: part.name,
          providerExecuted: false,
          ...result
        })
        return Queue.offer(queue, toolResultPart)
      })
    )
  })
```

Add approval collection for `generateText`:

```typescript
// At start of generateText, check for approval responses
const collectToolApprovals = (messages: ReadonlyArray<Prompt.Message>) => {
  const lastMessage = messages.at(-1)
  if (lastMessage?.role !== "tool") return { approved: [], denied: [] }

  // Find all approval requests in history
  const approvalRequests = new Map<string, { approvalId: string; toolCallId: string }>()
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "tool-approval-request") {
          approvalRequests.set(part.approvalId, part)
        }
      }
    }
  }

  // Match responses to requests
  const approved: Array<CollectedApproval> = []
  const denied: Array<CollectedApproval> = []

  for (const part of lastMessage.content) {
    if (part.type === "tool-approval-response") {
      const request = approvalRequests.get(part.approvalId)
      if (request) {
        const collected = { request, response: part }
        if (part.approved) approved.push(collected)
        else denied.push(collected)
      }
    }
  }

  return { approved, denied }
}
```

### 3.5 Provider Implementation (OpenAI example)

Handle provider-emitted approval requests in stream processing:

```typescript
// In OpenAiLanguageModel.ts stream processing
case 'mcp_approval_request': {
  controller.enqueue(Response.makePart("tool-approval-request", {
    approvalId: value.item.approval_request_id,
    toolCallId: value.item.tool_call_id
  }))
  break
}
```

Convert approval responses when building provider prompt:

```typescript
// In prompt conversion for tool messages
for (const part of message.content) {
  if (part.type === "tool-approval-response") {
    openaiContent.push({
      type: "mcp_approval_response",
      approval_request_id: part.approvalId,
      approve: part.approved,
      reason: part.reason
    })
  }
}
```

---

## 4. API Usage Examples

### 4.1 Tool Definition with Approval

```typescript
import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

// Static approval requirement
const DeleteFile = Tool.make("DeleteFile", {
  description: "Deletes a file from the filesystem",
  parameters: {
    path: Schema.String
  },
  success: Schema.Struct({ deleted: Schema.Boolean }),
  needsApproval: true
})

// Dynamic approval based on input
const WriteFile = Tool.make("WriteFile", {
  description: "Writes content to a file",
  parameters: {
    path: Schema.String,
    content: Schema.String
  },
  success: Schema.Struct({ written: Schema.Boolean }),
  needsApproval: (params) => params.path.startsWith("/etc/")
})

// Async approval check with dependencies
const ExecuteCommand = Tool.make("ExecuteCommand", {
  description: "Executes a shell command",
  parameters: {
    command: Schema.String
  },
  success: Schema.String,
  needsApproval: (params, ctx) =>
    Effect.gen(function*() {
      const policy = yield* SecurityPolicy
      return yield* policy.requiresApproval(params.command)
    }),
  dependencies: [SecurityPolicy]
})
```

### 4.2 Handling Approval Flow

```typescript
import { Array, Console, Effect, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/unstable/ai"

const handleApprovalFlow = Effect.gen(function*() {
  let messages: Array<Prompt.Message> = [
    Prompt.userMessage({ content: [Prompt.textPart({ text: "Delete temp files" })] })
  ]

  while (true) {
    const parts = yield* LanguageModel.streamText({
      prompt: Prompt.fromMessages(messages),
      toolkit
    }).pipe(Stream.runCollect)

    // Check for approval requests
    const approvalRequests = Array.filter(
      parts,
      (p): p is Response.ToolApprovalRequestPart => p.type === "tool-approval-request"
    )

    if (approvalRequests.length > 0) {
      // Get user decisions
      const responses = yield* promptUserForApprovals(approvalRequests)

      // Build next turn with approvals
      messages = [
        ...messages,
        Prompt.fromResponseParts(parts),
        Prompt.toolMessage({
          content: responses.map((r) => Prompt.toolApprovalResponsePart(r))
        })
      ]
      continue
    }

    // No more approvals needed
    break
  }
})
```

### 4.3 Batch Approval Example

```typescript
// User can approve/deny multiple tool calls at once
const toolMessage = Prompt.toolMessage({
  content: [
    Prompt.toolApprovalResponsePart({
      approvalId: "approval_1",
      approved: true
    }),
    Prompt.toolApprovalResponsePart({
      approvalId: "approval_2",
      approved: false,
      reason: "Sensitive operation not allowed"
    }),
    Prompt.toolApprovalResponsePart({
      approvalId: "approval_3",
      approved: true
    })
  ]
})
```

---

## 5. Implementation Tasks

### Phase 1: Core Types

- [ ] Add `ToolApprovalRequestPart` to `Response.ts`
- [ ] Add `ToolApprovalResponsePart` to `Prompt.ts`
- [ ] Add `needsApproval` property to `Tool.ts`
- [ ] Update union types and schema factories
- [ ] Add constructors (`toolApprovalResponsePart`, etc.)

### Phase 2: Framework Logic

- [ ] Implement `isApprovalNeeded` helper in `LanguageModel.ts`
- [ ] Modify `streamText` to emit approval requests
- [ ] Implement `collectToolApprovals` for `generateText`
- [ ] Handle denied executions as `execution-denied` results
- [ ] Update `Prompt.fromResponseParts` for approval requests

### Phase 3: Provider Support

- [ ] Update OpenAI provider for MCP approval requests
- [ ] Update prompt conversion for approval responses
- [ ] Add provider-specific metadata handling

### Phase 4: Tests & Documentation

- [ ] Unit tests for approval flow
- [ ] Integration tests with mock provider
- [ ] Update module documentation
- [ ] Add examples

---

## 6. File Change Summary

| File                                               | Changes                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/effect/src/unstable/ai/Tool.ts`          | Add `needsApproval` property, `NeedsApprovalFunction` type            |
| `packages/effect/src/unstable/ai/Response.ts`      | Add `ToolApprovalRequestPart`, update unions/schemas                  |
| `packages/effect/src/unstable/ai/Prompt.ts`        | Add `ToolApprovalResponsePart`, update `ToolMessage`                  |
| `packages/effect/src/unstable/ai/LanguageModel.ts` | Add `isApprovalNeeded`, `collectToolApprovals`, modify tool execution |
| `packages/ai/openai/src/OpenAiLanguageModel.ts`    | Handle MCP approval requests, convert approval responses              |

---

## 7. References

- Vercel AI SDK source: `.repos/vercel-ai/`
- Key Vercel files:
  - `packages/provider/src/language-model/v3/language-model-v3-tool-approval-request.ts`
  - `packages/provider/src/language-model/v3/language-model-v3-prompt.ts` (lines 194-218)
  - `packages/provider-utils/src/types/tool.ts` (lines 149-151)
  - `packages/ai/src/generate-text/is-approval-needed.ts`
  - `packages/ai/src/generate-text/collect-tool-approvals.ts`
  - `packages/ai/src/generate-text/run-tools-transformation.ts` (lines 292-306)
  - `packages/ai/src/generate-text/generate-text.ts` (lines 371-462)
