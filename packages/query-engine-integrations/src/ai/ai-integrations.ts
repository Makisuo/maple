// BOUNDARY: this module decodes raw warehouse attribute strings; a parsed
// value stays unknown until the catalog's field type names it.

// AI span mapping: the default GenAI integration, the vendor lookup, and the
// mapper that turns one warehouse row into an `AiAgentSpan`.
//
// An integration is a table of `field -> source attribute keys` plus an
// optional `refine` hook: same meaning under a different key, and same key with
// a different value. Vendor entries are keyed on the `maple_ai.vendor.id` the
// ingest gateway stamped at decode time, from evidence the read path no longer
// has (instrumentation scope, resource SDK name, span events — see
// `apps/ingest/src/ai_session.rs`). Attributes arrive as `Map(String, String)`,
// so a missing key reads back as `''` and an undecodable value yields no field.

import { Effect, Option } from "effect"

import {
	AI_CORE_FIELDS,
	AI_GENAI_FIELDS,
	AI_PROMPT_VARIABLE_PREFIX,
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
	type AiAgentSpan,
	type AiFieldDef,
	type AiGenAiField,
	type MutableAiGenAiValues,
} from "@maple/domain/gen-ai"
import type { AiSessionSpansOutput } from "./ai-sessions"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"

export interface AiRefineContext {
	readonly row: AiSessionSpansOutput
	/** The span's own attributes — the map the source key lists read. */
	readonly attributes: Record<string, string>
}

/** Field → source attribute keys, tried in order; the first value that decodes wins. */
type AiSources = Partial<Record<AiGenAiField, readonly string[]>>

export interface AiIntegration {
	readonly id: string
	/**
	 * The vendor's own dialect keys. They are appended to the default's list for
	 * that field, so an entry lists only what the default does not already read.
	 */
	readonly sources?: AiSources
	/**
	 * For what a key list cannot express: normalising a value, or deriving a
	 * field from something other than a single attribute.
	 */
	readonly refine?: (values: MutableAiGenAiValues, ctx: AiRefineContext) => void
}

/** An integration carrying a source list for every catalog field. */
interface ResolvedAiIntegration extends AiIntegration {
	readonly sources: Record<AiGenAiField, readonly string[]>
}

/**
 * ClickHouse returns `''` for a missing Map key, so empty means absent — and so
 * does whitespace, which emitters send for a value they never filled in.
 */
const readAttribute = (attributes: Record<string, string>, key: string): string | undefined => {
	const value: string | undefined = attributes[key]
	return value === undefined || value.trim() === "" ? undefined : value
}

const parseJson = (raw: string): unknown =>
	Option.getOrUndefined(Effect.runSync(Effect.option(Effect.try((): unknown => JSON.parse(raw)))))

const decodeStringArray = (raw: string): readonly string[] | undefined => {
	// Real data carries both shapes for the same attribute: `'["stop"]'` from
	// instrumentation that serialises the array, and a bare `"stop"` from
	// instrumentation that emits the single value.
	const parsed = parseJson(raw)
	// Unparseable is the bare form: `stop` and `"stop"`-without-quotes both land
	// here, and that is the only case where the raw text IS the value.
	if (parsed === undefined) return [raw]
	if (typeof parsed === "string") return [parsed]
	if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed
	// Parsed cleanly but into some other shape — an object, a number, an array of
	// non-strings. Wrapping the raw JSON text into a one-element array would
	// silently consume the field with a value that never existed, so decode to
	// nothing and let the next alias have its turn.
	return undefined
}

const decodeAttribute = (type: AiFieldDef["type"], raw: string): unknown => {
	switch (type) {
		case "string":
			return raw
		case "number": {
			const value = Number(raw)
			// `Number("abc")` is NaN and `Number("Infinity")` is Infinity; both
			// would poison arithmetic and neither is a token count.
			return Number.isFinite(value) ? value : undefined
		}
		case "boolean": {
			const value = raw.toLowerCase()
			if (value === "true" || value === "1") return true
			if (value === "false" || value === "0") return false
			return undefined
		}
		case "stringArray":
			return decodeStringArray(raw)
		case "json": {
			// Objects and arrays only: `"null"`, `"0"` and `"false"` parse cleanly
			// into values that would reach the UI where a message list belongs.
			const parsed = parseJson(raw)
			return parsed !== null && typeof parsed === "object" ? parsed : undefined
		}
		default: {
			// A field type added to the catalog without a case here would otherwise
			// compile clean and make every field of that type silently absent from
			// every span. `tsconfig` has no `noImplicitReturns`, so the
			// never-assignment is what enforces it.
			const unhandled: never = type
			return unhandled
		}
	}
}

/**
 * Deprecated and obsoleted keys the default integration still reads, per field.
 *
 * `gen_ai.prompt` / `gen_ai.completion` were obsoleted with "no replacement"
 * rather than renamed, so mapping them onto the message fields is a pragmatic
 * choice, not a spec-blessed rename: in practice they carried exactly that
 * content, and OpenRouter instrumentation in production still emits them.
 *
 * `gen_ai.usage.output_tokens.reasoning`, `gen_ai.usage.input_tokens.cached`
 * and `gen_ai.usage.total_cost` are likewise absent from the deprecation table —
 * they are the spelling OpenRouter emits in production for what the convention
 * calls `gen_ai.usage.reasoning.output_tokens`,
 * `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cost` (total_cost is
 * USD, the sum of the input_cost/output_cost keys beside it). All three were
 * confirmed against the warehouse; the plausible-looking
 * `gen_ai.usage.reasoning_tokens` was NOT, so it is deliberately not listed.
 */
const GENAI_LEGACY_ALIASES = {
	usageInputTokens: ["gen_ai.usage.prompt_tokens"],
	usageOutputTokens: ["gen_ai.usage.completion_tokens"],
	usageReasoningOutputTokens: ["gen_ai.usage.output_tokens.reasoning"],
	usageCacheReadInputTokens: ["gen_ai.usage.input_tokens.cached"],
	// Not legacy but the *registry* spelling: semconv names the bucket
	// `cache_write` while the catalog's primary key keeps the `cache_creation`
	// spelling Anthropic-era emitters (and Maple's own rows before this alias)
	// used. Both must decode; Maple's agents emit the semconv form.
	usageCacheCreationInputTokens: ["gen_ai.usage.cache_write.input_tokens"],
	usageCost: ["gen_ai.usage.total_cost"],
	inputMessages: ["gen_ai.prompt"],
	outputMessages: ["gen_ai.completion"],
	providerName: ["gen_ai.system"],
	requestSeed: ["gen_ai.openai.request.seed"],
	responseFinishReasons: ["gen_ai.response.finish_reason"],
} satisfies AiSources

// SAFETY: `Object.entries` erases the key/value correlation, so the accumulator
// is asserted; the first loop writes an entry for every catalog field.
const genAiSources = {} as Record<AiGenAiField, readonly string[]>
for (const [field, def] of Object.entries(AI_GENAI_FIELDS)) {
	genAiSources[field as AiGenAiField] = [def.key]
}
for (const [field, aliases] of Object.entries(GENAI_LEGACY_ALIASES)) {
	genAiSources[field as AiGenAiField] = [...genAiSources[field as AiGenAiField], ...aliases]
}

/**
 * `gen_ai.system` enum values that were renamed when the attribute became
 * `gen_ai.provider.name`. Values not listed here (`openai`, `anthropic`, …)
 * survived the rename unchanged.
 */
const LEGACY_SYSTEM_VALUES = new Map([
	["vertex_ai", "gcp.vertex_ai"],
	["gemini", "gcp.gemini"],
	["az.ai.inference", "azure.ai.inference"],
	["az.ai.openai", "azure.ai.openai"],
	["xai", "x_ai"],
])

const genAiRefine = (values: MutableAiGenAiValues, ctx: AiRefineContext): void => {
	// Gated on the canonical key being absent: a span that emits
	// `gen_ai.provider.name` is already speaking the new vocabulary, and its
	// values pass through even when they collide with an old enum member.
	if (
		values.providerName !== undefined &&
		readAttribute(ctx.attributes, AI_GENAI_FIELDS.providerName.key) === undefined
	) {
		const canonical = LEGACY_SYSTEM_VALUES.get(values.providerName)
		if (canonical !== undefined) values.providerName = canonical
	}

	// The finish reason was singularised in place, so this is a value fix rather
	// than a key alias and applies whichever key it arrived on.
	if (values.responseFinishReasons !== undefined) {
		values.responseFinishReasons = values.responseFinishReasons.map((reason) =>
			reason === "tool_calls" ? "tool_call" : reason,
		)
	}
}

/**
 * The default integration: canonical GenAI keys plus their legacy aliases. It
 * is what an unrecognised vendor — and the `unknown:*` buckets the gateway
 * stamps — falls back to, and it is the base every vendor override extends.
 */
export const genAiIntegration: ResolvedAiIntegration = {
	id: "gen_ai",
	sources: genAiSources,
	refine: genAiRefine,
}

/**
 * The default's keys for every field with the vendor's dialect keys appended,
 * deduplicated. The canonical and legacy `gen_ai.*` spellings keep priority, so
 * recognising a vendor can only add keys, never remove one.
 */
const mergeSources = (vendor: AiSources = {}): Record<AiGenAiField, readonly string[]> => {
	const merged = {} as Record<AiGenAiField, readonly string[]>
	for (const [field, keys] of Object.entries(genAiSources)) {
		merged[field as AiGenAiField] = [...new Set([...keys, ...(vendor[field as AiGenAiField] ?? [])])]
	}
	return merged
}

const resolvedIntegrations = new Map<string, ResolvedAiIntegration>(
	Object.entries(AI_VENDOR_INTEGRATIONS).map(([vendorId, vendor]): [string, ResolvedAiIntegration] => [
		vendorId,
		{
			id: vendor.id,
			sources: mergeSources(vendor.sources),
			// Both hooks run, default first, so the vendor can correct its work.
			refine: (values, ctx) => {
				genAiRefine(values, ctx)
				vendor.refine?.(values, ctx)
			},
		},
	]),
)

/** The integration for a vendor stamp, or the default for a stamp with no entry. */
export const resolveAiIntegration = (vendorId: string | undefined): ResolvedAiIntegration => {
	const resolved = vendorId === undefined ? undefined : resolvedIntegrations.get(vendorId)
	return resolved ?? genAiIntegration
}

const collectPromptVariables = (attributes: Record<string, string>): Record<string, string> | undefined => {
	// A templated attribute has no fixed key, so it is collected by prefix here
	// rather than through the key-list mechanism every other field uses.
	let collected: Record<string, string> | undefined
	for (const [key, value] of Object.entries(attributes)) {
		if (!key.startsWith(AI_PROMPT_VARIABLE_PREFIX) || value === "") continue
		// Null-prototype: a `gen_ai.prompt.variable.__proto__` key would hit the
		// prototype setter on a `{}` literal and be dropped without a trace.
		collected ??= Object.create(null) as Record<string, string>
		collected[key.slice(AI_PROMPT_VARIABLE_PREFIX.length)] = value
	}
	return collected
}

/**
 * A core field is plain OTel semconv that every HTTP client span carries, so
 * mapping one is not evidence that this span is an AI span.
 */
const hasAiSignal = (values: MutableAiGenAiValues): boolean =>
	Object.keys(values).some((field) => !AI_CORE_FIELDS.has(field as AiGenAiField))

export const mapAiSpan = (row: AiSessionSpansOutput): AiAgentSpan => {
	// Span attributes only, envelope and source keys alike. The gateway strips
	// `maple_ai.*` from span attributes before stamping its own verdict, so a
	// span-level value is authoritative — and it does not touch resource
	// attributes, where one forged `gen_ai.*` or `maple_ai.*` key would mark
	// every span in the service as an AI span.
	const attributes = row.spanAttributes
	const vendorId = readAttribute(attributes, MAPLE_AI_VENDOR_ID_ATTR)
	const integration = resolveAiIntegration(vendorId)

	// SAFETY: the catalog correlates each field with its value type, but a loop
	// over the field union cannot carry that correlation. `decodeAttribute` is
	// driven by the same catalog entry as the field it is written under, so the
	// value matches the field by construction.
	const genAi = {} as MutableAiGenAiValues & Record<string, unknown>
	for (const [field, keys] of Object.entries(integration.sources)) {
		const def = AI_GENAI_FIELDS[field as AiGenAiField]
		for (const key of keys) {
			const raw = readAttribute(attributes, key)
			if (raw === undefined) continue
			const value = decodeAttribute(def.type, raw)
			// A key that carries an undecodable value does not consume the
			// field: the next alias still gets its turn.
			if (value === undefined) continue
			genAi[field] = value
			break
		}
	}
	integration.refine?.(genAi, { row, attributes })

	const promptVariables = collectPromptVariables(attributes)
	const sessionId = readAttribute(attributes, MAPLE_AI_SESSION_ID_ATTR)
	const vendorVersion = readAttribute(attributes, MAPLE_AI_VENDOR_VERSION_ATTR)

	return {
		traceId: row.traceId,
		spanId: row.spanId,
		parentSpanId: row.parentSpanId,
		spanName: row.spanName,
		spanKind: row.spanKind,
		serviceName: row.serviceName,
		timestamp: row.timestamp,
		durationMs: row.durationMs,
		statusCode: row.statusCode,
		statusMessage: row.statusMessage,
		// Spread rather than assigned, so an absent stamp leaves the key off the
		// span entirely rather than present-and-undefined.
		...(sessionId !== undefined && { sessionId }),
		...(vendorId !== undefined && { vendorId }),
		...(vendorVersion !== undefined && { vendorVersion }),
		isAiSpan: vendorId !== undefined || promptVariables !== undefined || hasAiSignal(genAi),
		genAi,
	}
}

export const mapAiSpans = (rows: readonly AiSessionSpansOutput[]): readonly AiAgentSpan[] =>
	rows.map(mapAiSpan)
