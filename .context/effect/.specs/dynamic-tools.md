# Dynamic Tool Support for Effect AI SDK

## Overview

Add support for dynamic tools to the `Tool` module. Dynamic tools enable scenarios where tool schemas aren't known at compile time, such as MCP tools discovered at runtime, user-defined functions loaded from external sources, or plugin systems.

This design is informed by Vercel AI SDK's `dynamicTool()` implementation, which serves similar use cases.

---

## 1. Motivation

### Current Tool System

- **User-defined tools** (`Tool.make`): Strongly-typed with Effect Schema for parameters/success/failure
- **Provider-defined tools** (`Tool.providerDefined`): Built into LLM providers (web search, code execution)

### Gap

No support for tools where:

- Schema isn't known at compile time
- Parameters come from external sources (MCP servers, user configs)
- Only a JSON Schema is available (no Effect Schema)

### Use Cases

1. MCP tools discovered at runtime
2. User-defined functions loaded from external configurations
3. Plugin systems where tools are registered dynamically
4. Tools with schemas defined in JSON Schema format

---

## 2. Design Principles

### 2.1 Vercel AI SDK Reference

Vercel AI SDK's `dynamicTool` accepts a `FlexibleSchema` which can be:

- A Zod schema (provides both JSON Schema and validation)
- A raw JSON Schema via `jsonSchema()` helper (optionally with validation)
- A Standard Schema

Key insight from Vercel's implementation:

```typescript
// When validate is undefined, validation is skipped entirely
if (actualSchema.validate == null) {
  return { success: true, value: value as OBJECT, rawValue: value }
}
```

For MCP tools, Vercel uses `jsonSchema()` **without** a validate function, meaning no validation occurs. The JSON Schema guides the model, but the handler receives unvalidated `unknown`.

### 2.2 Effect's Approach

Effect's `Tool.dynamic` will support two modes:

1. **Effect Schema mode**: Full type safety with validation (like `Tool.make`)
2. **JSON Schema mode**: Raw JSON Schema for the model, handler receives `unknown`

---

## 3. API Design

### 3.1 New Type: `Tool.Dynamic`

```typescript
const DynamicTypeId: unique symbol

export interface Dynamic<
  out Name extends string,
  out Config extends {
    readonly parameters: Schema.Top | JsonSchema.JsonSchema
    readonly success: Schema.Top
    readonly failure: Schema.Top
    readonly failureMode: FailureMode
  },
  out Requirements = never
> extends Tool<Name, Config, Requirements> {
  readonly [DynamicTypeId]: typeof DynamicTypeId

  /**
   * The parameters schema - can be either an Effect Schema or a raw JSON Schema.
   * Use `Schema.isSchema` at runtime to determine which.
   */
  readonly parametersSchema: Config["parameters"]
}
```

The key difference from `Tool`: `parametersSchema` can be a `JsonSchema.JsonSchema` in addition to `Schema.Top`.

### 3.2 Constructor: `Tool.dynamic()`

Single constructor with `parameters` accepting either Effect Schema or JsonSchema:

```typescript
export function dynamic<
  const Name extends string,
  const Options extends {
    readonly description?: string | undefined
    readonly parameters?: Schema.Top | JsonSchema.JsonSchema
    readonly success?: Schema.Top
    readonly failure?: Schema.Top
    readonly failureMode?: FailureMode
    readonly needsApproval?: NeedsApproval<any>
  }
>(
  name: Name,
  options: Options
): Dynamic<
  Name,
  {
    readonly parameters: Options extends { readonly parameters: infer P extends Schema.Top } ? P
      : typeof Schema.Unknown
    readonly success: Options extends { readonly success: infer S extends Schema.Top } ? S
      : typeof Schema.Unknown
    readonly failure: Options extends { readonly failure: infer F extends Schema.Top } ? F
      : typeof Schema.Never
    readonly failureMode: Options extends { readonly failureMode: infer M extends FailureMode } ? M
      : "error"
  }
>
```

**Behavior:**

- If `parameters` is an Effect Schema → typed parameters, derives JSON Schema
- If `parameters` is a JsonSchema → parameters are `unknown`, uses JSON Schema directly
- If `parameters` is omitted → parameters default to `Schema.Void`
- `success` defaults to `Schema.Unknown`
- `failure` defaults to `Schema.Never`
- `failureMode` defaults to `"error"`

**Runtime detection:**

```typescript
// Use Schema.isSchema to distinguish Effect Schema from JSON Schema
if (Schema.isSchema(options.parameters)) {
  // Effect Schema path
} else {
  // JSON Schema path
}
```

### 3.3 Type Guard

```typescript
export const isDynamic = (u: unknown): u is Dynamic<string, any> => Predicate.hasProperty(u, DynamicTypeId)
```

### 3.4 Utility Types

```typescript
export interface AnyDynamic extends
  Dynamic<
    any,
    {
      readonly parameters: Schema.Top | JsonSchema.JsonSchema
      readonly success: Schema.Top
      readonly failure: Schema.Top
      readonly failureMode: FailureMode
    },
    any
  >
{}
```

---

## 4. Schema Handling

### 4.1 Effect Schema Mode

When `parameters` is an Effect Schema:

- **JSON Schema**: Derived via `Schema.toJsonSchemaDocument()`
- **Validation**: Full Effect Schema decoding/validation
- **Handler type**: Typed based on schema

```typescript
const SearchTool = Tool.dynamic("SearchTool", {
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number)
  }),
  success: Schema.Array(Schema.String)
})
// Handler receives: { query: string, limit?: number }
// Handler returns: string[]
```

### 4.2 JSON Schema Mode

When `parameters` is a raw JSON Schema:

- **JSON Schema**: Used directly (stored in `parametersSchema`)
- **Validation**: Deferred decision (see Section 7)
- **Handler type**: `unknown`

```typescript
const McpTool = Tool.dynamic("McpTool", {
  description: "Tool from MCP server",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" }
    },
    required: ["query"]
  }
})
// Handler receives: unknown
// Handler returns: unknown
```

---

## 5. Success and Failure Schemas

### 5.1 Defaults

| Schema        | Default          | Rationale                                    |
| ------------- | ---------------- | -------------------------------------------- |
| `success`     | `Schema.Unknown` | Handler can return anything; encoded as JSON |
| `failure`     | `Schema.Never`   | No typed failures by default                 |
| `failureMode` | `"error"`        | Failures go to error channel                 |

### 5.2 When to Specify Success Schema

Specify `success` when:

- You want typed handler return values
- You need proper encoding of complex types
- You want validation of handler output

```typescript
const SearchTool = Tool.dynamic("SearchTool", {
  parameters: mcpToolDef.inputSchema, // JSON Schema
  success: Schema.Struct({
    results: Schema.Array(Schema.Struct({
      title: Schema.String,
      url: Schema.String
    }))
  })
})
// Handler receives: unknown
// Handler must return: { results: { title: string, url: string }[] }
```

### 5.3 When to Specify Failure Schema

Specify `failure` with `failureMode: "return"` when:

- Failures should be captured as results (not errors)
- You need typed failure values in the tool result

```typescript
const RiskyTool = Tool.dynamic("RiskyTool", {
  parameters: toolDef.inputSchema, // JSON Schema
  failure: Schema.Struct({ code: Schema.String, message: Schema.String }),
  failureMode: "return"
})
```

---

## 6. Integration Points

### 6.1 JSON Schema Generation

Update `getJsonSchema()` to handle both Effect Schema and JSON Schema:

```typescript
export const getJsonSchema = <Tool extends Any>(tool: Tool): JsonSchema.JsonSchema => {
  if (Schema.isSchema(tool.parametersSchema)) {
    return getJsonSchemaFromSchema(tool.parametersSchema)
  }
  // It's a raw JSON Schema, use directly
  return tool.parametersSchema
}
```

### 6.2 Handler Execution

When `parameters` is a JSON Schema:

- `parametersSchema` stores the JSON Schema directly
- No Effect Schema decoding occurs
- Handler receives the raw parsed JSON as `unknown`

When `parameters` is an Effect Schema:

- Standard Effect Schema decoding/validation
- Handler receives typed, validated parameters

### 6.3 Provider Integration

Dynamic tools are treated the same as user-defined tools by providers:

```typescript
if (Tool.isUserDefined(tool) || Tool.isDynamic(tool)) {
  tools.push({
    type: "function",
    name: tool.name,
    description: Tool.getDescription(tool),
    parameters: Tool.getJsonSchema(tool)
  })
}
```

---

## 7. Deferred: Validation for JSON Schema Input

When `parameters` is a JSON Schema (not an Effect Schema), what validation occurs?

### Options

**Option A: No validation (Vercel's approach for MCP)**

- Parse JSON, pass directly to handler
- Handler receives `unknown`, must validate manually
- Simple, matches Vercel behavior

**Option B: Optional validation function**

```typescript
Tool.dynamic("search", {
  parameters: jsonSchema,
  validate: (value: unknown): Effect<SearchParams, ParseError> => ...
})
```

**Option C: JSON Schema validation**

- Use a JSON Schema validator
- Adds complexity/dependencies

### Current Decision

**Defer this decision.** For initial implementation, use Option A (no validation). The JSON Schema guides the model; the handler can validate as needed.

Future enhancement: Consider Option B if demand arises.

---

## 8. Usage Examples

### 8.1 MCP Tool Integration

```typescript
import { Tool, Toolkit } from "effect/unstable/ai"

// Convert MCP tool definition to Effect Dynamic tool
const fromMcpTool = (mcpTool: McpToolDef): Tool.AnyDynamic =>
  Tool.dynamic(mcpTool.name, {
    description: mcpTool.description,
    parameters: mcpTool.inputSchema // JSON Schema from MCP
  })

// Create toolkit from MCP tools
const mcpTools = await mcpClient.listTools()
const toolkit = Toolkit.make(...mcpTools.map(fromMcpTool))

// Handler for dynamic tool - receives unknown
const handlers = toolkit.toLayer({
  search_files: (params: unknown) =>
    Effect.gen(function*() {
      // Forward to MCP server
      return yield* mcpClient.callTool("search_files", params)
    })
})
```

### 8.2 JSON Schema with Typed Output

```typescript
const WebSearch = Tool.dynamic("WebSearch", {
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      maxResults: { type: "number" }
    },
    required: ["query"]
  },
  // Even though input is unknown, output is typed
  success: Schema.Struct({
    results: Schema.Array(Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      snippet: Schema.String
    }))
  })
})

// Handler: (unknown) => Effect<{ results: {...}[] }>
```

### 8.3 Effect Schema (Full Type Safety)

```typescript
const Calculator = Tool.dynamic("Calculator", {
  parameters: Schema.Struct({
    operation: Schema.Literal("add", "subtract", "multiply", "divide"),
    a: Schema.Number,
    b: Schema.Number
  }),
  success: Schema.Number
})

// Handler: ({ operation, a, b }) => Effect<number>
// Full type inference, same as Tool.make
```

---

## 9. Comparison: `Tool.make` vs `Tool.dynamic`

| Aspect               | `Tool.make`                | `Tool.dynamic`                           |
| -------------------- | -------------------------- | ---------------------------------------- |
| `parameters` accepts | Effect Schema only         | Effect Schema OR JSON Schema             |
| Parameters type      | Inferred from schema       | Inferred (Effect) or `unknown` (JSON)    |
| JSON Schema          | Derived from Effect Schema | Derived (Effect) or used directly (JSON) |
| Validation           | Always                     | Always (Effect) or none (JSON)           |
| `success` default    | `Schema.Void`              | `Schema.Unknown`                         |
| `failure` default    | `Schema.Never`             | `Schema.Never`                           |

### When to Use Which

**Use `Tool.make`** when:

- Tool schema is known at compile time
- You want full type safety
- Schema is defined in TypeScript

**Use `Tool.dynamic`** when:

- Tool schema comes from external source (MCP, config, API)
- Schema is only available as JSON Schema
- Tools are discovered/created at runtime
- You want `unknown` as the default success type

---

## 10. Implementation Plan

### Phase 1: Core Types (Tool.ts)

1. Add `DynamicTypeId` constant
2. Add `Dynamic` interface extending `Tool`
3. Add `AnyDynamic` utility type
4. Add `isDynamic()` type guard
5. Implement `dynamic()` constructor with conditional types
6. Update `getJsonSchema()` to handle JSON Schema in `parametersSchema`

### Phase 2: Toolkit Integration

1. Verify handler type inference works for dynamic tools
2. Ensure `Schema.Unknown` passthrough works correctly
3. Test `Toolkit.make()` with dynamic tools

### Phase 3: Testing

See Section 11 for comprehensive test specification.

---

## 11. Unit Testing Specification

### 11.1 Type Guard Tests

```typescript
describe("Tool.isDynamic", () => {
  it.effect("returns true for dynamic tools with Effect Schema", () =>
    Effect.gen(function*() {
      const tool = Tool.dynamic("TestTool", {
        parameters: Schema.Struct({ query: Schema.String })
      })
      assert.isTrue(Tool.isDynamic(tool))
    }))

  it.effect("returns true for dynamic tools with JSON Schema", () =>
    Effect.gen(function*() {
      const tool = Tool.dynamic("TestTool", {
        parameters: { type: "object", properties: {} }
      })
      assert.isTrue(Tool.isDynamic(tool))
    }))

  it.effect("returns false for user-defined tools", () =>
    Effect.gen(function*() {
      const tool = Tool.make("TestTool", {
        parameters: Schema.Struct({ query: Schema.String })
      })
      assert.isFalse(Tool.isDynamic(tool))
    }))

  it.effect("returns false for provider-defined tools", () =>
    Effect.gen(function*() {
      const tool = Tool.providerDefined({
        id: "test.provider_tool",
        customName: "ProviderTool",
        providerName: "provider_tool"
      })({})
      assert.isFalse(Tool.isDynamic(tool))
    }))

  it.effect("returns false for non-tool values", () =>
    Effect.gen(function*() {
      assert.isFalse(Tool.isDynamic(null))
      assert.isFalse(Tool.isDynamic(undefined))
      assert.isFalse(Tool.isDynamic({}))
      assert.isFalse(Tool.isDynamic({ name: "fake" }))
    }))
})
```

### 11.2 JSON Schema Generation Tests

```typescript
describe("Tool.getJsonSchema with dynamic tools", () => {
  it.effect("derives JSON Schema from Effect Schema parameters", () =>
    Effect.gen(function*() {
      const tool = Tool.dynamic("TestTool", {
        parameters: Schema.Struct({
          query: Schema.String,
          limit: Schema.optional(Schema.Number)
        })
      })

      const jsonSchema = Tool.getJsonSchema(tool)

      assert.strictEqual(jsonSchema.type, "object")
      assert.deepStrictEqual(jsonSchema.required, ["query"])
      assert.hasProperty(jsonSchema.properties, "query")
      assert.hasProperty(jsonSchema.properties, "limit")
    }))

  it.effect("returns JSON Schema directly when provided as parameters", () =>
    Effect.gen(function*() {
      const inputSchema = {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", minimum: 1, maximum: 100 }
        },
        required: ["query"],
        additionalProperties: false
      } as const

      const tool = Tool.dynamic("TestTool", { parameters: inputSchema })
      const jsonSchema = Tool.getJsonSchema(tool)

      assert.deepStrictEqual(jsonSchema, inputSchema)
    }))

  it.effect("preserves complex JSON Schema features like $ref and oneOf", () =>
    Effect.gen(function*() {
      const inputSchema = {
        type: "object",
        properties: {
          value: { oneOf: [{ type: "string" }, { type: "number" }] },
          item: { $ref: "#/$defs/Item" }
        },
        $defs: {
          Item: { type: "object", properties: { name: { type: "string" } } }
        }
      } as const

      const tool = Tool.dynamic("TestTool", { parameters: inputSchema })
      const jsonSchema = Tool.getJsonSchema(tool)

      assert.deepStrictEqual(jsonSchema, inputSchema)
    }))
})
```

### 11.3 Handler Execution Tests

```typescript
describe("Handler execution with dynamic tools", () => {
  it.effect("decodes parameters with Effect Schema before calling handler", () =>
    Effect.gen(function*() {
      const SearchTool = Tool.dynamic("SearchTool", {
        parameters: Schema.Struct({
          query: Schema.String,
          limit: Schema.Number
        }),
        success: Schema.Array(Schema.String)
      })

      const toolkit = Toolkit.make(SearchTool)

      const layer = toolkit.toLayer({
        SearchTool: ({ query, limit }) => Effect.succeed(Array.from({ length: limit }, (_, i) => `${query}-${i}`))
      })

      const result = yield* toolkit.tools.SearchTool
        .handler({ query: "test", limit: 3 })
        .pipe(Effect.provide(layer))

      assert.deepStrictEqual(result.result, ["test-0", "test-1", "test-2"])
    }))

  it.effect("passes parameters through as unknown with JSON Schema", () =>
    Effect.gen(function*() {
      const SearchTool = Tool.dynamic("SearchTool", {
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } }
        },
        success: Schema.Array(Schema.String)
      })

      const toolkit = Toolkit.make(SearchTool)

      const layer = toolkit.toLayer({
        SearchTool: (params: unknown) =>
          Effect.gen(function*() {
            const { query, limit } = params as { query: string; limit: number }
            return Array.from({ length: limit }, (_, i) => `${query}-${i}`)
          })
      })

      const result = yield* toolkit.tools.SearchTool
        .handler({ query: "test", limit: 3 })
        .pipe(Effect.provide(layer))

      assert.deepStrictEqual(result.result, ["test-0", "test-1", "test-2"])
    }))

  it.effect("encodes success result using success schema", () =>
    Effect.gen(function*() {
      const tool = Tool.dynamic("TestTool", {
        parameters: { type: "object", properties: {} },
        success: Schema.Struct({ timestamp: Schema.DateFromNumber })
      })

      const toolkit = Toolkit.make(tool)

      const layer = toolkit.toLayer({
        TestTool: () => Effect.succeed({ timestamp: new Date(1000) })
      })

      const result = yield* toolkit.tools.TestTool
        .handler({})
        .pipe(Effect.provide(layer))

      assert.instanceOf(result.result.timestamp, Date)
      assert.strictEqual(result.encodedResult.timestamp, 1000)
    }))
})
```

---

## 12. Files to Modify

| File                                            | Changes                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `packages/effect/src/unstable/ai/Tool.ts`       | Add Dynamic type, constructor, type guard, update `getJsonSchema()` |
| `packages/effect/src/unstable/ai/Toolkit.ts`    | Verify handler types work (may need no changes)                     |
| `packages/effect/test/unstable/ai/Tool.test.ts` | Add dynamic tool tests                                              |

---

## 13. Verification Steps

1. Type checking: `pnpm check`
2. Run tests: `pnpm test packages/effect/test/unstable/ai/Tool.test.ts`
3. Lint: `pnpm lint-fix`
4. Build: `pnpm build`
5. Docgen: `pnpm docgen`
