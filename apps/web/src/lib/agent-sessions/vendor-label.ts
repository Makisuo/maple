/**
 * Vendor ids the ingest gateway stamps (`AI_VENDORS` in
 * apps/ingest/src/ai_session.rs) → brand names. Listed here are the ids whose
 * brand casing the title-case fallback below can't derive — acronyms (SDK,
 * ADK), camel brands (LiteLLM, DSPy), and deliberately lowercase ones (eve,
 * smolagents).
 */
const VENDOR_LABELS: Record<string, string> = {
	claude_agent_sdk: "Claude Agent SDK",
	crewai: "CrewAI",
	dspy: "DSPy",
	effect_ai: "Effect AI",
	eve: "eve",
	google_adk: "Google ADK",
	langchain: "LangChain",
	litellm: "LiteLLM",
	llamaindex: "LlamaIndex",
	openai_agents_sdk: "OpenAI Agents SDK",
	"openinference-openai": "OpenInference · OpenAI",
	openrouter: "OpenRouter",
	pydantic_ai: "Pydantic AI",
	smolagents: "smolagents",
	spring_ai: "Spring AI",
	vercel_ai_sdk: "Vercel AI SDK",
} satisfies Record<string, string>

/** The gateway's marker for "no vendor matched" (`UNKNOWN_TIER`). */
const UNIDENTIFIED_PREFIX = "unknown:"

/**
 * A vendor id as a reader should see it. Unlisted ids degrade to Title Case, so
 * a newly stamped vendor still reads as a name rather than a raw id.
 */
export function vendorLabel(vendorId: string): string {
	if (!vendorId || vendorId.startsWith(UNIDENTIFIED_PREFIX)) return "Unidentified"
	const known = VENDOR_LABELS[vendorId]
	if (known) return known
	return vendorId
		.split(/[_-]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join(" ")
}
