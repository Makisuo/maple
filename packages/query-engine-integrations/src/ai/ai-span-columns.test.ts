import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import * as T from "@maple-dev/clickhouse-builder/types"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import {
	GENAI_AGENT_NAME_KEYS,
	GENAI_COST_KEYS,
	GENAI_MODEL_KEYS,
	GENAI_TOOL_NAME_KEYS,
	GENAI_USAGE_KEYS,
	OPENINFERENCE_KIND_OPERATIONS,
	genAiIsErrorCond,
	genAiIsLlmCallCond,
	genAiIsToolCallCond,
	genAiOperationExpr,
	genAiTokensExpr,
} from "@maple/domain/tinybird/gen-ai-columns"
import type { AiGenAiField, MutableAiGenAiValues } from "@maple/domain/gen-ai"
import { genAiIntegration, resolveAiIntegration } from "./ai-integrations"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"
import { deepestReporterSum, usageReportersExpr } from "./ai-span-columns"

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

	it("agent and tool names", () => {
		for (const key of GENAI_AGENT_NAME_KEYS) expect(decodedKeys("agentName")).toContain(key)
		for (const key of GENAI_TOOL_NAME_KEYS) expect(decodedKeys("toolName")).toContain(key)
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

	it("sums the five token buckets, each coalesced canonical-first", () => {
		const text = sql(genAiTokensExpr(attrs))
		expect(text.split(" + ")).toHaveLength(5)
		expect(text).toMatch(
			/^toFloat64OrZero\(coalesce\(nullIf\(SpanAttributes\['gen_ai\.usage\.input_tokens'\], ''\)/,
		)
		expect(text).toContain("SpanAttributes['llm.token_count.completion_details.reasoning']))")
	})

	it("flags a failure by status or by a declared failure attribute", () => {
		expect(sql(genAiIsErrorCond(columns))).toBe(
			"((StatusCode = 'Error' OR SpanAttributes['error.type'] != '') OR SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))",
		)
	})

	it("collects a trace's reporters, capped, and charges children to their parent", () => {
		const reporters = usageReportersExpr({
			SpanId: CH.dynamicColumn<string>("SpanId", T.string),
			ParentSpanId: CH.dynamicColumn<string>("ParentSpanId", T.string),
			Tokens: CH.dynamicColumn<number>("Tokens", T.float64),
			Cost: CH.dynamicColumn<number>("Cost", T.float64),
		})
		expect(sql(reporters)).toBe(
			"groupArrayIf(2000)(tuple(SpanId, ParentSpanId, Tokens, Cost), (Tokens > 0 OR Cost > 0))",
		)
		expect(sql(deepestReporterSum("usageReporters", 4))).toBe(
			"sum(arraySum(r -> greatest(0., r.4 - arraySum(c -> if(c.2 = r.1, c.4, 0.), usageReporters)), usageReporters))",
		)
	})
})
