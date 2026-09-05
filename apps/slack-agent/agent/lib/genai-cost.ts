import type { Attributes, Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"

/**
 * Lifts the OpenRouter cost accounting into `gen_ai.usage.cost`.
 *
 * The chain that makes this necessary: OpenRouter reports the charged amount in
 * the response (`usage.cost`, enabled per-request via `usage.include` in
 * `agent.ts`), the AI SDK provider surfaces it as
 * `providerMetadata.openrouter.usage`, and eve's OTel integration serializes
 * that object onto the model-call spans as `ai.response.providerMetadata`
 * (enabled by the `providerMetadata` supplemental in
 * `patches/eve@0.25.3.patch`). No emitter in that chain writes the
 * OpenLLMetry-convention `gen_ai.usage.cost` key Maple decodes, and eve's
 * instrumentation events offer no post-response hook to add it — so the lift
 * happens here, in a span processor, just before export.
 *
 * The canonical key (rather than a read-side integration alias in
 * `@maple/query-engine-integrations`) is deliberate: a flat numeric attribute
 * is directly aggregatable in warehouse SQL, where a value buried in
 * providerMetadata JSON is not. Maple's session views count cost per
 * deepest-reporting span, so the same value appearing on the step and root
 * spans does not double-count.
 */

/** Stringified provider metadata, stamped by eve's OTel integration. */
export const PROVIDER_METADATA_ATTR = "ai.response.providerMetadata"

/** The cost key Maple's GenAI catalog decodes (`usageCost` in gen-ai.ts). */
export const GENAI_USAGE_COST_ATTR = "gen_ai.usage.cost"

/**
 * Total cost in USD from an `ai.response.providerMetadata` JSON payload, or
 * undefined when the payload carries no cost (accounting disabled, another
 * provider, or malformed JSON — all left unstamped rather than guessed).
 *
 * `usage.cost` is what OpenRouter charged; with BYOK keys it is only
 * OpenRouter's fee and the upstream charge arrives separately as
 * `usage.costDetails.upstreamInferenceCost`, so the two are summed. A zero
 * cost (free-tier model) is real accounting and is returned, not dropped.
 */
export function extractOpenRouterCost(providerMetadataJson: string): number | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(providerMetadataJson)
	} catch {
		return undefined
	}
	const usage = readObjectPath(parsed, "openrouter", "usage")
	if (usage === undefined) return undefined
	const cost = readFiniteNumber(usage["cost"])
	if (cost === undefined) return undefined
	const upstream = readFiniteNumber(readObjectPath(usage, "costDetails")?.["upstreamInferenceCost"])
	return cost + (upstream ?? 0)
}

function readObjectPath(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
	let current = value
	for (const key of path) {
		if (current === null || typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[key]
	}
	return current !== null && typeof current === "object" ? (current as Record<string, unknown>) : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Stamps {@link GENAI_USAGE_COST_ATTR} into an attribute record whose
 * provider metadata carries cost accounting; leaves every other record
 * untouched.
 */
export function stampGenAiCost(attributes: Attributes): void {
	const raw = attributes[PROVIDER_METADATA_ATTR]
	if (typeof raw !== "string") return
	const cost = extractOpenRouterCost(raw)
	if (cost === undefined) return
	attributes[GENAI_USAGE_COST_ATTR] = cost
}

/**
 * Span processor applying {@link stampGenAiCost} to every ended span.
 * Registered ahead of the batch processor in `instrumentation.ts`; mutating
 * `span.attributes` in `onEnd` is visible to the exporter because the batch
 * processor serializes the same span object later.
 */
export class GenAiCostSpanProcessor implements SpanProcessor {
	onStart(_span: Span, _parentContext: Context): void {}

	onEnd(span: ReadableSpan): void {
		stampGenAiCost(span.attributes)
	}

	forceFlush(): Promise<void> {
		return Promise.resolve()
	}

	shutdown(): Promise<void> {
		return Promise.resolve()
	}
}
