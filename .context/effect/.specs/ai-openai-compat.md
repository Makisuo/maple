# OpenAI Compat Package for Minimal Schemas

## Overview

Add a new package `@effect/ai-openai-compat` that provides OpenAI LanguageModel + embeddings with minimal schemas and no full codegen client. It should be a lighter alternative to `@effect/ai-openai` while keeping the same runtime behavior for LanguageModel.

## Goals

- Ship `@effect/ai-openai-compat` under `packages/ai/openai-compat`.
- Implement LanguageModel + embeddings support.
- Keep OpenAiLanguageModel feature surface aligned with `@effect/ai-openai` (tools, structured output, streaming, telemetry, provider metadata).
- Replace full generated schemas with minimal, permissive schemas covering Responses + Embeddings endpoints only.
- Keep error mapping, config, and telemetry consistent with existing OpenAI package.

## Non-goals

- Full OpenAI API coverage beyond Responses + Embeddings.
- Strict model id literal unions (without a fallback to string).
- OpenAPI codegen in the compat package.
- Changes to existing `@effect/ai-openai` behavior.

## Assumptions

- Scope includes LanguageModel + embeddings (user choice).
- LanguageModel behavior should match `@effect/ai-openai`, but schema validation is minimal and permissive.
- Any additional endpoint coverage can be layered later without codegen.

## Current State

- `@effect/ai-openai` uses `Generated.ts` with full OpenAI OpenAPI codegen.
- `OpenAiClient` depends on generated client and schemas for responses, streaming, and embeddings.
- `OpenAiLanguageModel` relies on `Generated.*` types for request/response/tool structures.
- Provider-defined tools (`OpenAiTool`) use generated schema fields for parameters and results.

## Proposed Design

### Package Layout

`packages/ai/openai-compat/`

- `src/OpenAiSchema.ts` (minimal schemas only)
- `src/OpenAiClient.ts`
- `src/OpenAiLanguageModel.ts`
- `src/OpenAiTool.ts`
- `src/OpenAiStructuredOutput.ts`
- `src/OpenAiTelemetry.ts`
- `src/OpenAiError.ts`
- `src/OpenAiConfig.ts`
- `src/internal/errors.ts`
- `src/internal/utilities.ts` (if needed by LanguageModel)
- `src/index.ts` (generated via `pnpm codegen`)
- `test/...`
- `docgen.json`, `tsconfig.json`, `vitest.config.ts`, `package.json`

### Public API Surface

Exports should mirror `@effect/ai-openai` naming so users can switch packages:

- `OpenAiSchema` (minimal schema types only; no full codegen client)
- `OpenAiClient`
- `OpenAiConfig`
- `OpenAiError`
- `OpenAiLanguageModel`
- `OpenAiStructuredOutput`
- `OpenAiTelemetry`
- `OpenAiTool`

### Compatibility Notes

- Runtime behavior and error semantics should match `@effect/ai-openai` for LanguageModel.
- Type compatibility is best-effort: schemas are intentionally permissive, and model id literals are augmented with a string fallback.
- Schema decoding should accept unknown fields from the API; unknown stream events should be ignored, not treated as errors.

### Minimal Schema Strategy

- Create `OpenAiSchema.ts` manually (no codegen) with only:
  - `CreateResponse` request schema (fields used by LanguageModel).
  - `Response`, `ResponseUsage`, `ResponseStreamEvent` schemas (fields used for LM output conversion).
  - `Tool` and tool call item schemas needed by LM and `OpenAiTool`.
  - `Annotation` schema for citations.
  - `CreateEmbeddingRequest` and `CreateEmbeddingResponse` schemas.
- Use permissive schemas to avoid breakage:
- Keep the known model literal list but allow any string as a fallback (e.g. `Schema.Union([Schema.Literals([...]), Schema.String])`).
  - Allow unknown keys via `Schema.Record(Schema.String, Schema.Json)` or non-strict annotations where supported.
  - For tool-specific payloads, use `Schema.Json` for nested structures not required by LM logic.
- Provide type exports matching names used in `OpenAiLanguageModel` so the code ports with minimal changes.

### Schema Field Matrix (Minimum)

- `CreateResponse`:
  - `model`, `input`, `include`, `text.format`, `text.verbosity`, `tools`, `tool_choice`, `stream`, `store`, `conversation`.
  - Optional passthrough fields used by config: `metadata`, `user`, `temperature`, `top_p`, `top_logprobs`, `max_output_tokens`, `reasoning`, `truncation`, `seed`, `service_tier`, `parallel_tool_calls`, `modalities`.
- `InputItem` and `InputContent`:
  - `role` + `content` for user/system/developer.
  - Content parts: `input_text`, `input_image` (file_id or image_url, detail), `input_file` (file_id, file_url, file_data, filename).
- `Tool`:
  - Function tools with `name`, `description`, and JSON Schema parameters.
  - Provider-defined tool names used by LM (`apply_patch`, `shell`, `local_shell`, `web_search`, `web_search_preview`, `code_interpreter`, `file_search`, `image_generation`, `mcp`, `computer_use`) with opaque args.
- `Response`:
  - `id`, `model`, `created_at`, `output`, `usage`, `incomplete_details`, `service_tier`.
  - Output item types handled by LM: `message`, `reasoning`, `function_call`, `apply_patch_call`, `shell_call`, `local_shell_call`, `code_interpreter_call`, `file_search_call`, `web_search_call`, `image_generation_call`, `mcp_call`, `mcp_approval_request`, `mcp_list_tools`, `computer_call` (if referenced).
- `Annotation`:
  - `type`, `file_id`, `container_id`, `filename`, `index`, `url`, `title`, `start_index`, `end_index`.
- `ResponseUsage`:
  - `input_tokens`, `output_tokens`, `total_tokens`, optional token details (as `Schema.Json`).
- `ResponseStreamEvent`:
  - `type` plus event-specific payload for the event types referenced by streaming logic.
  - Unknown event fallback: `{ type: string; [key: string]: Json }`.
- `CreateEmbeddingRequest`:
  - `model`, `input`, `dimensions`, `encoding_format`, `user`.
- `CreateEmbeddingResponse`:
  - `data[]` with `embedding: number[]`, `index`, `object`, plus `model` and `usage` when present.

### OpenAiClient (compat)

- Implement HTTP calls directly using `HttpClient`:
  - `createResponse`: POST `/responses`.
  - `createResponseStream`: POST `/responses` with `stream: true`, decode SSE via `Sse.decodeSchema` using minimal `ResponseStreamEvent` schema.
  - `createEmbedding`: POST `/embeddings`.
- Reuse `OpenAiConfig` for optional client transform.
- Reuse error mapping from `packages/ai/openai/src/internal/errors.ts`, swapping schema references to minimal ones.
- Keep headers, API key, org/project handling identical to existing client.

### OpenAiLanguageModel (compat)

- Port `OpenAiLanguageModel.ts` with minimal changes:
  - Use compat `Generated` types and schemas.
  - `Model` type should be a union of known literals plus `string & {}` (allow any string).
  - Keep tool mapping, structured output, streaming, reasoning, and metadata behavior consistent.
  - Ensure request construction uses minimal `CreateResponse` schema with permissive extra fields.
- Continue to use `OpenAiStructuredOutput` for JSON schema conversion.
- Continue to add OpenAI telemetry attributes via `OpenAiTelemetry`.

### Streaming Semantics

- Decode SSE events with `Sse.decodeSchema` using minimal `ResponseStreamEvent`.
- Handle the same event types as `@effect/ai-openai`; unknown events should be ignored.
- Treat `response.completed`, `response.incomplete`, and `response.failed` as terminal events that emit a finish part.

### OpenAiTool (compat)

- Keep provider-defined tools but relax schemas:
  - Parameters and outputs for complex tools use `Schema.Json` or minimal structs.
  - Avoid importing full generated field schemas.
- If tool definitions are too heavy, defer any extra options to follow-up work, but base LM tool calling stays intact.

### Docs and Exports

- `docgen.json` should exclude `src/OpenAiSchema.ts` and `src/internal/**`.
- `index.ts` must be generated via `pnpm codegen` (no manual edits).

### Workspace Updates

- Add new path mappings in `tsconfig.json` and `tsconfig.packages.json`:
  - `@effect/ai-openai-compat` and `@effect/ai-openai-compat/*`.
- Ensure `pnpm-lock.yaml` updates after workspace install.

## Testing Plan

- Add tests under `packages/ai/openai-compat/test`:
  - `OpenAiCompatClient.test.ts`: headers, request paths, error mapping, embedding request/response decode.
  - `OpenAiCompatLanguageModel.test.ts`: port key LM tests (generateText, streamText, tool calls, structured output).
- Add a focused test for permissive schema handling (unknown fields in response or stream event).
- Use `@effect/vitest` and `it.effect` pattern, matching existing tests.

## Validation

- Run `pnpm lint-fix`.
- Run `pnpm test <new test file>` for each new test file.
- Run `pnpm check` (if failing, `pnpm clean` then re-run).
- Run `pnpm build`.
- Run `pnpm docgen`.

## Implementation Plan

1. Scaffold `packages/ai/openai-compat` with `package.json`, `tsconfig.json`, `vitest.config.ts`, `docgen.json`, base `src` folder, and workspace path mappings. Include minimal, valid module stubs required by exports so `pnpm check/build/docgen` can pass once codegen runs.
2. Implement minimal `src/OpenAiSchema.ts`, `OpenAiClient.ts`, `OpenAiConfig.ts`, `OpenAiError.ts`, and `src/internal/errors.ts` together, with direct HTTP calls and permissive schemas for Responses + Embeddings.
3. Implement `OpenAiLanguageModel`, `OpenAiTelemetry`, `OpenAiStructuredOutput`, `OpenAiTool`, and any shared utilities in one step to keep feature parity and avoid validation gaps.
4. Add compat test suite (client, LM, structured output/tool smoke, permissive schema handling) using `@effect/vitest` patterns.
5. Run `pnpm codegen` to generate `src/index.ts` exports and then run validations: `pnpm lint-fix`, `pnpm test <new tests>`, `pnpm check` (and `pnpm clean` if needed), `pnpm build`, `pnpm docgen`.
