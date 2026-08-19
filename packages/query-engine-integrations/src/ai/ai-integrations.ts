// AI span mapping: the default GenAI integration, the vendor registry lookup,
// and the mapper that turns one warehouse row into an `AiAgentSpan`.
//
// The mechanism is deliberately small: an integration is a table of
// `field -> source attribute keys` plus an optional `refine` hook, and a vendor
// integration is the same table applied ON TOP of the default one, per field.
// That covers the two shapes real instrumentation takes — "same meaning,
// different key" (the table) and "same key, different value" (the hook) —
// without a plugin system.
//
// Why keyed on `maple_ai.vendor.id` rather than re-detected here: the ingest
// gateway already ran the detection at decode time over evidence the read path
// no longer has (instrumentation scope, resource SDK name, span events — see
// `SCREEN_KEYS` and the vendor table in `apps/ingest/src/ai_session.rs`) and
// stamped its verdict on the span. Re-deriving a dialect from what survives
// into ClickHouse would be a weaker second copy of that decision, free to
// disagree with the stamp.
//
// Everything here is tolerant by construction. Attributes arrive as
// `Map(String, String)`, so a missing key reads back as `''` and every value is
// a string that may or may not be the shape its field expects. A value that
// fails to decode yields no field — never a throw — because one badly
// serialised attribute must not cost the user the rest of the span.

import {
	AI_GENAI_FIELDS,
	AI_PROMPT_VARIABLE_PREFIX,
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
	type AiAgentSpan,
	type AiFieldDef,
	type AiGenAiField,
	type AiSessionSpanRow,
	type MutableAiGenAiValues,
} from "./ai-span-model"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"

export interface AiRefineContext {
	readonly row: AiSessionSpanRow
	/**
	 * Span attributes merged OVER resource attributes — a span-level key wins,
	 * because resource attributes describe the process, not the operation. Both
	 * are readable here; the source key lists read from the same merged view.
	 */
	readonly attributes: Record<string, string>
}

export interface AiIntegration {
	readonly id: string
	/**
	 * Field → source attribute keys, tried in order; the first key with a value
	 * that decodes wins. A vendor entry REPLACES the default entry for that
	 * field, so a vendor that wants the canonical key to keep priority lists it
	 * first itself.
	 */
	readonly sources: Partial<Record<AiGenAiField, readonly string[]>>
	/**
	 * For what a key list cannot express: normalising a value, or deriving a
	 * field from something other than a single attribute.
	 */
	readonly refine?: (values: MutableAiGenAiValues, ctx: AiRefineContext) => void
}

/** ClickHouse returns `''` for a missing Map key, so empty means absent. */
const readAttribute = (attributes: Record<string, string>, key: string): string | undefined => {
	const value: string | undefined = attributes[key]
	return value === undefined || value === "" ? undefined : value
}

/**
 * What a JSON-typed attribute can decode to. Spelling it out rather than
 * returning `unknown` keeps the decoder's contract honest: the value came off a
 * `JSON.parse`, so it is JSON, not anything at all.
 */
export type AiJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly AiJsonValue[]
	| { readonly [key: string]: AiJsonValue }

/**
 * Every shape `decodeAttribute` can produce. It is exactly `AiJsonValue`: the
 * four scalar field types are JSON scalars and `stringArray` is a JSON array,
 * so naming them again would only restate the union.
 */
export type AiDecodedValue = AiJsonValue

const parseJson = (raw: string): AiJsonValue | undefined => {
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

const decodeStringArray = (raw: string): readonly string[] | undefined => {
	// Real data carries both shapes for the same attribute: `'["stop"]'` from
	// instrumentation that serialises the array, and a bare `"stop"` from
	// instrumentation that emits the single value. Anything that is not a JSON
	// array of strings is treated as the bare form rather than discarded.
	const parsed = parseJson(raw)
	// Unparseable is the bare form: `stop` and `"stop"`-without-quotes both land
	// here, and that is the only case where the raw text IS the value.
	if (parsed === undefined) return [raw]
	if (typeof parsed === "string") return [parsed]
	if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed
	// Parsed cleanly but into some other shape — an object, a number, an array of
	// non-strings. That is structured data in the wrong shape, not a bare value.
	// Wrapping the raw JSON text into a one-element array would type-check and
	// silently consume the field with a value that never existed, so decode to
	// nothing and let the next alias have its turn.
	return undefined
}

const decodeAttribute = (type: AiFieldDef["type"], raw: string): AiDecodedValue | undefined => {
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
		case "json":
			return parseJson(raw)
		default: {
			// A sixth field type added to the catalog without a case here would
			// otherwise compile clean and make every field of that type silently
			// absent from every span — the one failure mode this module is least
			// able to surface. `tsconfig` has no `noImplicitReturns`, so the
			// never-assignment is what actually enforces it.
			const unhandled: never = type
			return unhandled
		}
	}
}

// The catalog correlates each field with its value type, but a loop over the
// union of fields cannot carry that correlation without re-stating the whole
// table. The single unchecked write lives here; `decodeAttribute` is driven by
// the same catalog entry, so the value is right by construction.
const assign = (values: MutableAiGenAiValues, field: AiGenAiField, value: AiDecodedValue): void => {
	;(values as Record<string, AiDecodedValue>)[field] = value
}

/**
 * Deprecated and obsoleted keys the default integration still reads, per field.
 *
 * `gen_ai.prompt` / `gen_ai.completion` were obsoleted with "no replacement"
 * rather than renamed, so mapping them onto the message fields is a pragmatic
 * choice, not a spec-blessed rename: in practice they carried exactly that
 * content, and OpenRouter instrumentation in production still emits them.
 *
 * `gen_ai.usage.output_tokens.reasoning` and `gen_ai.usage.input_tokens.cached`
 * are likewise absent from the deprecation table — they are the sub-key spelling
 * OpenRouter emits in production for what the convention calls
 * `gen_ai.usage.reasoning.output_tokens` and `gen_ai.usage.cache_read.input_tokens`.
 * Both were confirmed against the warehouse; the plausible-looking
 * `gen_ai.usage.reasoning_tokens` was NOT, so it is deliberately not listed.
 */
const GENAI_LEGACY_ALIASES = {
	usageInputTokens: ["gen_ai.usage.prompt_tokens"],
	usageOutputTokens: ["gen_ai.usage.completion_tokens"],
	usageReasoningOutputTokens: ["gen_ai.usage.output_tokens.reasoning"],
	usageCacheReadInputTokens: ["gen_ai.usage.input_tokens.cached"],
	inputMessages: ["gen_ai.prompt"],
	outputMessages: ["gen_ai.completion"],
	providerName: ["gen_ai.system"],
	requestSeed: ["gen_ai.openai.request.seed"],
	outputType: ["gen_ai.openai.request.response_format"],
	responseFinishReasons: ["gen_ai.response.finish_reason"],
} satisfies Partial<Record<AiGenAiField, readonly string[]>>

const genAiSources: Partial<Record<AiGenAiField, readonly string[]>> = {}
for (const [field, def] of Object.entries(AI_GENAI_FIELDS)) {
	genAiSources[field as AiGenAiField] = [def.key]
}
for (const [field, aliases] of Object.entries(GENAI_LEGACY_ALIASES)) {
	genAiSources[field as AiGenAiField] = [...(genAiSources[field as AiGenAiField] ?? []), ...aliases]
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
	// Only a value that actually came from the legacy key gets rewritten. A span
	// that emits `gen_ai.provider.name` is already speaking the new vocabulary,
	// and its values must be passed through even when they collide with an old
	// enum member.
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
 * stamps — falls back to, and it is the base every vendor override merges onto.
 */
export const genAiIntegration: AiIntegration = {
	id: "gen_ai",
	sources: genAiSources,
	refine: genAiRefine,
}

const resolvedIntegrations = new Map<string, AiIntegration>()

/**
 * The integration for a vendor stamp: the default one, with the vendor's key
 * lists replacing the default's per field and both `refine` hooks running —
 * default first, so the vendor can correct its work.
 */
export const resolveAiIntegration = (vendorId: string | undefined): AiIntegration => {
	if (vendorId === undefined) return genAiIntegration
	// `Object.hasOwn`, not a plain index: the vendor stamp is customer-reachable
	// (the gateway strips `maple_ai.*` from span attributes but not from RESOURCE
	// attributes), and a plain index reads through the prototype chain — a stamp
	// of `constructor` or `toString` would resolve truthy, skip the guard below,
	// and mint an integration with `id: undefined` into the module-level cache.
	if (!Object.hasOwn(AI_VENDOR_INTEGRATIONS, vendorId)) return genAiIntegration
	const vendor = AI_VENDOR_INTEGRATIONS[vendorId]
	if (vendor === undefined) return genAiIntegration
	const cached = resolvedIntegrations.get(vendorId)
	if (cached !== undefined) return cached
	const merged: AiIntegration = {
		id: vendor.id,
		sources: { ...genAiIntegration.sources, ...vendor.sources },
		refine: (values, ctx) => {
			genAiIntegration.refine?.(values, ctx)
			vendor.refine?.(values, ctx)
		},
	}
	resolvedIntegrations.set(vendorId, merged)
	return merged
}

const collectPromptVariables = (attributes: Record<string, string>): Record<string, string> | undefined => {
	// A templated attribute has no fixed key, so it is collected by prefix here
	// rather than through the key-list mechanism every other field uses.
	let collected: Record<string, string> | undefined
	for (const [key, value] of Object.entries(attributes)) {
		if (!key.startsWith(AI_PROMPT_VARIABLE_PREFIX) || value === "") continue
		// Null-prototype again: a `gen_ai.prompt.variable.__proto__` key would hit
		// the prototype setter on a `{}` literal and be dropped without a trace.
		collected ??= Object.create(null) as Record<string, string>
		collected[key.slice(AI_PROMPT_VARIABLE_PREFIX.length)] = value
	}
	return collected
}

/**
 * A `core` field is plain OTel semconv that every HTTP client span carries, so
 * mapping one is not evidence that this span is an AI span.
 */
const hasAiSignal = (values: MutableAiGenAiValues): boolean =>
	Object.keys(values).some((field) => AI_GENAI_FIELDS[field as AiGenAiField].group !== "core")

interface AiSpanOptionalFields {
	sessionId?: string
	vendorId?: string
	vendorVersion?: string
	promptVariables?: Record<string, string>
}

export const mapAiSpan = (row: AiSessionSpanRow): AiAgentSpan => {
	// Null-prototype: attribute keys are customer-controlled, and a `Record`
	// index would otherwise resolve `toString` or `valueOf` to an inherited
	// function that the `=== ""` check below would wave through as a value.
	const attributes: Record<string, string> = Object.assign(
		Object.create(null) as Record<string, string>,
		row.resourceAttributes,
		row.spanAttributes,
	)
	// The `maple_ai.*` envelope is read from SPAN attributes only, never the
	// merged view. The gateway strips this namespace from span attributes before
	// stamping its own verdict, so a span-level value is authoritative — but it
	// does not touch resource attributes, and `aiSessionSpansQuery` selects
	// sessions on `SpanAttributes` alone. Reading the merged view would let one
	// forged resource attribute mark every span in a service as an AI span and
	// label it with a session id the query never matched on.
	const envelope = row.spanAttributes
	const vendorId = readAttribute(envelope, MAPLE_AI_VENDOR_ID_ATTR)
	const integration = resolveAiIntegration(vendorId)

	const genAi: MutableAiGenAiValues = {}
	for (const [field, keys] of Object.entries(integration.sources)) {
		if (keys === undefined) continue
		for (const key of keys) {
			const raw = readAttribute(attributes, key)
			if (raw === undefined) continue
			const value = decodeAttribute(AI_GENAI_FIELDS[field as AiGenAiField].type, raw)
			// A key that carries an undecodable value does not consume the
			// field: the next alias still gets its turn.
			if (value === undefined) continue
			assign(genAi, field as AiGenAiField, value)
			break
		}
	}
	integration.refine?.(genAi, { row, attributes })

	const promptVariables = collectPromptVariables(attributes)
	const sessionId = readAttribute(envelope, MAPLE_AI_SESSION_ID_ATTR)
	const vendorVersion = readAttribute(envelope, MAPLE_AI_VENDOR_VERSION_ATTR)

	// Collected separately so an absent stamp leaves the key off the span
	// entirely rather than present-and-undefined.
	const optional: AiSpanOptionalFields = {}
	if (sessionId !== undefined) optional.sessionId = sessionId
	if (vendorId !== undefined) optional.vendorId = vendorId
	if (vendorVersion !== undefined) optional.vendorVersion = vendorVersion
	if (promptVariables !== undefined) optional.promptVariables = promptVariables

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
		...optional,
		integrationId: integration.id,
		isAiSpan: vendorId !== undefined || promptVariables !== undefined || hasAiSignal(genAi),
		genAi,
	}
}

export const mapAiSpans = (rows: readonly AiSessionSpanRow[]): readonly AiAgentSpan[] => rows.map(mapAiSpan)
