# SSE `decodeSchema` Refactoring Plan

## Overview

Refactor the openapi-generator's SSE integration to use the new `Sse.decodeSchema` API which expects a schema for the full SSE event structure. The generator composes the event schema at the call site.

## Background

- The old `decodeSchema` (which took a data-only schema) was renamed to `decodeDataSchema`
- The new `decodeSchema` expects a schema for the full SSE event, enforced at the type level

## Implementation (Completed)

### 1. Added `EventSchema` type to Sse.ts

```typescript
export type EventSchema = Schema.Top
```

### 2. Updated `decodeSchema` in Sse.ts

Changed to accept a full event schema and return the schema's Type directly:

```typescript
export const decodeSchema = <S extends EventSchema, IE, Done>(
  schema: S
): Channel.Channel<
  NonEmptyReadonlyArray<S["Type"]>,
  IE | Retry | Schema.SchemaError,
  Done,
  NonEmptyReadonlyArray<string>,
  IE,
  Done,
  S["DecodingServices"]
> =>
  Channel.pipeTo(
    decode<IE, Done>(),
    ChannelSchema.decode(schema)()
  )
```

### 3. Updated `sseRequestSource` in OpenApiTransformer.ts

Changed to use `Sse.EventSchema` constraint and remove the `Stream.map`:

```typescript
const sseRequestSource = (_importName: string) =>
  `const sseRequest = <S extends Sse.EventSchema>(schema: S) =>
    (request: HttpClientRequest.HttpClientRequest): Stream.Stream<S["Type"], ...> =>
      httpClient.execute(request).pipe(
        Effect.map((response) => response.stream),
        Stream.unwrap,
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decodeSchema(schema))
      )`
```

### 4. Updated `operationToSseImpl` in OpenApiTransformer.ts

Composes the full event schema at the call site:

```typescript
const eventSchema = `${importName}.Struct({
    event: ${importName}.String,
    id: ${importName}.UndefinedOr(${importName}.String),
    data: ${operation.sseSchema}
  })`
pipeline.push(`sseRequest(${eventSchema})`)
```

### 5. Updated return type in `operationToSseMethod`

Returns the full event type:

```typescript
const returnType =
  `Stream.Stream<{ readonly event: string; readonly id: string | undefined; readonly data: typeof ${operation.sseSchema}.Type }, ...>`
```

### 6. Updated `OpenAiClient.ts`

Updated `streamRequest` to compose the event schema and use type assertion for the mapped type:

```typescript
const eventSchema = Schema.Struct({
  event: Schema.String,
  id: Schema.UndefinedOr(Schema.String),
  data: schema
})
return httpClientOk.execute(request).pipe(
  ...
  Stream.pipeThroughChannel(Sse.decodeSchema(eventSchema)),
  Stream.map((event) => (event as { readonly data: S["Type"] }).data),
  ...
)
```

## Files Modified

| File                                                         | Changes                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `packages/effect/src/unstable/encoding/Sse.ts`               | Added `EventSchema` type, updated `decodeSchema` signature               |
| `packages/tools/openapi-generator/src/OpenApiTransformer.ts` | Updated `sseRequestSource`, `operationToSseImpl`, `operationToSseMethod` |
| `packages/ai/openai/src/OpenAiClient.ts`                     | Updated `streamRequest` to compose event schema                          |
| `packages/ai/openai/src/Generated.ts`                        | Regenerated                                                              |

## Notes

- TypeScript has limitations with mapped types from `Schema.Struct`, requiring type assertions in some cases
- The `EventSchema` type is currently `Schema.Top` - a more restrictive constraint could be added later if needed
