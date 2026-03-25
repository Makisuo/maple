# Non-Strict JSON Schema Support for Effect AI SDK

## Overview

Add per-tool and per-provider control over the `strict` flag for tool calling. The `strict` flag is forwarded directly to the provider API (e.g. OpenAI's `strict` field on function tools, Anthropic's `strict` field on beta tools).

Note: Anthropic's `output_config.format` does not support `strict` at the API level, so this change only applies to tools for Anthropic. OpenAI already supports `strict` on both tools and response format.

This design is informed by Vercel AI SDK's implementation, which supports an optional `strict?: boolean` property on tools that gets passed through to providers.

---

## 1. Motivation

### Current State

- **OpenAI provider**: Hardcodes `strict: true` for all user-defined tools (line 2229 of `OpenAiLanguageModel.ts`)
- **OpenAI structured outputs**: Uses existing `Config.strictJsonSchema ?? true` for response format (line 2435)
- **Anthropic provider**: Does not set `strict` on tools, despite the `BetaTool` type supporting it (Generated.ts:3607)
- **No per-tool control**: Strict mode cannot be configured on individual tools

### Gap

Some schemas are incompatible with strict mode (e.g. schemas with `additionalProperties: true`, optional properties without null unions, or certain recursive structures). Users need the ability to disable strict mode for specific tools or globally.

### Use Cases

1. MCP tools with arbitrary JSON schemas that may not meet strict mode requirements
2. Dynamic tools with schemas from external sources
3. Tools with complex optional property patterns
4. Providers/models that don't support strict mode

---

## 2. Design Principles

### 2.1 Vercel AI SDK Reference

Vercel AI SDK's approach:

- Tools have an optional `strict?: boolean` property
- OpenAI provider passes `strict` through directly when defined
- Anthropic provider conditionally includes `strict` based on `supportsStructuredOutput` capability
- When `strict` is `undefined`, it's omitted from the API request (provider defaults apply)

Key files in Vercel AI SDK:

- `packages/provider-utils/src/types/tool.ts` (lines 154-160) - Tool strict property
- `packages/openai/src/chat/openai-chat-prepare-tools.ts` (line 42) - OpenAI passthrough
- `packages/anthropic/src/anthropic-prepare-tools.ts` (lines 73-75) - Anthropic conditional inclusion

### 2.2 Effect's Approach

Use the existing annotation pattern (`ServiceMap.Reference`) for per-tool strict mode control, with provider-level `Config.strictJsonSchema` as the global fallback. Resolution order:

1. Per-tool `Tool.Strict` annotation (if set)
2. Provider `Config.strictJsonSchema` (if set)
3. Provider default (`true` for OpenAI, `true` when structured outputs supported for Anthropic)

---

## 3. API Design

### 3.1 New Annotation: `Tool.Strict`

```typescript
export const Strict = ServiceMap.Reference<boolean | undefined>("effect/ai/Tool/Strict", {
  defaultValue: () => undefined
})
```

- `undefined` (default) — provider decides based on its global config
- `true` — enable strict mode for this tool
- `false` — disable strict mode for this tool

Follows the existing annotation pattern established by `Tool.Title`, `Tool.Readonly`, `Tool.Destructive`, `Tool.Idempotent`, and `Tool.OpenWorld`.

### 3.2 New Helper: `Tool.getStrictMode`

```typescript
export const getStrictMode = <T extends Any>(tool: T): boolean | undefined => ServiceMap.get(tool.annotations, Strict)
```

### 3.3 Usage

```typescript
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

// Disable strict mode for a specific tool
const FlexibleTool = Tool.make("FlexibleTool", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
}).annotate(Tool.Strict, false)

// Enable strict mode explicitly
const StrictTool = Tool.make("StrictTool", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
}).annotate(Tool.Strict, true)

// Default: provider decides
const DefaultTool = Tool.make("DefaultTool", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})
```

---

## 4. Provider Integration

### 4.1 OpenAI Provider

**File:** `packages/ai/openai/src/OpenAiLanguageModel.ts`

#### `prepareTools` (line 2192)

Current behavior hardcodes `strict: true`. `Config.strictJsonSchema` already exists on the OpenAI Config (line 95) but is only used for `prepareResponseFormat`. Update to:

1. Add `config` to function parameters
2. Resolve strict mode per-tool: `Tool.getStrictMode(tool) ?? config.strictJsonSchema ?? true`

```typescript
if (Tool.isUserDefined(tool)) {
  const strict = Tool.getStrictMode(tool) ?? config.strictJsonSchema ?? true
  tools.push({
    type: "function",
    name: tool.name,
    description: Tool.getDescription(tool) ?? null,
    parameters: Tool.getJsonSchema(tool) as { readonly [x: string]: Schema.Json },
    strict
  })
}
```

Update call site (line 364) to pass `config`.

#### `prepareResponseFormat` (line 2423)

Already uses `config.strictJsonSchema ?? true` — no changes needed.

### 4.2 Anthropic Provider

**File:** `packages/ai/anthropic/src/AnthropicLanguageModel.ts`

#### Config (line 50-69)

Add `strictJsonSchema` to the Config intersection type:

```typescript
readonly strictJsonSchema?: boolean | undefined
```

#### `prepareTools` (line 995-1008)

The `BetaTool` type already has `readonly "strict"?: boolean` (Generated.ts:3607).

Update to:

1. Resolve strict mode per-tool (only when model supports structured outputs)
2. Include `strict` in tool definition when defined

```typescript
if (Tool.isUserDefined(tool)) {
  const description = Tool.getDescription(tool)
  // Note: cast needed because Tool.getJsonSchema returns JsonSchema.JsonSchema
  // but Anthropic's BetaTool expects { readonly [x: string]: BetaJsonValue }
  const input_schema = Tool.getJsonSchema(tool) as any
  const toolStrict = Tool.getStrictMode(tool)
  const strict = capabilities.supportsStructuredOutput
    ? (toolStrict ?? config.strictJsonSchema ?? true)
    : undefined
  userTools.push({
    name: tool.name,
    input_schema,
    ...(Predicate.isNotUndefined(description) ? { description } : undefined),
    ...(strict !== undefined ? { strict } : undefined)
  })
  if (capabilities.supportsStructuredOutput === true) {
    betas.add("structured-outputs-2025-11-13")
  }
}
```

#### `output_config.format`

No changes needed. The Anthropic API does not support `strict` on `output_config.format` (`JsonOutputFormat` only has `{ schema, type }`).

---

## 5. Strict Mode Resolution

| Scenario                                         | Tool Annotation | Provider Config | Resolved Value        |
| ------------------------------------------------ | --------------- | --------------- | --------------------- |
| Default (OpenAI)                                 | `undefined`     | `undefined`     | `true`                |
| Default (Anthropic, structured output supported) | `undefined`     | `undefined`     | `true`                |
| Default (Anthropic, no structured output)        | `undefined`     | `undefined`     | `undefined` (omitted) |
| Anthropic `output_config.format`                 | N/A             | N/A             | N/A (not supported)   |
| Global non-strict (OpenAI)                       | `undefined`     | `false`         | `false`               |
| Per-tool override                                | `false`         | `true`          | `false`               |
| Per-tool strict on non-strict global             | `true`          | `false`         | `true`                |

---

## 6. Files to Modify

| File                                                  | Changes                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/effect/src/unstable/ai/Tool.ts`             | Add `Strict` annotation (~line 1687), `getStrictMode` helper                |
| `packages/ai/openai/src/OpenAiLanguageModel.ts`       | Update `prepareTools` to resolve per-tool strict mode; add `config` param   |
| `packages/ai/anthropic/src/AnthropicLanguageModel.ts` | Add `strictJsonSchema` to Config; update `prepareTools` to include `strict` |
| `packages/effect/test/unstable/ai/Tool.test.ts`       | Tests for `Tool.Strict` annotation and `getStrictMode`                      |

---

## 7. Unit Testing Specification

### 7.1 `Tool.Strict` Annotation Tests

```typescript
describe("Tool.Strict", () => {
  it.effect("defaults to undefined", () =>
    Effect.gen(function*() {
      const tool = Tool.make("TestTool")
      assert.isUndefined(Tool.getStrictMode(tool))
    }))

  it.effect("can be set to true", () =>
    Effect.gen(function*() {
      const tool = Tool.make("TestTool").annotate(Tool.Strict, true)
      assert.strictEqual(Tool.getStrictMode(tool), true)
    }))

  it.effect("can be set to false", () =>
    Effect.gen(function*() {
      const tool = Tool.make("TestTool").annotate(Tool.Strict, false)
      assert.strictEqual(Tool.getStrictMode(tool), false)
    }))

  it.effect("works with dynamic tools", () =>
    Effect.gen(function*() {
      const tool = Tool.dynamic("TestTool", {
        parameters: { type: "object", properties: {} }
      }).annotate(Tool.Strict, false)
      assert.strictEqual(Tool.getStrictMode(tool), false)
    }))
})
```

---

## 8. Verification Steps

1. `pnpm lint-fix`
2. `pnpm test packages/effect/test/unstable/ai/Tool.test.ts`
3. `pnpm check` (if fails, `pnpm clean && pnpm check`)
4. `pnpm build`
5. `pnpm docgen`
