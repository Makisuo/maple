import { MapleMark } from "@maple/ui/components/icons"

import {
	ChatBubbleSparkleIcon,
	ClaudeIcon,
	CrewAiIcon,
	EffectIcon,
	GoogleIcon,
	HaystackIcon,
	HuggingFaceIcon,
	type IconComponent,
	LangchainIcon,
	MicrosoftIcon,
	OpenAiIcon,
	PydanticIcon,
	SpringIcon,
	VercelIcon,
} from "@/components/icons"

/**
 * Brand marks for the vendor ids the ingest gateway stamps. A framework is
 * listed only when its logo is one we can draw faithfully — the rest fall back
 * to the generic mark on purpose. An approximated logo names the wrong company;
 * the fallback merely declines to name one, and `vendorLabel` says it in words
 * either way.
 */
const VENDOR_ICONS: Record<string, IconComponent> = {
	claude_agent_sdk: ClaudeIcon,
	crewai: CrewAiIcon,
	effect_ai: EffectIcon,
	google_adk: GoogleIcon,
	haystack: HaystackIcon,
	langchain: LangchainIcon,
	maple: MapleMark,
	microsoft_agent_framework: MicrosoftIcon,
	openai_agents_sdk: OpenAiIcon,
	"openinference-openai": OpenAiIcon,
	pydantic_ai: PydanticIcon,
	semantic_kernel: MicrosoftIcon,
	smolagents: HuggingFaceIcon,
	spring_ai: SpringIcon,
	vercel_ai_sdk: VercelIcon,
} satisfies Record<string, IconComponent>

/** The mark that belongs beside `vendorLabel(vendorId)`. */
export function vendorIcon(vendorId: string): IconComponent {
	return VENDOR_ICONS[vendorId] ?? ChatBubbleSparkleIcon
}
