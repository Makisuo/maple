import type { AgentTool, EntityRegistry } from "@electric-ax/agents-runtime"
import { z } from "zod"
import { SYSTEM_PROMPT } from "../system-prompt.js"
import { createMapleAgentTools } from "../tools/maple-tools.js"

const assistantArgs = z.object({
	orgId: z.string().min(1),
	tabId: z.string().min(1),
})

export const ASSISTANT_TYPE = "assistant"

// Cache the Maple tools per-org. `getMapleAgentSetup` builds an Effect
// ManagedRuntime that's relatively expensive to set up — one per process,
// not per wake.
const mapleToolsCache = new Map<string, Promise<AgentTool[]>>()

function getMapleToolsForOrg(orgId: string): Promise<AgentTool[]> {
	const existing = mapleToolsCache.get(orgId)
	if (existing) return existing
	const built = createMapleAgentTools({
		orgId,
		env: process.env as Record<string, unknown>,
	}).catch((err) => {
		mapleToolsCache.delete(orgId)
		throw err
	})
	mapleToolsCache.set(orgId, built)
	return built
}

export function registerAssistantAgent(registry: EntityRegistry): void {
	registry.define(ASSISTANT_TYPE, {
		description: "Maple observability assistant",
		creationSchema: assistantArgs,

		async handler(ctx) {
			// Only run on inbound user messages — skip empty wakes, the
			// placeholder "ready" initialMessage, and internal "agent reply"
			// reflections so the assistant doesn't loop on its own output.
			const hasUserMessage = ctx.events.some((e) => {
				const evt = e as { type?: string; value?: { message_type?: string } }
				return evt.type === "inbox" && evt.value?.message_type === "user_message"
			})
			if (!hasUserMessage) return

			const { orgId, tabId } = ctx.args as z.infer<typeof assistantArgs>

			let mapleTools: AgentTool[] = []
			try {
				mapleTools = await getMapleToolsForOrg(orgId)
				console.log(
					`[assistant] wake org=${orgId} tab=${tabId} mapleTools=${mapleTools.length}`,
				)
			} catch (err) {
				console.error("[assistant] failed to load Maple tools:", err)
			}

			ctx.useAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: "moonshotai/kimi-k2.5",
				provider: "openrouter",
				getApiKey: () => process.env.OPENROUTER_API_KEY,
				tools: [...mapleTools, ...ctx.electricTools],
			})

			try {
				await ctx.agent.run()
			} catch (err) {
				console.error("[assistant] run failed:", err)
				throw err
			}
		},
	})
}
