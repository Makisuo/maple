import { SparklesIcon } from "../../components/icons"
import {
	formatGenAiCost,
	formatTokens,
	getGenAiInfo,
	humanizeGenAiOperation,
	humanizeGenAiProvider,
} from "../gen-ai"
import type { CloudPlatformAdapter, CloudPlatformField } from "./types"

// GenAI / LLM client spans (OpenRouter Broadcast + OTel `gen_ai.*` semconv).
// Reuses the same span-annotation registry as the cloud-platform adapters: the
// normalized `CloudPlatformInfo` shape describes an LLM call (provider, model,
// tokens, cost) as well as it describes a serverless invocation, so registering
// this adapter lights up the model/provider badge across every trace view AND
// the span-detail summary block with no component changes.

/** Brand-ish accent per provider; a small tint on the icon, muted otherwise. */
const PROVIDER_ACCENTS: Record<string, string> = {
	openai: "text-[#10A37F]",
	azure: "text-[#0078D4]",
	anthropic: "text-[#D97757]",
	openrouter: "text-[#6467F2]",
	google: "text-[#4285F4]",
	gemini: "text-[#4285F4]",
	"gcp.gemini": "text-[#4285F4]",
	cohere: "text-[#39594D]",
	mistral: "text-[#FF7000]",
	mistral_ai: "text-[#FF7000]",
	groq: "text-[#F55036]",
	perplexity: "text-[#20808D]",
	deepseek: "text-[#4D6BFE]",
	bedrock: "text-[#FF9900]",
	"aws.bedrock": "text-[#FF9900]",
	fireworks: "text-[#6B2FA5]",
}

// Finish reasons that read as a failure of the generation itself (distinct from
// the OTel span status). Everything else — "stop", "tool_calls" — is a normal
// completion and never flagged.
const BAD_FINISH_REASONS = new Set(["error", "content_filter"])

export const genAiAdapter: CloudPlatformAdapter = {
	id: "gen_ai",
	detect(attrs) {
		const info = getGenAiInfo(attrs)
		if (!info) return null

		const fields: CloudPlatformField[] = []
		if (info.model) fields.push({ label: "Model", value: info.model, copyable: true })
		// Only surface the requested model when it differs from what actually served.
		if (info.requestModel && info.requestModel !== info.model) {
			fields.push({ label: "Requested", value: info.requestModel, copyable: true })
		}

		const tokens = formatTokenSummary(info.inputTokens, info.outputTokens, info.totalTokens)
		if (tokens) fields.push({ label: "Tokens", value: tokens })
		if (info.cost != null) fields.push({ label: "Cost", value: formatGenAiCost(info.cost) })
		if (info.temperature != null) fields.push({ label: "Temperature", value: String(info.temperature) })
		if (info.topP != null) fields.push({ label: "Top P", value: String(info.topP) })
		if (info.maxTokens != null) {
			fields.push({ label: "Max tokens", value: formatTokens(info.maxTokens) })
		}
		if (info.finishReasons.length > 0) {
			fields.push({ label: "Finish", value: info.finishReasons.join(", ") })
		}

		const badReason = info.finishReasons.find((r) => BAD_FINISH_REASONS.has(r.toLowerCase()))
		const provider = info.provider

		return {
			id: "gen_ai",
			label: provider ? humanizeGenAiProvider(provider) : "LLM",
			kind: info.operation ? humanizeGenAiOperation(info.operation) : "LLM",
			Icon: SparklesIcon,
			accentClassName: provider
				? (PROVIDER_ACCENTS[provider.toLowerCase()] ?? "text-muted-foreground")
				: "text-muted-foreground",
			edge: null,
			location: null,
			outcome: badReason ? { value: badReason, bad: true } : null,
			fields,
		}
	},
}

/** "1,234 in · 567 out" / "1,801 total" / "1,234 in" — whatever is present. */
function formatTokenSummary(
	input: number | null,
	output: number | null,
	total: number | null,
): string | null {
	const parts: string[] = []
	if (input != null) parts.push(`${formatTokens(input)} in`)
	if (output != null) parts.push(`${formatTokens(output)} out`)
	if (parts.length > 0) return parts.join(" · ")
	if (total != null) return `${formatTokens(total)} total`
	return null
}
