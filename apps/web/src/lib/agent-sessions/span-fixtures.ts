// Span builders for the colocated tests in this directory.
//
// The real shape has fifteen required fields and a sixty-key `genAi` bag, so a
// test that spelled one out per span would be unreadable and would say nothing
// about the rule under test. Everything here defaults to "an ordinary AI span";
// each test overrides only the attribute its rule reads.

import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"
import { formatWarehouseDateTimeMs } from "@maple/query-engine"

/** Session start, fixed so offsets in the tests read as seconds into the session. */
export const T0 = Date.UTC(2026, 7, 19, 10, 0, 0)

export const at = (offsetMs: number): string => formatWarehouseDateTimeMs(T0 + offsetMs)

export interface SpanInput {
	readonly spanId: string
	readonly parentSpanId?: string
	readonly traceId?: string
	/** Milliseconds after `T0`. */
	readonly startMs: number
	readonly durationMs: number
	readonly spanName?: string
	readonly serviceName?: string
	readonly statusCode?: string
	readonly statusMessage?: string
	readonly isAiSpan?: boolean
	readonly vendorId?: string
	readonly genAi?: AiSessionGenAiValues
}

export function makeSpan(input: SpanInput): AiSessionSpan {
	const span: AiSessionSpan = {
		traceId: input.traceId ?? "trace-1",
		spanId: input.spanId,
		parentSpanId: input.parentSpanId ?? "",
		spanName: input.spanName ?? "gen_ai.chat",
		spanKind: "SPAN_KIND_CLIENT",
		serviceName: input.serviceName ?? "agent-runner",
		timestamp: at(input.startMs),
		durationMs: input.durationMs,
		statusCode: input.statusCode ?? "Unset",
		statusMessage: input.statusMessage ?? "",
		integrationId: "gen_ai",
		isAiSpan: input.isAiSpan ?? true,
		genAi: input.genAi ?? {},
	}
	// `vendorId` is an optional key on the wire shape: present or absent, never
	// present-and-undefined.
	return input.vendorId === undefined ? span : { ...span, vendorId: input.vendorId }
}

/** A model call. Tokens are the five `gen_ai.usage.*` buckets, in order. */
export function llmSpan({
	model,
	tokens,
	ttftSeconds,
	...input
}: SpanInput & {
	readonly model?: string
	readonly tokens?: readonly [number, number, number, number, number]
	readonly ttftSeconds?: number
}): AiSessionSpan {
	const base: AiSessionGenAiValues = { operationName: "chat" }
	const withModel = model === undefined ? base : { ...base, responseModel: model }
	const withTtft =
		ttftSeconds === undefined
			? withModel
			: { ...withModel, responseTimeToFirstChunk: ttftSeconds }
	const withUsage =
		tokens === undefined
			? withTtft
			: {
					...withTtft,
					usageInputTokens: tokens[0],
					usageCacheReadInputTokens: tokens[1],
					usageCacheCreationInputTokens: tokens[2],
					usageOutputTokens: tokens[3],
					usageReasoningOutputTokens: tokens[4],
				}
	return makeSpan({
		...input,
		spanName: input.spanName ?? "chat",
		genAi: { ...withUsage, ...input.genAi },
	})
}

export function toolSpan({
	toolName,
	...input
}: SpanInput & { readonly toolName?: string }): AiSessionSpan {
	return makeSpan({
		...input,
		spanName: input.spanName ?? "execute_tool",
		genAi: { operationName: "execute_tool", toolName: toolName ?? "read_file", ...input.genAi },
	})
}

export function agentSpan({
	agentName,
	...input
}: SpanInput & { readonly agentName?: string }): AiSessionSpan {
	return makeSpan({
		...input,
		spanName: input.spanName ?? "invoke_agent",
		genAi: {
			operationName: "invoke_agent",
			agentName: agentName ?? "billing-agent",
			...input.genAi,
		},
	})
}

interface OtelTextPart {
	readonly type: "text"
	readonly content: string
}

interface OtelMessage {
	readonly role: string
	readonly parts: readonly OtelTextPart[]
}

/** An OTel `gen_ai.input.messages` value carrying one user message. */
export function userMessages(text: string): readonly OtelMessage[] {
	return [
		{ role: "system", parts: [{ type: "text", content: "you are a helpful agent" }] },
		{ role: "user", parts: [{ type: "text", content: text }] },
	]
}
