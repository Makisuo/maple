import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import * as T from "@maple-dev/clickhouse-builder/types"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import {
	GENAI_AGENT_NAME_KEYS,
	GENAI_COST_KEYS,
	GENAI_MODEL_KEYS,
	GENAI_PROVIDER_LEGACY_VALUES,
	GENAI_PROVIDER_NAME_KEYS,
	GENAI_RESPONSE_ID_KEYS,
	GENAI_TOOL_NAME_KEYS,
	GENAI_USAGE_KEYS,
	OPENINFERENCE_KIND_OPERATIONS,
	genAiIsErrorCond,
	genAiIsLlmCallCond,
	genAiIsToolCallCond,
	genAiOperationExpr,
	genAiTokensExpr,
} from "@maple/domain/tinybird/gen-ai-columns"
import {
	GENAI_PROVIDER_USAGE_CONVENTIONS,
	type AiGenAiField,
	type MutableAiGenAiValues,
} from "@maple/domain/gen-ai"
import { LEGACY_SYSTEM_VALUES, genAiIntegration, resolveAiIntegration } from "./ai-integrations"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"
import { sessionLlmCalls, sessionUsageSum, usageReportersExpr } from "./ai-span-columns"

/** Every key any integration reads for `field` — the default's plus each vendor's. */
const decodedKeys = (field: AiGenAiField): ReadonlySet<string> =>
	new Set([
		...genAiIntegration.sources[field],
		...Object.keys(AI_VENDOR_INTEGRATIONS).flatMap(
			(vendorId) => resolveAiIntegration(vendorId).sources[field],
		),
	])

const attrs = {
	get: (key: string) => CH.mapGet(CH.dynamicColumn<Record<string, string>>("SpanAttributes"), key),
}
const columns = {
	SpanName: CH.dynamicColumn<string>("SpanName", T.string),
	StatusCode: CH.dynamicColumn<string>("StatusCode", T.string),
	SpanAttributes: attrs,
}
const sql = (expr: { toFragment(): Parameters<typeof compile>[0] }) => compile(expr.toFragment())

// The SQL lists are hand-copied from the integration layer's alias tables,
// because the index's MV cannot call into it. These pin every list to that
// layer, so a key that decodes on the detail page is one the list can filter
// on — and one the list reads that nothing decodes is a typo caught here.
describe("GenAI column key lists match the integration layer", () => {
	it("model: response and request model keys", () => {
		const decoded = new Set([...decodedKeys("responseModel"), ...decodedKeys("requestModel")])
		for (const key of GENAI_MODEL_KEYS) expect(decoded).toContain(key)
	})

	it("agent and tool names, and the response id the session dedupes on", () => {
		for (const key of GENAI_AGENT_NAME_KEYS) expect(decodedKeys("agentName")).toContain(key)
		for (const key of GENAI_TOOL_NAME_KEYS) expect(decodedKeys("toolName")).toContain(key)
		for (const key of GENAI_RESPONSE_ID_KEYS) expect(decodedKeys("responseId")).toContain(key)
		for (const key of decodedKeys("responseId")) expect(GENAI_RESPONSE_ID_KEYS).toContain(key)
	})

	it("every usage bucket and the cost, bucket for bucket", () => {
		const fields = {
			input: "usageInputTokens",
			cacheRead: "usageCacheReadInputTokens",
			cacheWrite: "usageCacheCreationInputTokens",
			output: "usageOutputTokens",
			reasoning: "usageReasoningOutputTokens",
		} as const
		for (const [bucket, field] of Object.entries(fields)) {
			const decoded = decodedKeys(field)
			for (const key of GENAI_USAGE_KEYS[bucket as keyof typeof GENAI_USAGE_KEYS]) {
				expect(decoded, `${bucket}: ${key}`).toContain(key)
			}
			// And the other way: the list reads every key the detail page decodes,
			// so a session's tokens cannot be counted on one page and not the other.
			for (const key of decoded) {
				expect(
					GENAI_USAGE_KEYS[bucket as keyof typeof GENAI_USAGE_KEYS],
					`${bucket}: ${key}`,
				).toContain(key)
			}
		}
		for (const key of GENAI_COST_KEYS) expect(decodedKeys("usageCost")).toContain(key)
		for (const key of decodedKeys("usageCost")) expect(GENAI_COST_KEYS).toContain(key)
	})

	it("the provider that decides the usage convention, and its legacy spellings", () => {
		for (const key of GENAI_PROVIDER_NAME_KEYS) expect(decodedKeys("providerName")).toContain(key)
		for (const key of decodedKeys("providerName")) expect(GENAI_PROVIDER_NAME_KEYS).toContain(key)
		// The view matches the pre-rename `gen_ai.system` values the read side
		// canonicalises, for every provider the convention table names.
		for (const [canonical, legacy] of GENAI_PROVIDER_LEGACY_VALUES) {
			expect(LEGACY_SYSTEM_VALUES.get(legacy)).toBe(canonical)
		}
		for (const [legacy, canonical] of LEGACY_SYSTEM_VALUES) {
			if (!GENAI_PROVIDER_USAGE_CONVENTIONS.has(canonical)) continue
			expect(GENAI_PROVIDER_LEGACY_VALUES.map(([, value]) => value)).toContain(legacy)
		}
	})

	it("translates the OpenInference span kinds the integration refines", () => {
		const integration = resolveAiIntegration("openinference-openai")
		for (const [kind, operation] of OPENINFERENCE_KIND_OPERATIONS) {
			const values: MutableAiGenAiValues = {}
			integration.refine?.(values, {
				attributes: { "openinference.span.kind": kind },
				row: {} as never,
			})
			expect(values.operationName, kind).toBe(operation)
		}
	})
})

describe("span classification SQL", () => {
	it("reads the operation from gen_ai.operation.name, else the OpenInference kind", () => {
		expect(sql(genAiOperationExpr(attrs))).toBe(
			"coalesce(nullIf(SpanAttributes['gen_ai.operation.name'], ''), multiIf(SpanAttributes['openinference.span.kind'] = 'LLM', 'chat', SpanAttributes['openinference.span.kind'] = 'TOOL', 'execute_tool', SpanAttributes['openinference.span.kind'] = 'AGENT', 'invoke_agent', SpanAttributes['openinference.span.kind'] = 'EMBEDDING', 'embeddings', SpanAttributes['openinference.span.kind'] = 'RETRIEVER', 'retrieval', ''))",
		)
	})

	it("counts a model turn by operation, or by name only for an unclassified agent span", () => {
		const text = sql(genAiIsLlmCallCond(columns))
		expect(text).toContain("IN ('chat', 'generate_content', 'text_completion', 'fetch_response')")
		// The name rules apply only where the operation is absent or unknown to
		// the convention, only to vendor-stamped spans, and only after the tool
		// and agent rules have declined — the client's order.
		expect(text).toContain(
			"NOT IN ('chat', 'generate_content', 'text_completion', 'fetch_response', 'embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step')",
		)
		expect(text).toContain("NOT ((coalesce(nullIf(SpanAttributes['gen_ai.tool.name'], '')")
		expect(text).toContain("lower(SpanName) LIKE '%tool%'")
		expect(text).toContain("NOT ((lower(SpanName) LIKE '%agent%' OR lower(SpanName) LIKE '%workflow%'))")
		expect(text).toContain("lower(SpanName) LIKE '%chat%' OR lower(SpanName) LIKE '%completion%'")
	})

	it("counts a tool call by operation, or by a tool name / tool-ish span name", () => {
		const text = sql(genAiIsToolCallCond(columns))
		expect(text).toContain("IN ('execute_tool')")
		expect(text).toContain("SpanAttributes['tool.name']) != '' OR lower(SpanName) LIKE '%tool%'")
	})

	it("sums the token buckets under the reporter's convention, each coalesced canonical-first", () => {
		const text = sql(genAiTokensExpr(attrs))
		// The prompt half: the cache buckets nest in the prompt figure for the
		// re-summing vendors and the OpenAI-shaped providers, and sit beside it
		// for Anthropic; the default nests.
		expect(text).toContain("multiIf(SpanAttributes['maple_ai.vendor.id'] IN ('vercel_ai_sdk', 'maple'), greatest(")
		expect(text).toContain(
			"IN ('openai', 'gcp.gemini', 'gemini', 'gcp.vertex_ai', 'vertex_ai', 'openrouter'), greatest(",
		)
		expect(text).toContain("IN ('anthropic'), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens']")
		// The completion half: reasoning nests for Anthropic and the OpenAI-shaped
		// providers, and sits beside the completion for Gemini.
		expect(text).toContain("IN ('anthropic', 'openai', 'openrouter'), greatest(")
		expect(text).toContain(
			"IN ('gcp.gemini', 'gemini', 'gcp.vertex_ai', 'vertex_ai'), toFloat64OrZero(coalesce(nullIf(SpanAttributes['gen_ai.usage.output_tokens']",
		)
		// Every bucket is read canonical-first, down to the OpenInference spelling.
		expect(text).toContain("coalesce(nullIf(SpanAttributes['gen_ai.usage.input_tokens'], '')")
		expect(text).toContain("SpanAttributes['llm.token_count.completion_details.reasoning']))")
	})

	it("flags a failure by status or by a declared failure attribute", () => {
		expect(sql(genAiIsErrorCond(columns))).toBe(
			"((StatusCode = 'Error' OR SpanAttributes['error.type'] != '') OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))",
		)
	})

	it("collects a trace's reporters and model calls, capped", () => {
		const reporters = usageReportersExpr({
			SpanId: CH.dynamicColumn<string>("SpanId", T.string),
			ParentSpanId: CH.dynamicColumn<string>("ParentSpanId", T.string),
			Tokens: CH.dynamicColumn<number>("Tokens", T.float64),
			Cost: CH.dynamicColumn<number>("Cost", T.float64),
			ResponseId: CH.dynamicColumn<string>("ResponseId", T.string),
			IsLlmCall: CH.dynamicColumn<number>("IsLlmCall", T.uint8),
		})
		expect(sql(reporters)).toBe(
			"groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost, ResponseId, IsLlmCall), ((Tokens > 0 OR Cost > 0) OR IsLlmCall = 1))",
		)
	})

	it("sums usage at the session level: children off their parent, one claim per response id", () => {
		const all = "arrayFlatten(groupArray(usageReporters))"
		const claims = `arrayMap(r -> tuple(r.5, greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), ${all}))), ${all})`
		expect(sql(sessionUsageSum("usageReporters", 4))).toBe(
			`arraySum(n -> if(n.1 = '', n.2, 0.), ${claims}) + arraySum(id -> arrayMax(n -> if(n.1 = id, n.2, 0.), ${claims}), arrayDistinct(arrayFilter(id -> id != '', arrayMap(n -> n.1, ${claims}))))`,
		)
	})

	it("counts a model call at its deepest account, once per response id", () => {
		const text = sql(sessionLlmCalls("usageReporters"))
		// A reporting call counts by its netted claim; a non-reporting one by
		// having no reporting parent.
		expect(text).toContain(
			"if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - arraySum(c -> if(c.2 = r.1, c.3, 0.), arrayFlatten(groupArray(usageReporters)))) > 0 OR greatest(0., r.4 -",
		)
		expect(text).toContain("NOT arrayExists(p -> p.1 = r.2 AND (p.3 > 0 OR p.4 > 0), arrayFlatten(groupArray(usageReporters))))")
		expect(text).toMatch(/^toFloat64\(arraySum\(n -> if\(n\.2 AND n\.1 = '', 1, 0\), /)
		expect(text).toContain("length(arrayDistinct(arrayFilter(id -> id != '', arrayMap(n -> if(n.2, n.1, ''),")
	})
})
