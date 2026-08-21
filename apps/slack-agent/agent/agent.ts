import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { defineAgent } from "eve"

/**
 * OpenRouter over its REST API.
 *
 * `appUrl`/`appName` set `HTTP-Referer`/`X-OpenRouter-Title`, which is what attributes this
 * traffic to Maple's app page on openrouter.ai. Same URL and title as `apps/api` on purpose: the
 * referer is the app's identity, so a different one here would mint a second app entry and split
 * the rankings. Surfaces are told apart by `trace.trace_name` instead — static, because this
 * process only ever is the Slack agent.
 */
const openrouter = createOpenRouter({
	apiKey: process.env.OPENROUTER_API_KEY ?? "",
	appUrl: "https://maple.dev",
	appName: "Maple",
	extraBody: { trace: { trace_name: "slack" } },
})

/**
 * Make sure no envs are missing on startup.
 */
const missingModelEnv = ["OPENROUTER_API_KEY"].filter((name) => !process.env[name])
const isEveBuildInvocation = process.argv.includes("build")
if (missingModelEnv.length > 0 && !isEveBuildInvocation) {
	console.warn(
		`[startup] ${missingModelEnv.join(" and ")} ${missingModelEnv.length === 1 ? "is" : "are"} not set. ` +
			`The service will start, but every OpenRouter model call will fail until ${missingModelEnv.length === 1 ? "it is" : "they are"} configured.`,
	)
}

/**
 * Must support tool calling **while streaming** — eve's harness is tool-driven and
 * always streams.
 */
const modelId = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna"
const contextWindowTokens = Number(process.env.OPENROUTER_CONTEXT_WINDOW ?? 400_000)

/**
 * Durable workflow state ("world").
 */
const workflowWorld = process.env.EVE_WORKFLOW_WORLD

export default defineAgent({
	model: openrouter(modelId),
	modelContextWindowTokens: contextWindowTokens,
	...(workflowWorld ? { experimental: { workflow: { world: workflowWorld } } } : undefined),
})
