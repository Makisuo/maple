// GenAI / LLM span annotations (OpenTelemetry `gen_ai.*` semantic conventions,
// as emitted by OpenRouter Broadcast and other LLM instrumentations). This
// normalizes the raw attribute map into a single `GenAiInfo` the trace views and
// span-detail panel consume, coalescing the semconv drift
// (`gen_ai.system` → `gen_ai.provider.name`) and tolerating OpenRouter Privacy
// Mode, where prompt/completion/finish-reason fields are absent while token,
// cost, model, and provider data remain.

export interface GenAiInfo {
	/** `gen_ai.operation.name`, e.g. "chat" | "embeddings" | "execute_tool". */
	operation: string | null
	/** `gen_ai.provider.name`, falling back to legacy `gen_ai.system`. */
	provider: string | null
	/** `gen_ai.request.model` — the requested model id. */
	requestModel: string | null
	/** `gen_ai.response.model` — the model that actually served the request. */
	responseModel: string | null
	/** Best single model to display: response model if present, else request. */
	model: string | null
	inputTokens: number | null
	outputTokens: number | null
	/** input + output when both present, else `gen_ai.usage.total_tokens`. */
	totalTokens: number | null
	/** `gen_ai.usage.cost` (OpenRouter) in the account's currency (USD). */
	cost: number | null
	temperature: number | null
	topP: number | null
	maxTokens: number | null
	/** `gen_ai.response.finish_reasons` — parsed from a JSON array or CSV string. */
	finishReasons: ReadonlyArray<string>
}

/** First present, non-blank value among `keys`. */
function pick(attrs: Record<string, string>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = attrs[key]
		if (value != null && value.trim() !== "") return value
	}
	return null
}

/** Parse a stringified number, returning null for blank/non-finite values. */
function num(attrs: Record<string, string>, ...keys: string[]): number | null {
	const raw = pick(attrs, ...keys)
	if (raw == null) return null
	const n = Number(raw)
	return Number.isFinite(n) ? n : null
}

/**
 * `gen_ai.response.finish_reasons` is spec'd as a string array, but arrives here
 * as a stringified map value — usually a JSON array (`["stop"]`), occasionally a
 * bare/CSV string. Parse either into a clean list; empty on absence.
 */
function parseFinishReasons(raw: string | null): string[] {
	if (raw == null) return []
	const trimmed = raw.trim()
	if (trimmed === "") return []
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (Array.isArray(parsed)) {
				return parsed.map((r) => String(r).trim()).filter((r) => r !== "")
			}
		} catch {
			// fall through to CSV handling
		}
	}
	return trimmed
		.split(",")
		.map((r) => r.trim())
		.filter((r) => r !== "")
}

/**
 * Normalized GenAI info when `attrs` describe an LLM span, else null.
 *
 * Detection keys on a real, non-empty `gen_ai.operation.name` **or** model VALUE
 * — never key-presence. The trimmed tree-view projection emits requested keys
 * with empty-string values on every span, so a presence check would flag
 * non-LLM spans (the same footgun the cloud-platform adapters guard against).
 */
export function getGenAiInfo(attrs: Record<string, string>): GenAiInfo | null {
	const operation = pick(attrs, "gen_ai.operation.name")
	const requestModel = pick(attrs, "gen_ai.request.model")
	const responseModel = pick(attrs, "gen_ai.response.model")
	if (operation == null && requestModel == null && responseModel == null) return null

	const inputTokens = num(attrs, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens")
	const outputTokens = num(attrs, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens")
	const totalTokens =
		inputTokens != null && outputTokens != null
			? inputTokens + outputTokens
			: num(attrs, "gen_ai.usage.total_tokens")

	return {
		operation,
		provider: pick(attrs, "gen_ai.provider.name", "gen_ai.system"),
		requestModel,
		responseModel,
		model: responseModel ?? requestModel,
		inputTokens,
		outputTokens,
		totalTokens,
		cost: num(attrs, "gen_ai.usage.cost"),
		temperature: num(attrs, "gen_ai.request.temperature"),
		topP: num(attrs, "gen_ai.request.top_p"),
		maxTokens: num(attrs, "gen_ai.request.max_tokens"),
		finishReasons: parseFinishReasons(pick(attrs, "gen_ai.response.finish_reasons")),
	}
}

/** Display names for well-known `gen_ai.provider.name` / `gen_ai.system` values. */
const PROVIDER_LABELS: Record<string, string> = {
	openai: "OpenAI",
	azure: "Azure OpenAI",
	"azure.ai.openai": "Azure OpenAI",
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	google: "Google",
	"gcp.gemini": "Gemini",
	"gcp.vertex_ai": "Vertex AI",
	gemini: "Gemini",
	cohere: "Cohere",
	mistral: "Mistral",
	mistral_ai: "Mistral",
	groq: "Groq",
	perplexity: "Perplexity",
	deepseek: "DeepSeek",
	xai: "xAI",
	"aws.bedrock": "Bedrock",
	bedrock: "Bedrock",
	ollama: "Ollama",
	fireworks: "Fireworks",
	together: "Together",
	replicate: "Replicate",
}

/** "openai" → "OpenAI"; unknown → title-cased last dotted segment. */
export function humanizeGenAiProvider(provider: string): string {
	const known = PROVIDER_LABELS[provider.toLowerCase()]
	if (known) return known
	const tail = provider.split(".").pop() ?? provider
	return tail
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ")
}

/** "chat" → "Chat"; "execute_tool" → "Execute Tool". */
export function humanizeGenAiOperation(operation: string): string {
	return operation
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ")
}

/** Compact token counts, e.g. "1,234 → 567" (input → output). */
export function formatTokens(n: number): string {
	return n.toLocaleString("en-US")
}

/**
 * Format an LLM cost as a currency string with adaptive precision — sub-cent
 * costs (the common per-call case) keep significant digits instead of rounding
 * to "$0.00".
 */
export function formatGenAiCost(cost: number): string {
	if (cost === 0) return "$0"
	const abs = Math.abs(cost)
	// Whole-dollar costs keep the conventional two-decimal cents; sub-dollar
	// costs get more precision but trim padding zeros ("$0.009100" → "$0.0091").
	if (abs >= 1) return `$${cost.toFixed(2)}`
	const trimmed = cost.toFixed(abs >= 0.01 ? 4 : 6).replace(/\.?0+$/, "")
	return `$${trimmed}`
}
