// The `AiVendor` column's vocabulary, mirrored for the read path.
//
// The authority is `apps/ingest/src/ai_vendors.rs` — `VendorId::slug()` is what the
// write path stamps on every row, and its `slug_set_mirrors_the_typescript_vendors`
// test `include_str!`s THIS FILE, parses the array below, and asserts the two agree.
// There is no codegen and no build-step coupling: a vendor added in Rust fails
// `cargo test` with the missing slug named, and the fix is to add the line here.
//
// Keep the array a plain list of double-quoted string literals, one per line — that
// is the shape the Rust-side parser reads (it asserts it still finds ≥20, so a
// reformat that defeats it fails loudly rather than silently passing).
//
// Order is the Rust discriminant order (vendors alphabetically, then the reserved
// `unknown:` fingerprint buckets), so the two lists compare line for line.

export const AI_VENDORS = [
	"agno",
	"claude_agent_sdk",
	"crewai",
	"dspy",
	"effect_ai",
	"flue",
	"google_adk",
	"haystack",
	"langchain",
	"litellm",
	"llamaindex",
	"mastra",
	"microsoft_agent_framework",
	"openai_agents_sdk",
	"openinference-openai",
	"pydantic_ai",
	"semantic_kernel",
	"smolagents",
	"spring_ai",
	"strands",
	"vercel_ai_sdk",
	"unknown:genai",
	"unknown:openinference",
	"unknown:other",
] as const

/**
 * A vendor slug, or one of the three `unknown:*` buckets a span falls into when it
 * carries an AI dialect no vendor claims. `AiVendor` is empty string on rows the
 * classifier examined and rejected — that is not a member of this union.
 */
export type AiVendor = (typeof AI_VENDORS)[number]

/** Display names. Vendor casing follows each project's own, not a house style. */
export const AI_VENDOR_LABELS: Readonly<Record<AiVendor, string>> = {
	agno: "Agno",
	claude_agent_sdk: "Claude Agent SDK",
	crewai: "CrewAI",
	dspy: "DSPy",
	effect_ai: "Effect AI",
	flue: "Flue",
	google_adk: "Google ADK",
	haystack: "Haystack",
	langchain: "LangChain",
	litellm: "LiteLLM",
	llamaindex: "LlamaIndex",
	mastra: "Mastra",
	microsoft_agent_framework: "Microsoft Agent Framework",
	openai_agents_sdk: "OpenAI Agents SDK",
	"openinference-openai": "OpenInference (OpenAI)",
	pydantic_ai: "Pydantic AI",
	semantic_kernel: "Semantic Kernel",
	smolagents: "smolagents",
	spring_ai: "Spring AI",
	strands: "Strands",
	vercel_ai_sdk: "Vercel AI SDK",
	"unknown:genai": "Unknown (GenAI semconv)",
	"unknown:openinference": "Unknown (OpenInference)",
	"unknown:other": "Unknown",
}
