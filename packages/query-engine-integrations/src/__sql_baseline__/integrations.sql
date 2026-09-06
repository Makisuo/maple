-- builder:ai-sessions:aiSessionFacetsQuery:default
SELECT
          arrayJoin(names) AS name,
          uniqExact(if(rawSessionId = '', concat('trace:', traceId), rawSessionId)) AS count,
          'vendor' AS facetType
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          groupUniqArray(VendorId) AS names
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND VendorId != ''
        GROUP BY traceId) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(names) AS name,
          uniqExact(if(rawSessionId = '', concat('trace:', traceId), rawSessionId)) AS count,
          'service' AS facetType
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          groupUniqArray(ServiceName) AS names
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName != ''
        GROUP BY traceId) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(names) AS name,
          uniqExact(if(rawSessionId = '', concat('trace:', traceId), rawSessionId)) AS count,
          'environment' AS facetType
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          groupUniqArray(DeploymentEnv) AS names
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY traceId) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(names) AS name,
          uniqExact(if(rawSessionId = '', concat('trace:', traceId), rawSessionId)) AS count,
          'model' AS facetType
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          groupUniqArray(Model) AS names
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Model != ''
        GROUP BY traceId) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(names) AS name,
          uniqExact(if(rawSessionId = '', concat('trace:', traceId), rawSessionId)) AS count,
          'agent' AS facetType
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          groupUniqArray(AgentName) AS names
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND AgentName != ''
        GROUP BY traceId) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(names) AS name,
          uniqExact(if(rawSessionId = '', concat('trace:', traceId), rawSessionId)) AS count,
          'tool' AS facetType
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          groupUniqArray(ToolName) AS names
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ToolName != ''
        GROUP BY traceId) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:ai-sessions:aiSessionListQuery:default
SELECT
          if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId) AS sessionId,
          argMin(session_traces.vendorId, session_traces.sessionStart) AS vendorId,
          argMin(session_traces.vendorVersion, session_traces.sessionStart) AS vendorVersion,
          count() AS traceCount,
          sum(session_traces.spanCount) AS spanCount,
          sum(session_traces.errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(session_traces.serviceNames) AS serviceNames,
          sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageBuckets)), usageBuckets)) AS inputTokens,
          sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageBuckets)), usageBuckets)) AS cacheReadTokens,
          sum(arraySum(r -> greatest(0., r.5 - arraySum(c -> if(c.2 = r.1, c.5, 0.), usageBuckets)), usageBuckets)) AS cacheWriteTokens,
          sum(arraySum(r -> greatest(0., r.6 - arraySum(c -> if(c.2 = r.1, c.6, 0.), usageBuckets)), usageBuckets)) AS outputTokens,
          sum(arraySum(r -> greatest(0., r.7 - arraySum(c -> if(c.2 = r.1, c.7, 0.), usageBuckets)), usageBuckets)) AS reasoningTokens,
          toString(min(session_traces.traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(session_traces.traceEndNanos))) AS endTime,
          intDiv(max(session_traces.traceEndNanos) - toUnixTimestamp64Nano(min(session_traces.traceStart)), 1000000) AS durationMs
        FROM (SELECT
          TraceId AS traceId,
          argMin(SpanAttributes['maple_ai.vendor.id'], tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)) AS vendorId,
          argMin(SpanAttributes['maple_ai.vendor.version'], tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)) AS vendorVersion,
          min(if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS sessionStart,
          count() AS spanCount,
          countIf((StatusCode = 'Error' OR (SpanAttributes['maple_ai.vendor.id'] != '' AND (SpanAttributes['error.type'] != '' OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))) AS errorSpanCount,
          groupUniqArray(ServiceName) AS serviceNames,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, if((coalesce(nullIf(SpanAttributes['gen_ai.provider.name'], ''), nullIf(SpanAttributes['gen_ai.system'], ''), nullIf(SpanAttributes['ai.model.provider'], ''), nullIf(SpanAttributes['llm.provider'], ''), SpanAttributes['llm.system']) IN ('anthropic') AND NOT (SpanAttributes['maple_ai.vendor.id'] IN ('vercel_ai_sdk', 'maple'))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])), greatest(0, toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) - toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) - toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning']))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning'])) > 0) AS usageBuckets,
          min(Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00' - INTERVAL 3600 SECOND
          AND Timestamp <= '2026-01-02 12:30:00' + INTERVAL 3600 SECOND
          AND TraceId IN (SELECT
          traceId AS traceId
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00'
          AND Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId) AS agent_traces
        WHERE if(rawSessionId = '', concat('trace:', traceId), rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef'))
        GROUP BY traceId) AS session_traces
        INNER JOIN (SELECT
          traceId AS traceId,
          rawSessionId AS rawSessionId
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00'
          AND Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId) AS agent_traces
        WHERE if(rawSessionId = '', concat('trace:', traceId), rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')) AS index_traces ON session_traces.traceId = index_traces.traceId
        GROUP BY sessionId
        ORDER BY startTime DESC
        FORMAT JSON

-- builder:ai-sessions:aiSessionListQuery:every-counted-filter
SELECT
          if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId) AS sessionId,
          argMin(session_traces.vendorId, session_traces.sessionStart) AS vendorId,
          argMin(session_traces.vendorVersion, session_traces.sessionStart) AS vendorVersion,
          count() AS traceCount,
          sum(session_traces.spanCount) AS spanCount,
          sum(session_traces.errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(session_traces.serviceNames) AS serviceNames,
          sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageBuckets)), usageBuckets)) AS inputTokens,
          sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageBuckets)), usageBuckets)) AS cacheReadTokens,
          sum(arraySum(r -> greatest(0., r.5 - arraySum(c -> if(c.2 = r.1, c.5, 0.), usageBuckets)), usageBuckets)) AS cacheWriteTokens,
          sum(arraySum(r -> greatest(0., r.6 - arraySum(c -> if(c.2 = r.1, c.6, 0.), usageBuckets)), usageBuckets)) AS outputTokens,
          sum(arraySum(r -> greatest(0., r.7 - arraySum(c -> if(c.2 = r.1, c.7, 0.), usageBuckets)), usageBuckets)) AS reasoningTokens,
          toString(min(session_traces.traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(session_traces.traceEndNanos))) AS endTime,
          intDiv(max(session_traces.traceEndNanos) - toUnixTimestamp64Nano(min(session_traces.traceStart)), 1000000) AS durationMs
        FROM (SELECT
          TraceId AS traceId,
          argMin(SpanAttributes['maple_ai.vendor.id'], tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)) AS vendorId,
          argMin(SpanAttributes['maple_ai.vendor.version'], tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)) AS vendorVersion,
          min(if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS sessionStart,
          count() AS spanCount,
          countIf((StatusCode = 'Error' OR (SpanAttributes['maple_ai.vendor.id'] != '' AND (SpanAttributes['error.type'] != '' OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))) AS errorSpanCount,
          groupUniqArray(ServiceName) AS serviceNames,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, if((coalesce(nullIf(SpanAttributes['gen_ai.provider.name'], ''), nullIf(SpanAttributes['gen_ai.system'], ''), nullIf(SpanAttributes['ai.model.provider'], ''), nullIf(SpanAttributes['llm.provider'], ''), SpanAttributes['llm.system']) IN ('anthropic') AND NOT (SpanAttributes['maple_ai.vendor.id'] IN ('vercel_ai_sdk', 'maple'))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])), greatest(0, toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) - toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) - toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning']))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning'])) > 0) AS usageBuckets,
          min(Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00' - INTERVAL 3600 SECOND
          AND Timestamp <= '2026-01-02 12:30:00' + INTERVAL 3600 SECOND
          AND TraceId IN (SELECT
          traceId AS traceId
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00'
          AND Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf(DeploymentEnv IN ('production')) > 0
          AND countIf(Model IN ('gpt-5.5')) > 0
          AND countIf(AgentName IN ('billing-agent')) > 0
          AND countIf(ToolName IN ('send_email')) > 0
          AND countIf((SessionId LIKE 'wrun\\_01%' OR TraceId LIKE 'wrun\\_01%')) > 0) AS agent_traces
        WHERE if(rawSessionId = '', concat('trace:', traceId), rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef'))
        GROUP BY traceId) AS session_traces
        INNER JOIN (SELECT
          traceId AS traceId,
          rawSessionId AS rawSessionId
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00'
          AND Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf(DeploymentEnv IN ('production')) > 0
          AND countIf(Model IN ('gpt-5.5')) > 0
          AND countIf(AgentName IN ('billing-agent')) > 0
          AND countIf(ToolName IN ('send_email')) > 0
          AND countIf((SessionId LIKE 'wrun\\_01%' OR TraceId LIKE 'wrun\\_01%')) > 0) AS agent_traces
        WHERE if(rawSessionId = '', concat('trace:', traceId), rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')) AS index_traces ON session_traces.traceId = index_traces.traceId
        GROUP BY sessionId
        ORDER BY startTime DESC
        FORMAT JSON

-- builder:ai-sessions:aiSessionListQuery:filtered
SELECT
          if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId) AS sessionId,
          argMin(session_traces.vendorId, session_traces.sessionStart) AS vendorId,
          argMin(session_traces.vendorVersion, session_traces.sessionStart) AS vendorVersion,
          count() AS traceCount,
          sum(session_traces.spanCount) AS spanCount,
          sum(session_traces.errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(session_traces.serviceNames) AS serviceNames,
          sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageBuckets)), usageBuckets)) AS inputTokens,
          sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageBuckets)), usageBuckets)) AS cacheReadTokens,
          sum(arraySum(r -> greatest(0., r.5 - arraySum(c -> if(c.2 = r.1, c.5, 0.), usageBuckets)), usageBuckets)) AS cacheWriteTokens,
          sum(arraySum(r -> greatest(0., r.6 - arraySum(c -> if(c.2 = r.1, c.6, 0.), usageBuckets)), usageBuckets)) AS outputTokens,
          sum(arraySum(r -> greatest(0., r.7 - arraySum(c -> if(c.2 = r.1, c.7, 0.), usageBuckets)), usageBuckets)) AS reasoningTokens,
          toString(min(session_traces.traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(session_traces.traceEndNanos))) AS endTime,
          intDiv(max(session_traces.traceEndNanos) - toUnixTimestamp64Nano(min(session_traces.traceStart)), 1000000) AS durationMs
        FROM (SELECT
          TraceId AS traceId,
          argMin(SpanAttributes['maple_ai.vendor.id'], tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)) AS vendorId,
          argMin(SpanAttributes['maple_ai.vendor.version'], tuple(multiIf((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), 0, SpanAttributes['maple_ai.vendor.id'] != '', 1, 2), Timestamp)) AS vendorVersion,
          min(if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS sessionStart,
          count() AS spanCount,
          countIf((StatusCode = 'Error' OR (SpanAttributes['maple_ai.vendor.id'] != '' AND (SpanAttributes['error.type'] != '' OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))) AS errorSpanCount,
          groupUniqArray(ServiceName) AS serviceNames,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, if((coalesce(nullIf(SpanAttributes['gen_ai.provider.name'], ''), nullIf(SpanAttributes['gen_ai.system'], ''), nullIf(SpanAttributes['ai.model.provider'], ''), nullIf(SpanAttributes['llm.provider'], ''), SpanAttributes['llm.system']) IN ('anthropic') AND NOT (SpanAttributes['maple_ai.vendor.id'] IN ('vercel_ai_sdk', 'maple'))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])), greatest(0, toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) - toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) - toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning']))), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokens'], ''), nullIf(SpanAttributes['ai.usage.promptTokens'], ''), SpanAttributes['llm.token_count.prompt'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), SpanAttributes['llm.token_count.prompt_details.cache_read'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.cache_creation.input_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.cache_write.input_tokens'], ''), SpanAttributes['ai.usage.inputTokenDetails.cacheWriteTokens'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokens'], ''), nullIf(SpanAttributes['ai.usage.completionTokens'], ''), SpanAttributes['llm.token_count.completion'])) + toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.reasoning.output_tokens'], ''), nullIf(SpanAttributes['gen_ai.usage.output_tokens.reasoning'], ''), nullIf(SpanAttributes['ai.usage.reasoningTokens'], ''), nullIf(SpanAttributes['ai.usage.outputTokenDetails.reasoningTokens'], ''), SpanAttributes['llm.token_count.completion_details.reasoning'])) > 0) AS usageBuckets,
          min(Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00' - INTERVAL 3600 SECOND
          AND Timestamp <= '2026-01-02 12:30:00' + INTERVAL 3600 SECOND
          AND TraceId IN (SELECT
          traceId AS traceId
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00'
          AND Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf(VendorId IN ('eve')) > 0
          AND countIf(ServiceName IN ('maple-slack-agent')) > 0) AS agent_traces
        WHERE if(rawSessionId = '', concat('trace:', traceId), rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef'))
        GROUP BY traceId) AS session_traces
        INNER JOIN (SELECT
          traceId AS traceId,
          rawSessionId AS rawSessionId
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-02 10:30:00'
          AND Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf(VendorId IN ('eve')) > 0
          AND countIf(ServiceName IN ('maple-slack-agent')) > 0) AS agent_traces
        WHERE if(rawSessionId = '', concat('trace:', traceId), rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')) AS index_traces ON session_traces.traceId = index_traces.traceId
        GROUP BY sessionId
        ORDER BY startTime DESC
        FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:default
SELECT
          if(rawSessionId = '', concat('trace:', traceId), rawSessionId) AS sessionId,
          toString(min(traceAgentStart)) AS agentStart,
          toString(max(traceAgentEnd)) AS agentEnd,
          groupUniqArrayArray(models) AS models,
          groupUniqArrayArray(agentNames) AS agentNames,
          sum(llmCalls) AS llmCalls,
          sum(toolCalls) AS toolCalls,
          sum(errorAgentSpans) AS errorAgentSpans,
          sum(arrayCount(f -> f.3 = 1 AND NOT arrayExists(c -> c.2 = f.1, failedSpans), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT arrayExists(c -> c.2 = f.1, failedSpans), failedSpans)) AS turnErrors,
          sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageReporters)), usageReporters)) AS totalTokens,
          sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageReporters)), usageReporters)) AS cost,
          intDiv(max(traceAgentEndNanos) - toUnixTimestamp64Nano(min(traceAgentStart)), 1000000) AS agentDurationMs
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId) AS index_traces
        GROUP BY sessionId
        ORDER BY agentStart DESC, sessionId ASC
        LIMIT 50
        FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:every-filter
SELECT
          if(rawSessionId = '', concat('trace:', traceId), rawSessionId) AS sessionId,
          toString(min(traceAgentStart)) AS agentStart,
          toString(max(traceAgentEnd)) AS agentEnd,
          groupUniqArrayArray(models) AS models,
          groupUniqArrayArray(agentNames) AS agentNames,
          sum(llmCalls) AS llmCalls,
          sum(toolCalls) AS toolCalls,
          sum(errorAgentSpans) AS errorAgentSpans,
          sum(arrayCount(f -> f.3 = 1 AND NOT arrayExists(c -> c.2 = f.1, failedSpans), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT arrayExists(c -> c.2 = f.1, failedSpans), failedSpans)) AS turnErrors,
          sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageReporters)), usageReporters)) AS totalTokens,
          sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageReporters)), usageReporters)) AS cost,
          intDiv(max(traceAgentEndNanos) - toUnixTimestamp64Nano(min(traceAgentStart)), 1000000) AS agentDurationMs
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf(VendorId IN ('eve')) > 0
          AND countIf(ServiceName IN ('maple-slack-agent')) > 0
          AND countIf(DeploymentEnv IN ('production')) > 0
          AND countIf(Model IN ('gpt-5.5')) > 0
          AND countIf(AgentName IN ('billing-agent')) > 0
          AND countIf(ToolName IN ('send_email')) > 0
          AND countIf((SessionId LIKE 'wrun\\_01%' OR TraceId LIKE 'wrun\\_01%')) > 0) AS index_traces
        GROUP BY sessionId
        HAVING errorAgentSpans > 0
          AND NOT (sessionId LIKE 'trace:%')
          AND agentDurationMs >= 1000
          AND agentDurationMs <= 600000
          AND cost >= 0.01
          AND cost <= 5
          AND totalTokens >= 100
          AND totalTokens <= 1000000
          AND llmCalls >= 1
          AND llmCalls <= 50
          AND toolCalls >= 1
          AND toolCalls <= 50
        ORDER BY cost ASC, agentStart DESC, sessionId ASC
        LIMIT 25
        OFFSET 25
        FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:filtered
SELECT
          if(rawSessionId = '', concat('trace:', traceId), rawSessionId) AS sessionId,
          toString(min(traceAgentStart)) AS agentStart,
          toString(max(traceAgentEnd)) AS agentEnd,
          groupUniqArrayArray(models) AS models,
          groupUniqArrayArray(agentNames) AS agentNames,
          sum(llmCalls) AS llmCalls,
          sum(toolCalls) AS toolCalls,
          sum(errorAgentSpans) AS errorAgentSpans,
          sum(arrayCount(f -> f.3 = 1 AND NOT arrayExists(c -> c.2 = f.1, failedSpans), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT arrayExists(c -> c.2 = f.1, failedSpans), failedSpans)) AS turnErrors,
          sum(arraySum(r -> greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), usageReporters)), usageReporters)) AS totalTokens,
          sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageReporters)), usageReporters)) AS cost,
          intDiv(max(traceAgentEndNanos) - toUnixTimestamp64Nano(min(traceAgentStart)), 1000000) AS agentDurationMs
        FROM (SELECT
          TraceId AS traceId,
          max(SessionId) AS rawSessionId,
          min(Timestamp) AS traceAgentStart,
          max(Timestamp) AS traceAgentEnd,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceAgentEndNanos,
          groupUniqArrayIf(20)(Model, Model != '') AS models,
          groupUniqArrayIf(20)(AgentName, AgentName != '') AS agentNames,
          sum(IsLlmCall) AS llmCalls,
          sum(IsToolCall) AS toolCalls,
          sum(IsError) AS errorAgentSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0)) AS usageReporters
        FROM ai_trace_index
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf(VendorId IN ('eve')) > 0
          AND countIf(ServiceName IN ('maple-slack-agent')) > 0) AS index_traces
        GROUP BY sessionId
        ORDER BY agentStart DESC, sessionId ASC
        LIMIT 25
        OFFSET 25
        FORMAT JSON

-- builder:ai-sessions:aiSessionSpansQuery:default
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          SpanName AS spanName,
          SpanKind AS spanKind,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toString(Timestamp) AS timestamp,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND TraceId IN (SELECT
          TraceId AS TraceId
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')
          AND SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog')
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:ai-sessions:aiSessionWindowQuery:default
SELECT
          toString(min(Timestamp) - INTERVAL 86400 SECOND) AS startTime,
          toString(max(Timestamp) + INTERVAL 86400 SECOND) AS endTime,
          count() AS spanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND (mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')
          AND SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog'
        FORMAT JSON

-- builder:ai-sessions:aiTraceSpansQuery:default
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          SpanName AS spanName,
          SpanKind AS spanKind,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toString(Timestamp) AS timestamp,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND TraceId = '7f3a4b5c6d7e8f901234567890abcdef'
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:ai-sessions:aiTraceWindowQuery:default
SELECT
          toString(min(Timestamp) - INTERVAL 86400 SECOND) AS startTime,
          toString(max(Timestamp) + INTERVAL 86400 SECOND) AS endTime,
          count() AS spanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND TraceId = '7f3a4b5c6d7e8f901234567890abcdef'
        FORMAT JSON

-- builder:billing-usage:dailyProductEventCountQuery:default
SELECT
          toStartOfInterval(Timestamp, INTERVAL 86400 SECOND) AS day,
          count() AS events
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND Kind != 'navigation'
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON

-- builder:billing-usage:dailySessionCountQuery:default
SELECT
          toStartOfInterval(StartTime, INTERVAL 86400 SECOND) AS day,
          count() AS sessions
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= toDateTime('2026-01-01 10:30:00')
          AND StartTime <= toDateTime('2026-01-03 14:15:00')
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON

-- builder:billing-usage:dailySignalVolumeQuery:default
SELECT
          toStartOfInterval(Hour, INTERVAL 86400 SECOND) AS day,
          sum(LogSizeBytes) AS logBytes,
          sum(TraceSizeBytes) AS traceBytes,
          sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS metricBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownCoverageSQL:default
SELECT
          formatDateTime(min(TimeUnix), '%Y-%m-%dT%H:%i:%S.%fZ') AS coverageStart,
          sum(Value) AS attributedRequests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_path'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(Attributes['url.path'] IN ('/api/v2/traces'), Attributes['url.path'], 'other') AS key,
          sum(Value) AS requests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_path'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, key
        ORDER BY bucket ASC, key ASC
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownTotalsSQL:default
SELECT
          Attributes['url.path'] AS key,
          sumIf(Value, MetricName = 'cloudflare.http.requests.by_path') AS requests,
          sumIf(Value, MetricName = 'cloudflare.http.errors.by_path') AS errors5xx,
          sumIf(Value, MetricName = 'cloudflare.http.bytes.by_path') AS bytes
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName IN ('cloudflare.http.requests.by_path', 'cloudflare.http.errors.by_path', 'cloudflare.http.bytes.by_path')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY key
        ORDER BY requests DESC
        LIMIT 100
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneFacetsQuery:default
SELECT
          if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) AS name,
          sum(Value) AS count,
          'host' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          Attributes['cache.status'] AS name,
          sum(Value) AS count,
          'cacheStatus' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['cache.status'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          Attributes['http.status_class'] AS name,
          sum(Value) AS count,
          'statusClass' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['http.status_class'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
UNION ALL
SELECT
          Attributes['url.path'] AS name,
          sum(Value) AS count,
          'path' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_path'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['url.path'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          Attributes['geo.country_iso_code'] AS name,
          sum(Value) AS count,
          'country' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_country'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['geo.country_iso_code'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          Attributes['http.request.method'] AS name,
          sum(Value) AS count,
          'method' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_client'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['http.request.method'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          Attributes['network.protocol.version'] AS name,
          sum(Value) AS count,
          'protocol' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_client'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['network.protocol.version'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
UNION ALL
SELECT
          Attributes['cloudflare.device.type'] AS name,
          sum(Value) AS count,
          'deviceType' AS facetType
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_client'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['cloudflare.device.type'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareDurableObjectCountersSQL:default
SELECT
          ServiceName AS serviceName,
          sumIf(Value, MetricName = 'cloudflare.durable_object.requests') AS requests,
          sumIf(Value, MetricName = 'cloudflare.durable_object.errors') AS errors
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.durable_object.requests', 'cloudflare.durable_object.errors')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareQueueGaugesSQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf(MetricName = 'cloudflare.queue.backlog.messages') > 0, avgIf(Value, MetricName = 'cloudflare.queue.backlog.messages'), 0) AS backlogMessages,
          maxIf(Value, MetricName = 'cloudflare.queue.backlog.messages') AS backlogMessagesMax,
          if(countIf(MetricName = 'cloudflare.queue.backlog.bytes') > 0, avgIf(Value, MetricName = 'cloudflare.queue.backlog.bytes'), 0) AS backlogBytes,
          if(countIf(MetricName = 'cloudflare.queue.consumer.concurrency') > 0, avgIf(Value, MetricName = 'cloudflare.queue.consumer.concurrency'), 0) AS consumerConcurrency
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.queue.backlog.messages', 'cloudflare.queue.backlog.bytes', 'cloudflare.queue.consumer.concurrency')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY backlogMessagesMax DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneDnsBreakdownSQL:default
SELECT
          Attributes['dns.query_name'] AS queryName,
          sum(Value) AS queries,
          sumIf(Value, Attributes['dns.response_code'] = 'NXDOMAIN') AS nxdomain
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.dns.queries'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY queryName
        ORDER BY queries DESC
        LIMIT 25
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneDnsTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          Attributes['dns.response_code'] AS responseCode,
          sum(Value) AS queries
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.dns.queries'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, responseCode
        ORDER BY bucket ASC, responseCode ASC
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneFirewallTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          Attributes['firewall.action'] AS action,
          sum(Value) AS events
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.firewall.events'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, action
        ORDER BY bucket ASC, action ASC
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneFirewallTopSQL:default
SELECT
          Attributes['firewall.source'] AS source,
          Attributes['firewall.action'] AS action,
          Attributes['firewall.rule_id'] AS ruleId,
          if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) AS host,
          sum(Value) AS events
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.firewall.events'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY source, action, ruleId, host
        ORDER BY events DESC
        LIMIT 25
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareWorkerCountersSQL:default
SELECT
          ServiceName AS serviceName,
          sumIf(Value, MetricName = 'cloudflare.worker.requests') AS requests,
          sumIf(Value, MetricName = 'cloudflare.worker.errors') AS errors,
          sumIf(Value, MetricName = 'cloudflare.worker.subrequests') AS subrequests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.worker.requests', 'cloudflare.worker.errors', 'cloudflare.worker.subrequests')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareWorkerLatencySQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf((MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.5')), 0) AS cpuP50Ms,
          if(countIf((MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.99')), 0) AS cpuP99Ms,
          if(countIf((MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.5')), 0) AS durationP50Ms,
          if(countIf((MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.99')), 0) AS durationP99Ms
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneCacheTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          Attributes['cache.status'] AS cacheStatus,
          sum(Value) AS requests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, cacheStatus
        ORDER BY bucket ASC, cacheStatus ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneCountersSQL:default
SELECT
          ServiceName AS serviceName,
          sumIf(Value, MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(Value, MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(Value, MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneCountersSQL:filtered
SELECT
          ServiceName AS serviceName,
          sumIf(Value, MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(Value, MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(Value, MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) IN ('example.com')
          AND Attributes['http.status_class'] IN ('5xx')
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneLatencySQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.5')), 0) AS ttfbP50Ms,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.95')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.95')), 0) AS ttfbP95Ms,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.99')), 0) AS ttfbP99Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.5')), 0) AS originP50Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.95')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.95')), 0) AS originP95Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.99')), 0) AS originP99Ms
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneLatencyTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.5')), 0) AS ttfbP50Ms,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.95')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.95')), 0) AS ttfbP95Ms,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.99')), 0) AS ttfbP99Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.5')), 0) AS originP50Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.95')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.95')), 0) AS originP95Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.99')), 0) AS originP99Ms
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneStatusTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          Attributes['http.status_class'] AS statusClass,
          sum(Value) AS requests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, statusClass
        ORDER BY bucket ASC, statusClass ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneStatusTimeseriesSQL:filtered
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          Attributes['http.status_class'] AS statusClass,
          sum(Value) AS requests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) IN ('example.com')
          AND Attributes['http.status_class'] IN ('5xx')
        GROUP BY bucket, statusClass
        ORDER BY bucket ASC, statusClass ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneTimeseriesSQL:default
SELECT
          ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sumIf(Value, MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(Value, MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(Value, MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneTimeseriesSQL:filtered
SELECT
          ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sumIf(Value, MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(Value, MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(Value, MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) IN ('example.com')
          AND Attributes['http.status_class'] IN ('5xx')
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-map:cloudflareServiceCountersSQL:default
SELECT
          ServiceName AS serviceName,
          sumIf(Value, MetricName = 'cloudflare.worker.requests') AS requests,
          sumIf(Value, MetricName = 'cloudflare.worker.errors') AS errorCount
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.worker.requests', 'cloudflare.worker.errors')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-map:cloudflareServiceLatencySQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf((MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.99')), 0) AS latencyP99Ms,
          if(countIf((MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.99')), 0) AS cpuP99Ms
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-usage:cloudflareUsageQuery:default
SELECT
          ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 3600 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sum(Value) AS requests,
          count() AS datapoints,
          formatDateTime(max(TimeUnix), '%Y-%m-%dT%H:%i:%S.%fZ') AS lastTimeUnix
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-usage:cloudflareUsageStatsQuery:default
SELECT
          sumIf(Value, (MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests') AND TimeUnix < '2026-01-02 10:30:00')) AS previousRequests,
          sumIf(Value, ((MetricName = 'cloudflare.firewall.events' AND Attributes['firewall.action'] IN ('block', 'challenge', 'jschallenge', 'managed_challenge')) AND TimeUnix >= '2026-01-02 10:30:00')) AS firewallBlockedEvents
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests', 'cloudflare.firewall.events')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:internal:dbStatementSamplesQuery:default
SELECT
          coalesce(nullIf(SpanAttributes['db.query.fingerprint'], ''), SpanAttributes['db.statement.fingerprint']) AS fingerprint,
          any(SpanAttributes['query.context']) AS context,
          any(SpanAttributes['query.profile']) AS profile,
          any(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])) AS sampleSql,
          count() AS sampleCount,
          quantile(0.5)(Duration) / 1000000 AS p50DurationMs,
          quantile(0.95)(Duration) / 1000000 AS p95DurationMs,
          quantile(0.99)(Duration) / 1000000 AS p99DurationMs,
          max(Duration) / 1000000 AS maxDurationMs
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND SpanName = 'WarehouseQueryService.executeSql'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND coalesce(nullIf(SpanAttributes['db.query.fingerprint'], ''), SpanAttributes['db.statement.fingerprint']) != ''
        GROUP BY fingerprint
        ORDER BY p95DurationMs DESC
        LIMIT 25
        FORMAT JSON

-- builder:planetscale-infra:planetscaleBranchInfraTimeseriesSQL:default
SELECT
          toStartOfInterval(t, INTERVAL 300 SECOND) AS bucket,
          avg(totalConnections) AS connectionsAvg,
          max(cpuMax) AS cpuMaxPercent,
          max(memMax) AS memMaxPercent,
          max(lagMax) AS replicaLagMaxSeconds,
          maxIf(100 - availableBytes / capacityBytes * 100, (availableSamples > 0 AND capacityBytes > 0)) AS storageUsedPercent,
          sum(availableSamples) AS storageSamples
        FROM (SELECT
          TimeUnix AS t,
          sumIf(Value, MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')) AS totalConnections,
          maxIf(Value, MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMax,
          maxIf(Value, MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMax,
          maxIf(Value, MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS lagMax,
          maxIf(Value, MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(Value, MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(MetricName IN ('planetscale_volume_available_bytes')) AS availableSamples
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections', 'planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds', 'planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'maple-prd'
          AND coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch']) = 'main'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY t) AS points
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:planetscale-infra:planetscaleInfraTimeseriesSQL:default
SELECT
          toStartOfInterval(t, INTERVAL 300 SECOND) AS bucket,
          avg(totalConnections) AS connectionsAvg,
          max(cpuMax) AS cpuMaxPercent,
          max(memMax) AS memMaxPercent,
          max(lagMax) AS replicaLagMaxSeconds,
          maxIf(100 - availableBytes / capacityBytes * 100, (availableSamples > 0 AND capacityBytes > 0)) AS storageUsedPercent,
          sum(availableSamples) AS storageSamples
        FROM (SELECT
          TimeUnix AS t,
          sumIf(Value, MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')) AS totalConnections,
          maxIf(Value, MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMax,
          maxIf(Value, MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMax,
          maxIf(Value, MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS lagMax,
          maxIf(Value, MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(Value, MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(MetricName IN ('planetscale_volume_available_bytes')) AS availableSamples
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections', 'planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds', 'planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'maple-prd'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY t) AS points
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:planetscale-map:planetscaleBranchConnectionsSQL:default
SELECT
          database AS database,
          branch AS branch,
          avg(totalConnections) AS connectionsAvg,
          max(totalConnections) AS connectionsMax
        FROM (SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch']) AS branch,
          TimeUnix AS t,
          sum(Value) AS totalConnections
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'maple-prd'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch, t) AS conn
        GROUP BY database, branch
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleBranchGaugesSQL:default
SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch']) AS branch,
          maxIf(Value, MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMaxPercent,
          maxIf(Value, MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMaxPercent,
          maxIf(Value, MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS replicaLagMaxSeconds
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'maple-prd'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleBranchStorageSQL:default
SELECT
          database AS database,
          branch AS branch,
          if((capacityBytes > 0 AND samples > 0), 100 - availableBytes / capacityBytes * 100, 0) AS storageUsedPercent,
          capacityBytes AS storageCapacityBytes,
          availableBytes AS storageAvailableBytes,
          samples AS storageSamples
        FROM (SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch']) AS branch,
          maxIf(Value, MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(Value, MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(MetricName IN ('planetscale_volume_available_bytes')) AS samples
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'maple-prd'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch) AS vol
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleConnectionsSQL:default
SELECT
          database AS database,
          avg(totalConnections) AS connectionsAvg,
          max(totalConnections) AS connectionsMax
        FROM (SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          TimeUnix AS t,
          sum(Value) AS totalConnections
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) != ''
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, t) AS conn
        GROUP BY database
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleGaugesSQL:default
SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          maxIf(Value, MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMaxPercent,
          maxIf(Value, MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMaxPercent,
          maxIf(Value, MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS replicaLagMaxSeconds
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) != ''
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleStorageSQL:default
SELECT
          database AS database,
          max(if((capacityBytes > 0 AND samples > 0), 100 - availableBytes / capacityBytes * 100, 0)) AS storageUsedPercent,
          sum(samples) AS storageSamples
        FROM (SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch']) AS branch,
          maxIf(Value, MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(Value, MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(MetricName IN ('planetscale_volume_available_bytes')) AS samples
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) != ''
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch) AS vol
        GROUP BY database
        LIMIT 500
        FORMAT JSON

-- builder:setup-audit:auditAttributeKeyInventoryQuery:default
SELECT
          AttributeScope AS scope,
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND AttributeScope IN ('span', 'resource', 'log', 'metric')
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY scope, attributeKey
        ORDER BY usageCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditDbEdgeIdentityQuery:default
SELECT
          ServiceName AS serviceName,
          DbSystem AS dbSystem,
          sum(CallCount) AS callCount,
          sumIf(CallCount, DbNamespace = '') AS unknownNamespaceCallCount
        FROM service_map_db_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem != ''
        GROUP BY serviceName, dbSystem
        ORDER BY callCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditLogCorrelationQuery:default
SELECT
          ServiceName AS serviceName,
          count() AS logCount,
          countIf(TraceId = '') AS uncorrelatedCount,
          countIf(upper(SeverityText) IN ('ERROR', 'FATAL')) AS errorLogCount,
          countIf((TraceId = '' AND upper(SeverityText) IN ('ERROR', 'FATAL'))) AS uncorrelatedErrorCount
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY logCount DESC
        LIMIT 500
        FORMAT JSON

-- builder:setup-audit:auditLogSeverityByServiceQuery:default
SELECT
          ServiceName AS serviceName,
          SeverityText AS severityText,
          sum(Count) AS logCount
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName, severityText
        ORDER BY logCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditMetricLabelCardinalityQuery:default
SELECT
          AttributeKey AS attributeKey,
          uniq(AttributeValue) AS valueCardinality,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND AttributeScope = 'metric'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY valueCardinality DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditOrphanSpansSQL:default
SELECT
          c.ServiceName AS serviceName,
          count() AS childCount,
          countIf(p.SpanId = '') AS orphanCount,
          countIf((p.SpanId = '' AND match(c.TraceState, 'th:[0-9a-f]+'))) AS sampledOrphanCount,
          groupUniqArrayIf(3)(c.TraceId, p.SpanId = '') AS sampleTraceIds
        FROM (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          TraceState AS TraceState
        FROM service_map_children
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp < '2026-01-03 14:15:00'
          AND ParentSpanId != '') AS c
        LEFT JOIN (SELECT
          TraceId AS TraceId,
          SpanId AS SpanId
        FROM service_map_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 08:30:00'
          AND Timestamp < '2026-01-03 14:15:00') AS p ON (c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId)
        GROUP BY serviceName
        ORDER BY orphanCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:setup-audit:auditPeerValueInventoryQuery:default
SELECT
          AttributeKey AS attributeKey,
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND AttributeScope = 'span'
          AND AttributeKey IN ('peer.service', 'db.system', 'db.system.name', 'messaging.system', 'rpc.system')
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeValue != ''
        GROUP BY attributeKey, attributeValue
        ORDER BY usageCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditRootlessTracesSQL:default
SELECT
          t.entryService AS entryService,
          count() AS traceCount,
          countIf(r.TraceId = '') AS rootlessCount,
          countIf((r.TraceId = '' AND t.isSampled = 1)) AS sampledRootlessCount
        FROM (SELECT
          TraceId AS TraceId,
          argMin(ServiceName, Timestamp) AS entryService,
          max(match(TraceState, 'th:[0-9a-f]+')) AS isSampled
        FROM service_map_children
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp < '2026-01-03 14:15:00'
        GROUP BY TraceId) AS t
        LEFT JOIN (SELECT
          TraceId AS TraceId
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 08:30:00'
          AND Timestamp < '2026-01-03 14:15:00'
        GROUP BY TraceId) AS r ON t.TraceId = r.TraceId
        GROUP BY entryService
        ORDER BY rootlessCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:setup-audit:auditSamplingByServiceQuery:default
SELECT
          ServiceName AS serviceName,
          sum(SpanCount) AS spanCount,
          sum(EstimatedSpanCount) AS estimatedSpanCount,
          sumIf(SpanCount, CommitSha != '') AS commitTaggedSpanCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName
        ORDER BY spanCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditSpanProfileByServiceQuery:default
SELECT
          ServiceName AS serviceName,
          sum(WeightedCount) AS weightedSpanCount,
          sum(WeightedErrorCount) AS weightedErrorCount,
          sumIf(WeightedCount, SpanKind = 'Server') AS serverCount,
          sumIf(WeightedCount, SpanKind = 'Consumer') AS consumerCount,
          sumIf(WeightedCount, SpanKind = 'Client') AS clientCount,
          sumIf(WeightedCount, SpanKind = 'Producer') AS producerCount,
          sumIf(WeightedCount, DeploymentEnv = '') AS noEnvCount,
          uniq(SpanName) AS spanNameCount,
          groupUniqArrayIf(5)(StatusCode, StatusCode NOT IN ('Ok', 'Error', 'Unset', '')) AS badStatusCodes,
          groupUniqArrayIf(5)(SpanKind, SpanKind NOT IN ('Server', 'Client', 'Producer', 'Consumer', 'Internal', '')) AS badSpanKinds
        FROM traces_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName
        ORDER BY weightedSpanCount DESC
        LIMIT 25
        FORMAT JSON