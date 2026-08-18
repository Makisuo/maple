import { Effect } from "effect"
import { normalizeAiSpan, type AiSpanFacts } from "@maple/domain/ai"
import * as CH from "../ch"
import {
	formatWarehouseDateTime,
	formatWarehouseDateTimeMs,
	parseWarehouseDateTime,
} from "../datetime"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type {
	AgentSessionsFacetsOutput,
	AgentSessionsListOutput,
	AgentTracesListOutput,
} from "../ch/queries/agent-sessions"

/**
 * The shared filter payload for the Agent Sessions feature — one shape feeds
 * the sessions list, the raw AI-traces list, and both tabs' facets, so the
 * sidebar counts can never mean something different from the rows.
 *
 * `vendors`/`serviceNames` are containment filters: "has at least one matching
 * AI span". Classification is per-span and multi-vendor traces are the norm
 * (a CrewAI orchestration span parenting openinference-instrumented OpenAI
 * calls), so exact-match semantics would be a lie.
 */
export interface AgentSessionsFilterInput {
	readonly startTime: string
	readonly endTime: string
	/** Vendor slugs from `@maple/domain` `AI_VENDORS`, including `unknown:*`. */
	readonly vendors?: readonly string[]
	readonly serviceNames?: readonly string[]
	readonly hasErrors?: boolean
}

export interface ListAgentSessionsInput extends AgentSessionsFilterInput {
	readonly limit?: number
	readonly offset?: number
}

/**
 * List AI agent sessions: spans whose classified session key resolved at
 * session granularity, grouped by key hash and ordered by latest activity.
 * Counts cover only the key-carrying spans — resolving a session's full traces
 * and display key is the detail read's job.
 */
export const listAgentSessions = Effect.fn("Observability.listAgentSessions")(function* (
	input: ListAgentSessionsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.agentSessionsListQuery({
			vendors: input.vendors,
			serviceNames: input.serviceNames,
			hasErrors: input.hasErrors,
			limit: input.limit,
			offset: input.offset,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, { profile: "list", context: "listAgentSessions" })
})

export interface ListAgentTracesInput extends AgentSessionsFilterInput {
	readonly limit?: number
	readonly offset?: number
}

/**
 * List raw AI traces: every AI-classified span at any session-key state,
 * grouped by trace. This is the companion tab to `listAgentSessions` — spans
 * that never resolved a session key (`bestSessionKeyState < 6`) only surface
 * here, with the state explaining why.
 */
export const listAgentTraces = Effect.fn("Observability.listAgentTraces")(function* (
	input: ListAgentTracesInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.agentTracesListQuery({
			vendors: input.vendors,
			serviceNames: input.serviceNames,
			hasErrors: input.hasErrors,
			limit: input.limit,
			offset: input.offset,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, { profile: "list", context: "listAgentTraces" })
})

export interface AgentSessionsFacetsInput extends AgentSessionsFilterInput {
	/** Counting unit: distinct sessions or distinct traces — match the open tab. */
	readonly tab: "sessions" | "traces"
}

/**
 * Facet counts (vendor / service / has-errors) for the quickfilter sidebar,
 * counted per session or per trace to match the open tab. Each dimension's own
 * selection is excluded from its branch so it doesn't collapse to one option.
 */
export const agentSessionsFacets = Effect.fn("Observability.agentSessionsFacets")(function* (
	input: AgentSessionsFacetsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compileUnion(
		CH.agentSessionsFacetsQuery({
			tab: input.tab,
			vendors: input.vendors,
			serviceNames: input.serviceNames,
			hasErrors: input.hasErrors,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, {
		profile: "list",
		context: "agentSessionsFacets",
	})
})

// Session detail

export interface AgentSessionDetailInput {
	/** Opaque session id from the list read: `toString(AiSessionKeyHash)`. */
	readonly sessionKeyHash: string
	readonly startTime: string
	readonly endTime: string
}

/** An AI span with the vendor-integration facts merged in — raw span identity
 *  and timing plus what `@maple/domain/ai` could normalize out of its
 *  attributes. The attribute maps themselves stay behind this boundary; only
 *  the extracted conversational text crosses it, truncated. */
export interface NormalizedAiSpan extends AiSpanFacts {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly startTime: string
	readonly durationMs: number
	readonly spanName: string
	readonly spanKind: string
	readonly serviceName: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly vendor: string
	readonly sessionKeyState: number
}

export interface AgentSessionTrace {
	readonly traceId: string
	readonly startTime: string
	readonly durationMs: number
	readonly errorCount: number
	readonly spans: ReadonlyArray<NormalizedAiSpan>
}

export interface AgentSessionDetailOutput {
	readonly sessionKeyHash: string
	/** The plaintext session key, resolved from span attributes by the vendor
	 *  integration of a key-carrying span. `null` when no integration knows the
	 *  vendor's spelling — the UI falls back to the hash. */
	readonly sessionKey: string | null
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
	/** True when the session blew a fetch cap (`AGENT_SESSION_MAX_TRACES` /
	 *  `AGENT_SESSION_MAX_SPANS`) and the numbers below undercount. */
	readonly truncated: boolean
	readonly totals: {
		readonly spanCount: number
		readonly llmCallCount: number
		readonly toolCallCount: number
		readonly errorCount: number
		readonly inputTokens: number
		readonly outputTokens: number
		readonly cacheReadTokens: number
		readonly cacheCreationTokens: number
		/** `null` when no span priced itself — "unknown", never "free". */
		readonly costUsd: number | null
	}
	readonly vendors: ReadonlyArray<string>
	readonly serviceNames: ReadonlyArray<string>
	readonly models: ReadonlyArray<string>
	readonly traces: ReadonlyArray<AgentSessionTrace>
}

/** Ceiling for each span's extracted conversational text on this interface —
 *  a single agent prompt can be hundreds of KB and a session holds up to 2000
 *  spans, so uncapped content makes the payload unusable long before the UI
 *  could render it. */
const MAX_CONTENT_CHARS = 10_000

const truncateContent = (text: string | null): string | null =>
	text !== null && text.length > MAX_CONTENT_CHARS
		? `${text.slice(0, MAX_CONTENT_CHARS)}… [truncated]`
		: text

/** Phase-2 pad around the keyed spans' window. The key-carrying spans bound
 *  the session's *anchors*, not its traces: sibling AI spans (the token-bearing
 *  LLM children) start before and end after them. An hour each side is far
 *  beyond any sane trace's skew and still prunes partitions. */
const SPAN_WINDOW_PAD_MS = 60 * 60 * 1000

/**
 * The session detail read, and the one durable interface over it — the
 * internal HTTP route adapts this function and the future MCP tool calls it
 * too. Two phases: the key hash resolves to the session's TraceIds (only
 * `AiSessionKeyState = 6` rows carry the hash), then every AI span of those
 * traces is fetched and run through the per-span vendor integration layer.
 * Totals sum over ALL normalized spans regardless of vendor: in the mixed
 * CrewAI shape the tokens live on child openinference-openai spans, not on the
 * session-keyed ones.
 *
 * Returns `null` when the hash matches nothing in the window.
 */
export const getAgentSessionDetail = Effect.fn("Observability.getAgentSessionDetail")(function* (
	input: AgentSessionDetailInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)

	const traceRows = yield* executor.compiledQuery(
		CH.compile(CH.agentSessionTraceIdsQuery(), {
			orgId: executor.orgId,
			startTime: input.startTime,
			endTime: input.endTime,
			sessionKeyHash: input.sessionKeyHash,
		}),
		{ profile: "list", context: "agentSessionTraceIds" },
	)
	if (traceRows.length === 0) return null

	const keyedStartMs = Math.min(...traceRows.map((row) => parseWarehouseDateTime(row.startTime)))
	const keyedEndMs = Math.max(...traceRows.map((row) => parseWarehouseDateTime(row.endTime)))
	const spanRows = yield* executor.compiledQuery(
		CH.compile(CH.agentSessionSpansQuery({ traceIds: traceRows.map((row) => row.traceId) }), {
			orgId: executor.orgId,
			startTime: formatWarehouseDateTime(keyedStartMs - SPAN_WINDOW_PAD_MS),
			endTime: formatWarehouseDateTime(keyedEndMs + SPAN_WINDOW_PAD_MS),
		}),
		{ profile: "list", context: "agentSessionSpans" },
	)

	const spans: NormalizedAiSpan[] = spanRows.map((row) => {
		const facts = normalizeAiSpan({
			vendor: row.vendor,
			spanName: row.spanName,
			attributes: row.spanAttributes,
		})
		return {
			traceId: row.traceId,
			spanId: row.spanId,
			parentSpanId: row.parentSpanId,
			startTime: row.timestamp,
			durationMs: Number(row.durationMs),
			spanName: row.spanName,
			spanKind: row.spanKind,
			serviceName: row.serviceName,
			statusCode: row.statusCode,
			statusMessage: row.statusMessage,
			vendor: row.vendor,
			sessionKeyState: Number(row.sessionKeyState),
			...facts,
			inputText: truncateContent(facts.inputText),
			outputText: truncateContent(facts.outputText),
		}
	})

	const totals = {
		spanCount: spans.length,
		llmCallCount: 0,
		toolCallCount: 0,
		errorCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: null as number | null,
	}
	let sessionKey: string | null = null
	let startMs = Number.POSITIVE_INFINITY
	let endMs = Number.NEGATIVE_INFINITY
	for (const span of spans) {
		if (span.role === "tool") totals.toolCallCount += 1
		if (span.statusCode === "Error") totals.errorCount += 1
		// Token/cost totals sum the llm tier ONLY: agent-tier wrappers repeat
		// their children's aggregated usage in both AI SDK dialects
		// (`invoke_agent` mirrors its `chat`, `ai.generateText` its
		// `.doGenerate`s), so summing every token-carrying span double-counts.
		// The integrations keep those spans out of the llm role for exactly this
		// reason. `llmCallCount` counts the calls that reported usage — a
		// framework's extra llm-tier wrapper spans (mastra's `model_step`) carry
		// none and would inflate a plain role count.
		if (span.role === "llm") {
			totals.inputTokens += span.inputTokens ?? 0
			totals.outputTokens += span.outputTokens ?? 0
			totals.cacheReadTokens += span.cacheReadTokens ?? 0
			totals.cacheCreationTokens += span.cacheCreationTokens ?? 0
			if (span.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + span.costUsd
			if (span.inputTokens !== null || span.outputTokens !== null) totals.llmCallCount += 1
		}
		// The display key must be the value the stamped hash was computed FROM, so
		// only a session-granularity span's extraction qualifies — any other
		// span's sessionKey fact may be a different (sub-session) identifier.
		if (sessionKey === null && span.sessionKey !== null && span.sessionKeyState === 6) {
			sessionKey = span.sessionKey
		}
		const spanStart = parseWarehouseDateTime(span.startTime)
		if (spanStart < startMs) startMs = spanStart
		if (spanStart + span.durationMs > endMs) endMs = spanStart + span.durationMs
	}

	const byTrace = new Map<string, NormalizedAiSpan[]>()
	for (const span of spans) {
		const bucket = byTrace.get(span.traceId)
		if (bucket === undefined) byTrace.set(span.traceId, [span])
		else bucket.push(span)
	}
	const traces: AgentSessionTrace[] = [...byTrace.entries()].map(([traceId, traceSpans]) => {
		const start = parseWarehouseDateTime(traceSpans[0]!.startTime)
		const end = Math.max(
			...traceSpans.map((span) => parseWarehouseDateTime(span.startTime) + span.durationMs),
		)
		return {
			traceId,
			startTime: traceSpans[0]!.startTime,
			durationMs: end - start,
			errorCount: traceSpans.filter((span) => span.statusCode === "Error").length,
			spans: traceSpans,
		}
	})

	const distinct = (values: ReadonlyArray<string | null>) =>
		[...new Set(values.filter((value): value is string => value !== null && value !== ""))].sort()

	return {
		sessionKeyHash: input.sessionKeyHash,
		sessionKey,
		startTime: formatWarehouseDateTimeMs(startMs),
		endTime: formatWarehouseDateTimeMs(endMs),
		durationMs: endMs - startMs,
		truncated:
			traceRows.length >= CH.AGENT_SESSION_MAX_TRACES ||
			spans.length >= CH.AGENT_SESSION_MAX_SPANS,
		totals,
		vendors: distinct(spans.map((span) => span.vendor)),
		serviceNames: distinct(spans.map((span) => span.serviceName)),
		models: distinct(spans.map((span) => span.model)),
		traces,
	} satisfies AgentSessionDetailOutput
})
