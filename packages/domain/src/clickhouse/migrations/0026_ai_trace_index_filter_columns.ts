/**
 * Migration 0026 — the filter dimensions the Agent Sessions sidebar offers,
 * and the per-span measures the page ranks and filters on.
 *
 * `ai_trace_index` (0024) carried only the `maple_ai.*` identity and the
 * service, so the list could be sliced by framework and by service and by
 * nothing else. The dimensions a customer actually reaches for first — which
 * model, which agent, which tool, which environment, which sessions failed or
 * cost the most — were facts of the raw span, readable only through the
 * `trace_detail_spans` fan-out, which is the expensive half of the read, runs
 * over one page at a time since #741, and cannot serve a facet count or rank a
 * page.
 *
 * Twelve columns, all pre-extracted at insert by `ai_trace_index_mv`, all facts
 * of the GenAI span itself (see `tinybird/gen-ai-columns.ts`, which is also
 * what a raw-table read of the same fact compiles from):
 *
 *   - `DeploymentEnv`: the resource attribute under either semconv spelling,
 *     the same `DEPLOYMENT_ENV_SQL` every other pre-extracting MV uses.
 *   - `Model`, `AgentName`, `ToolName`: the GenAI identity of the span,
 *     coalesced across the canonical `gen_ai.*` keys and the Vercel AI SDK and
 *     OpenInference dialects. `''` where the span carries no such fact — a
 *     chat span has no tool, a tool span no model.
 *   - `IsLlmCall`, `IsToolCall`, `IsError`: the span's kind and whether it
 *     failed, by the same rules the detail page classifies with.
 *   - `Tokens`, `Cost`: the usage the span reported across every bucket, and
 *     `SpanId`/`ParentSpanId` so a wrapper span's roll-up of its children's
 *     usage can be taken off it at read time. `Duration`, so the page can
 *     measure a session's agent-span extent.
 *
 * A row materialized before this migration reads `''`/0 throughout: the facets
 * drop the blank option, the filters never match it, and the sums count it as
 * nothing — such a session is still detected and listed, sliceable by framework
 * and service, and ranked as if free.
 *
 * NOTHING IS BACKFILLED, for the same reason 0024 backfilled nothing: the
 * index fills forward and raw `traces`' 30-day TTL ages the gap out. The
 * ALTERs are metadata-only; the view is dropped and recreated because a
 * materialized view's SELECT is frozen at creation.
 *
 * `requiredForIngest: false` — the gateway writes `traces`, never this table.
 *
 * The CREATE statement below is the verbatim DDL as the schema emitter produced
 * it at v26. Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0026_ai_trace_index_filter_columns = {
	version: 26,
	description:
		"Add the sidebar's filter dimensions and the page's per-span measures to ai_trace_index and recreate ai_trace_index_mv to fill them",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS DeploymentEnv LowCardinality(String)",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS Model LowCardinality(String)",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS AgentName LowCardinality(String)",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS ToolName LowCardinality(String)",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS SpanId String",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS ParentSpanId String",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS Duration UInt64",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS IsError UInt8",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS IsLlmCall UInt8",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS IsToolCall UInt8",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS Tokens Float64",
		"ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS Cost Float64",
		"DROP VIEW IF EXISTS ai_trace_index_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS ai_trace_index_mv TO ai_trace_index AS\nSELECT\n          OrgId,\n          Timestamp,\n          TraceId,\n          SpanAttributes['maple_ai.session.id'] AS SessionId,\n          SpanAttributes['maple_ai.vendor.id'] AS VendorId,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          coalesce(nullIf(SpanAttributes['gen_ai.response.model'], ''), nullIf(SpanAttributes['gen_ai.request.model'], ''), nullIf(SpanAttributes['ai.response.model'], ''), nullIf(SpanAttributes['ai.model.id'], ''), SpanAttributes['llm.model_name']) AS Model,\n          coalesce(nullIf(SpanAttributes['gen_ai.agent.name'], ''), SpanAttributes['ai.telemetry.functionId']) AS AgentName,\n          coalesce(nullIf(SpanAttributes['gen_ai.tool.name'], ''), nullIf(SpanAttributes['ai.toolCall.name'], ''), SpanAttributes['tool.name']) AS ToolName,\n          SpanId,\n          ParentSpanId,\n          Duration,\n          toUInt8(((StatusCode = 'Error' OR SpanAttributes['error.type'] != '') OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))) AS IsError,\n          toUInt8((coalesce(nullIf(SpanAttributes['gen_ai.operation.name'], ''), multiIf(SpanAttributes['openinference.span.kind'] = 'LLM', 'chat', SpanAttributes['openinference.span.kind'] = 'TOOL', 'execute_tool', SpanAttributes['openinference.span.kind'] = 'AGENT', 'invoke_agent', SpanAttributes['openinference.span.kind'] = 'EMBEDDING', 'embeddings', SpanAttributes['openinference.span.kind'] = 'RETRIEVER', 'retrieval', '')) IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR (((coalesce(nullIf(SpanAttributes['gen_ai.operation.name'], ''), multiIf(SpanAttributes['openinference.span.kind'] = 'LLM', 'chat', SpanAttributes['openinference.span.kind'] = 'TOOL', 'execute_tool', SpanAttributes['openinference.span.kind'] = 'AGENT', 'invoke_agent', SpanAttributes['openinference.span.kind'] = 'EMBEDDING', 'embeddings', SpanAttributes['openinference.span.kind'] = 'RETRIEVER', 'retrieval', '')) NOT IN ('chat', 'generate_content', 'text_completion', 'fetch_response', 'embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step') AND NOT ((coalesce(nullIf(SpanAttributes['gen_ai.tool.name'], ''), nullIf(SpanAttributes['ai.toolCall.name'], ''), SpanAttributes['tool.name']) != '' OR lower(SpanName) LIKE '%tool%'))) AND NOT ((lower(SpanName) LIKE '%agent%' OR lower(SpanName) LIKE '%workflow%'))) AND (coalesce(nullIf(SpanAttributes['gen_ai.response.model'], ''), nullIf(SpanAttributes['gen_ai.request.model'], ''), nullIf(SpanAttributes['ai.response.model'], ''), nullIf(SpanAttributes['ai.model.id'], ''), SpanAttributes['llm.model_name']) != '' OR (lower(SpanName) LIKE '%chat%' OR lower(SpanName) LIKE '%completion%'))))) AS IsLlmCall,\n          toUInt8((coalesce(nullIf(SpanAttributes['gen_ai.operation.name'], ''), multiIf(SpanAttributes['openinference.span.kind'] = 'LLM', 'chat', SpanAttributes['openinference.span.kind'] = 'TOOL', 'execute_tool', SpanAttributes['openinference.span.kind'] = 'AGENT', 'invoke_agent', SpanAttributes['openinference.span.kind'] = 'EMBEDDING', 'embeddings', SpanAttributes['openinference.span.kind'] = 'RETRIEVER', 'retrieval', '')) IN ('execute_tool') OR (coalesce(nullIf(SpanAttributes['gen_ai.operation.name'], ''), multiIf(SpanAttributes['openinference.span.kind'] = 'LLM', 'chat', SpanAttributes['openinference.span.kind'] = 'TOOL', 'execute_tool', SpanAttributes['openinference.span.kind'] = 'AGENT', 'invoke_agent', SpanAttributes['openinference.span.kind'] = 'EMBEDDING', 'embeddings', SpanAttributes['openinference.span.kind'] = 'RETRIEVER', 'retrieval', '')) NOT IN ('chat', 'generate_content', 'text_completion', 'fetch_response', 'embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step') AND (coalesce(nullIf(SpanAttributes['gen_ai.tool.name'], ''), nullIf(SpanAttributes['ai.toolCall.name'], ''), SpanAttributes['tool.name']) != '' OR lower(SpanName) LIKE '%tool%')))) AS IsToolCall,\n          toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning'])) AS Tokens,\n          toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cost'], ''), nullIf(SpanAttributes['gen_ai.usage.total_cost'], ''), SpanAttributes['llm.cost.total'])) AS Cost\n        FROM traces\n        WHERE SpanAttributes['maple_ai.vendor.id'] != ''",
	],
} as const
