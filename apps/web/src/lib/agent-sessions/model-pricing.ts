// Model spend, estimated from a dated table of published list prices.
//
// This is what the session's tokens would have cost at each provider's public
// per-token list price — not what anyone was billed. Committed spend, volume
// discounts, batch and priority tiers, provider-side caching rules and every
// enterprise agreement move the real number, usually downwards. The page
// therefore labels the figure "model spend", prints the table's date beside it,
// and counts the models it could not price instead of quietly dropping them, so
// an estimate is never mistaken for an invoice.
//
// Prices are per million tokens, in USD. A model absent from the table is
// reported as unpriced rather than approximated from a neighbouring one: an
// invented price is worse than a stated gap.

/** Shown next to the total. Update it whenever a row below changes. */
export const PRICE_TABLE_DATE = "2026-08-20"

export interface ModelPrice {
	readonly input: number
	readonly output: number
	/** Reading a cached prompt prefix. */
	readonly cacheRead: number
	/**
	 * Writing one. Anthropic bills a premium over input for this; providers that
	 * cache automatically bill it as ordinary input, which is what an entry equal
	 * to `input` means.
	 */
	readonly cacheWrite: number
}

/**
 * Keyed by model-id prefix, longest match wins — so a dated release id
 * (`claude-sonnet-4-5-20250929`) prices off its family without a row per build,
 * and `claude-sonnet-4-5` still beats `claude-sonnet-4`.
 *
 * A prefix only matches when what follows it is a build or date qualifier, so a
 * row is never stretched over a neighbouring model: `gpt-4o-mini` is not
 * `gpt-4o` (16.7x too high) and `o3-pro` is not `o3` (10x too low). Both now
 * have rows; anything else lands in `unpricedModels`, where a gap is visible.
 */
const PRICE_TABLE: ReadonlyArray<readonly [string, ModelPrice]> = [
	// Anthropic — cache writes at 1.25x input (5-minute TTL), reads at 0.1x.
	["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
	["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
	["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
	["claude-sonnet-4-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
	["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
	["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
	["claude-3-7-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
	["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],

	// OpenAI — prompt caching is automatic and writes are billed as input.
	["gpt-5-mini", { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 }],
	["gpt-5-nano", { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 }],
	["gpt-5", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
	["gpt-4.1-mini", { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 }],
	["gpt-4.1", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
	["gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 }],
	["gpt-4o", { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }],
	["o3-pro", { input: 20, output: 80, cacheRead: 5, cacheWrite: 20 }],
	["o3-mini", { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 }],
	["o3", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],

	// Google — the Gemini 2.5 Pro row is its short-prompt tier; long prompts are
	// billed higher, so this estimate reads low on very large contexts.
	["gemini-2.5-pro", { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 }],
	["gemini-2.5-flash-lite", { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 }],
	["gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 }],
	["gemini-2.0-flash", { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 }],
]

/**
 * Normalize a wire model id to something the table can match: lowercase, and
 * without the routing prefix gateways prepend (`anthropic/claude-sonnet-4`,
 * `models/gemini-2.5-pro`). Ids that carry a cloud-provider namespace instead
 * (Bedrock's `us.anthropic.…`) stay unmatched and are reported as unpriced.
 */
function normalizeModelId(model: string): string {
	const lower = model.trim().toLowerCase()
	const lastSlash = lower.lastIndexOf("/")
	return lastSlash === -1 ? lower : lower.slice(lastSlash + 1)
}

/**
 * What may follow a matched prefix: a build date (`-20250929`, `-2025-08-07`),
 * a version, or `latest`. Anything else — `-mini`, `-pro`, `.6-luna` — names a
 * different model, whose price is not this row's to guess.
 */
const BUILD_QUALIFIER = /^[-@.](\d{4}-\d{2}-\d{2}|\d{6,8}|v\d+|latest)/

export function lookupModelPrice(model: string): ModelPrice | undefined {
	const id = normalizeModelId(model)
	let best: { readonly prefix: string; readonly price: ModelPrice } | undefined
	for (const [prefix, price] of PRICE_TABLE) {
		if (!id.startsWith(prefix)) continue
		const rest = id.slice(prefix.length)
		if (rest !== "" && !BUILD_QUALIFIER.test(rest)) continue
		if (best === undefined || prefix.length > best.prefix.length) best = { prefix, price }
	}
	return best?.price
}

export interface ModelTokenUsage {
	readonly model: string
	readonly tokens: {
		readonly input: number
		readonly cacheRead: number
		readonly cacheWrite: number
		readonly output: number
		readonly reasoning: number
	}
}

export interface ModelSpendEstimate {
	readonly totalUsd: number
	/** Models the table has no row for, in the order they were given. */
	readonly unpricedModels: readonly string[]
}

/**
 * Estimated spend across a session's models.
 *
 * Reasoning tokens bill as output: providers charge for them at the output rate
 * even though they are absent from the response body.
 *
 * Token counts are taken exactly as the span reported them, so the buckets are
 * only as disjoint as the provider makes them: where cached tokens are reported
 * as a subset of the input count rather than beside it, those tokens are priced
 * twice and the estimate reads high. Erring high is deliberate — a spend figure
 * that flatters the bill is the one that gets believed.
 */
export function computeModelSpend(usage: readonly ModelTokenUsage[]): ModelSpendEstimate {
	let totalUsd = 0
	const unpricedModels: string[] = []

	for (const { model, tokens } of usage) {
		const price = lookupModelPrice(model)
		if (price === undefined) {
			// Only worth flagging if it actually used tokens — a model id on a span
			// that reported no usage cannot move the total.
			const used =
				tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
			if (used > 0 && !unpricedModels.includes(model)) unpricedModels.push(model)
			continue
		}
		totalUsd +=
			(tokens.input * price.input +
				tokens.cacheRead * price.cacheRead +
				tokens.cacheWrite * price.cacheWrite +
				(tokens.output + tokens.reasoning) * price.output) /
			1_000_000
	}

	return { totalUsd, unpricedModels }
}
