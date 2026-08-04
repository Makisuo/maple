import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"

/**
 * Default eval model. Override with `MCP_EVAL_MODEL`.
 */
const DEFAULT_EVAL_MODEL = "moonshotai/kimi-k2.7-code"

const evalModelId = (): string => process.env.MCP_EVAL_MODEL ?? DEFAULT_EVAL_MODEL

/** Evals require an OpenRouter key; without one the suites skip rather than fail. */
export const hasEvalCredentials = (): boolean => Boolean(process.env.OPENROUTER_API_KEY)

/**
 * Build the eval model via OpenRouter.
 *
 * Deliberately *not* app-attributed or tagged the way `apps/api/src/platform/Llm.ts` is: this is
 * CI-only traffic, and keeping it off Maple's OpenRouter app page keeps eval spend out of the
 * product's numbers. See `docs/openrouter-tracing.md`.
 */
export const createEvalModel = (): LanguageModel => {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY is required to run MCP evals")
	}
	const openrouter = createOpenAICompatible({
		name: "openrouter",
		baseURL: "https://openrouter.ai/api/v1",
		apiKey,
	})
	return openrouter.chatModel(evalModelId())
}
