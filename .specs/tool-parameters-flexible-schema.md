# Flexible Tool Parameters Schema

## Overview

Relax the restriction requiring Tool `parameters` to be `Schema.Struct<Schema.Struct.Fields>`. Allow any `Schema.Top` (like `success` and `failure` already do), enabling Union, Array, and other schema types for tool parameters.

**Breaking Change**: This is a breaking change. Existing code using struct fields must wrap them in `Schema.Struct()`.

---

## 1. Motivation

### 1.1 Current Limitation

The `parameters` field is constrained to `Schema.Struct<Schema.Struct.Fields>` in the Tool interface (line 145 of Tool.ts), while `success` and `failure` can be any schema:

```typescript
export interface Tool<
  out Name extends string,
  out Config extends {
    readonly parameters: Schema.Struct<Schema.Struct.Fields>  // Restricted
    readonly success: Schema.Top                               // Flexible
    readonly failure: Schema.Top                               // Flexible
    readonly failureMode: FailureMode
  },
  ...
>
```

### 1.2 Use Case: Union Parameters

The commented-out `CodeExecution_20250825` in `AnthropicTool.ts` (lines 33-54) shows the need:

```typescript
// export const CodeExecution_20250825 = Tool.providerDefined({
//   customName: "AnthropicCodeExecution",
//   providerName: "code_execution",
//   args: {},
//   parameters: Schema.Union([
//     Schema.Struct({ code: Schema.String })
//     // bash_code_execution
//   ]),
//   ...
// })
```

This tool cannot be defined because `parameters` doesn't accept Union schemas.

---

## 2. Design Decisions

### 2.1 Breaking Change - No Backward Compatibility

All `parameters` must now be full schemas. Existing code using struct fields must be updated:

```typescript
// Before (no longer works)
Tool.make("MyTool", {
  parameters: { name: Schema.String }
})

// After (required)
Tool.make("MyTool", {
  parameters: Schema.Struct({ name: Schema.String })
})
```

### 2.2 JSON Schema Generation

The existing `getJsonSchemaFromSchema` function already handles arbitrary schemas via `Schema.toJsonSchemaDocument()`. Only modification needed: check for struct-like schema before empty struct optimization.

### 2.3 No Provider Changes Required

- OpenAI provider uses `Tool.getJsonSchema(tool)` which works with any schema
- Toolkit handler execution uses `Schema.decodeUnknownEffect(tool.parametersSchema)` which works with any schema

---

## 3. Implementation Plan

### 3.1 Tool.ts - Core Type Changes

**A. Relax Config constraints (lines 142-151, 326-335)**

```typescript
// Tool interface - line 145
export interface Tool<
  out Name extends string,
  out Config extends {
    readonly parameters: Schema.Top  // was Schema.Struct<Schema.Struct.Fields>
    readonly success: Schema.Top
    readonly failure: Schema.Top
    readonly failureMode: FailureMode
  },
  out Requirements = never
>

// ProviderDefined interface - lines 328-331
export interface ProviderDefined<
  Name extends string,
  Config extends {
    readonly args: Schema.Top        // was Schema.Struct<...>
    readonly parameters: Schema.Top  // was Schema.Struct<...>
    readonly success: Schema.Top
    readonly failure: Schema.Top
    readonly failureMode: FailureMode
  },
  RequiresHandler extends boolean = false
>
```

**B. Update utility types (lines 474-497, 526-531)**

```typescript
// Any - line 476
export interface Any extends
  Tool<any, {
    readonly parameters: Schema.Top // was Schema.Struct<...>
    readonly success: Schema.Top
    readonly failure: Schema.Top
    readonly failureMode: FailureMode
  }, any>
{}

// AnyProviderDefined - line 491
export interface AnyProviderDefined extends
  ProviderDefined<any, {
    readonly args: Schema.Top // was Schema.Struct<...>
    readonly parameters: Schema.Top // was Schema.Struct<...>
    readonly success: Schema.Top
    readonly failure: Schema.Top
    readonly failureMode: FailureMode
  }, any>
{}

// Parameters<T> - line 530
export type Parameters<T> = T extends Tool<
  infer _Name,
  infer _Config,
  infer _Requirements
> ? _Config["parameters"]["Type"] // was Schema.Struct.Type<...["fields"]>
  : never
```

**C. Update NeedsApproval types (lines 93-110)**

```typescript
export type NeedsApprovalFunction<Params extends Schema.Top> = (
  params: Params["Type"], // was Schema.Struct.Type<Params["fields"]>
  context: NeedsApprovalContext
) => boolean | Effect.Effect<boolean, never, any>

export type NeedsApproval<Params extends Schema.Top> =
  | boolean
  | NeedsApprovalFunction<Params>
```

**D. Update constructor prototypes (lines 882-943)**

```typescript
const userDefinedProto = <
  const Name extends string,
  Parameters extends Schema.Top,  // was Schema.Struct<...>
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Mode extends FailureMode
>(options: {...})

const providerDefinedProto = <
  const Name extends string,
  Args extends Schema.Top,        // was Schema.Struct<...>
  Parameters extends Schema.Top,  // was Schema.Struct<...>
  Success extends Schema.Top,
  Failure extends Schema.Top,
  RequiresHandler extends boolean,
  Mode extends FailureMode
>(options: {...})
```

**E. Update `Tool.make()` (lines 969-1041)**

```typescript
export const make = <
  const Name extends string,
  Parameters extends Schema.Top = typeof Schema.Void,
  Success extends Schema.Top = typeof Schema.Void,
  Failure extends Schema.Top = typeof Schema.Never,
  Mode extends FailureMode | undefined = undefined,
  Dependencies extends Array<ServiceMap.Service<any, any>> = []
>(name: Name, options?: {
  readonly description?: string | undefined
  readonly parameters?: Parameters | undefined
  readonly success?: Success | undefined
  readonly failure?: Failure | undefined
  readonly failureMode?: Mode
  readonly dependencies?: Dependencies | undefined
  readonly needsApproval?: NeedsApproval<Parameters> | undefined
}): Tool<
  Name,
  {
    readonly parameters: Parameters
    readonly success: Success
    readonly failure: Failure
    readonly failureMode: Mode extends undefined ? "error" : Mode
  },
  ServiceMap.Service.Identifier<Dependencies[number]>
> => {
  const parametersSchema = options?.parameters ?? Schema.Void
  // ... rest unchanged
}
```

**F. Update `Tool.providerDefined()` (lines 1076-1157)**

```typescript
export const providerDefined = <
  const Name extends string,
  Args extends Schema.Top = typeof Schema.Void,
  Parameters extends Schema.Top = typeof Schema.Void,
  Success extends Schema.Top = typeof Schema.Void,
  Failure extends Schema.Top = typeof Schema.Never,
  RequiresHandler extends boolean = false
>(options: {
  readonly customName: Name
  readonly providerName: string
  readonly args?: Args | undefined
  readonly requiresHandler?: RequiresHandler | undefined
  readonly parameters?: Parameters | undefined
  readonly success?: Success | undefined
  readonly failure?: Failure | undefined
})
```

**G. Update `setParameters` method (lines 265-280, 849-855)**

```typescript
setParameters<ParametersSchema extends Schema.Top>(
  schema: ParametersSchema
): Tool<
  Name,
  {
    readonly parameters: ParametersSchema
    readonly success: Config["success"]
    readonly failure: Config["failure"]
    readonly failureMode: Config["failureMode"]
  },
  Requirements
>
```

**H. Update JSON Schema generation (lines 1303-1319)**

```typescript
export const getJsonSchemaFromSchema = <S extends Schema.Top>(schema: S): JsonSchema.JsonSchema => {
  // Empty struct optimization - only for struct-like schemas with no props
  if (AST.isObjects(schema.ast)) {
    const props = schema.ast.propertySignatures
    if (props.length === 0) {
      return { type: "object", properties: {}, required: [], additionalProperties: false }
    }
  }
  // Standard path handles Union, Array, primitives, etc.
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length > 0) {
    document.schema.$defs = document.definitions
  }
  return document.schema
}
```

### 3.2 Response.ts - ToolCallPart Changes

**A. Update interface (line 1345)**

```typescript
export interface ToolCallPart<Name extends string, Params> // was Params extends Record<string, unknown>
  extends BasePart<"tool-call", ToolCallPartMetadata>
{
  readonly id: string
  readonly name: Name
  readonly params: Params
  readonly providerExecuted: boolean
}
```

**B. Update schema constructor (lines 1408-1439)**

```typescript
export const ToolCallPart: <const Name extends string, Params extends Schema.Top>(
  name: Name,
  params: Params  // was Schema.Struct<Params>
) => Schema.Struct<{
  readonly type: Schema.Literal<"tool-call">
  readonly id: Schema.String
  readonly name: Schema.Literal<Name>
  readonly params: Params
  readonly providerExecuted: Schema.withDecodingDefaultKey<Schema.Boolean>
  readonly "~effect/ai/Content/Part": Schema.withDecodingDefaultKey<Schema.tag<"~effect/ai/Content/Part">>
  readonly metadata: Schema.withDecodingDefault<...>
}> = <const Name extends string, Params extends Schema.Top>(
  name: Name,
  params: Params
) =>
  Schema.Struct({
    ...BasePart.fields,
    type: Schema.Literal("tool-call"),
    id: Schema.String,
    name: Schema.Literal(name),
    params,  // Pass through any schema
    providerExecuted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(constFalse))
  }).annotate({ identifier: "ToolCallPart" })
```

**C. Update ToolCallParts utility type (lines 419-423)**

```typescript
export type ToolCallParts<Tools extends Record<string, Tool.Any>> = {
  [Name in keyof Tools]: Name extends string ? ToolCallPart<Name, Tool.Parameters<Tools[Name]>> // was Schema.Struct.Type<...["fields"]>
    : never
}[keyof Tools]
```

### 3.3 AnthropicTool.ts - Enable Union Tool

Uncomment `CodeExecution_20250825` (lines 33-54) once the refactor is complete.

### 3.4 Update Existing Tool Definitions

All existing tools using struct fields must be updated to use `Schema.Struct()`:

**OpenAiTool.ts:**

```typescript
// Before
parameters: {
  code: Generated.CodeInterpreterToolCall.fields.code,
  container_id: Generated.CodeInterpreterToolCall.fields.container_id
}

// After
parameters: Schema.Struct({
  code: Generated.CodeInterpreterToolCall.fields.code,
  container_id: Generated.CodeInterpreterToolCall.fields.container_id
})
```

**AnthropicTool.ts:**

```typescript
// Before
parameters: {
  command: Schema.String,
  restart: Schema.optional(Schema.Boolean)
}

// After
parameters: Schema.Struct({
  command: Schema.String,
  restart: Schema.optional(Schema.Boolean)
})
```

### 3.5 Update Tests

All tests using struct fields must be updated similarly.

---

## 4. Files Changed

| File                                            | Changes                                           |
| ----------------------------------------------- | ------------------------------------------------- |
| `packages/effect/src/unstable/ai/Tool.ts`       | Core interface, utility types, constructors       |
| `packages/effect/src/unstable/ai/Response.ts`   | `ToolCallPart` interface and schema constructor   |
| `packages/ai/anthropic/src/AnthropicTool.ts`    | Update to `Schema.Struct()`, uncomment union tool |
| `packages/ai/openai/src/OpenAiTool.ts`          | Update to `Schema.Struct()`                       |
| `packages/effect/test/unstable/ai/Tool.test.ts` | Update to `Schema.Struct()`                       |

---

## 5. API Usage Examples

### 5.1 Union Parameters

```typescript
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const CodeExecution = Tool.make("CodeExecution", {
  parameters: Schema.Union([
    Schema.Struct({ code: Schema.String }),
    Schema.Struct({ bash: Schema.String })
  ]),
  success: Schema.String
})
```

### 5.2 Struct Parameters (new syntax)

```typescript
const GetWeather = Tool.make("GetWeather", {
  parameters: Schema.Struct({
    location: Schema.String,
    units: Schema.Literals(["celsius", "fahrenheit"])
  }),
  success: Schema.Struct({ temperature: Schema.Number })
})
```

---

## 6. Verification Steps

1. Type checking: `pnpm check`
2. Run tests: `pnpm test packages/effect/test/unstable/ai/Tool.test.ts`
3. Lint: `pnpm lint-fix`
4. Docgen: `pnpm docgen`
5. Build: `pnpm build`

---

## 7. Implementation Tasks

### Phase 1: Core Types (Tool.ts)

- [x] Update `Tool` interface Config constraint
- [x] Update `ProviderDefined` interface Config constraint
- [x] Update `Any` and `AnyProviderDefined` utility types
- [x] Update `Parameters<T>` utility type
- [x] Update `NeedsApprovalFunction` and `NeedsApproval` types
- [x] Update `userDefinedProto` and `providerDefinedProto`
- [x] Update `Tool.make()`
- [x] Update `Tool.providerDefined()`
- [x] Update `setParameters` method
- [x] Fix `getJsonSchemaFromSchema` empty struct check

### Phase 2: Response Types (Response.ts)

- [x] Update `ToolCallPart` interface
- [x] Update `ToolCallPart` schema constructor
- [x] Update `ToolCallParts` utility type

### Phase 3: Update Existing Code

- [x] Update `AnthropicTool.ts` to use `Schema.Struct()`
- [x] Enable `CodeExecution_20250825` in `AnthropicTool.ts`
- [x] Update `OpenAiTool.ts` to use `Schema.Struct()`
- [x] Update tests to use `Schema.Struct()`
- [x] Update JSDoc examples in `Tool.ts`
