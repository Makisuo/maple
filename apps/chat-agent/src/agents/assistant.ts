import type { EntityRegistry } from "@electric-ax/agents-runtime"
import { z } from "zod"
import { SYSTEM_PROMPT } from "../system-prompt.js"

const assistantArgs = z.object({
	orgId: z.string().min(1),
	tabId: z.string().min(1),
})

export const ASSISTANT_TYPE = "assistant"

export function registerAssistantAgent(registry: EntityRegistry): void {
	registry.define(ASSISTANT_TYPE, {
		description: "Maple observability assistant (baseline)",
		creationSchema: assistantArgs,

		async handler(ctx) {
			// Only run on inbound user messages — skip empty wakes and
			// internal "agent reply" reflections so the assistant doesn't
			// loop on its own output.
			const hasUserMessage = ctx.events.some((e) => {
				const evt = e as { type?: string; value?: { message_type?: string } }
				return (
					evt.type === "inbox" &&
					evt.value?.message_type === "user_message"
				)
			})
			if (!hasUserMessage) return

			try {
				ctx.useAgent({
					systemPrompt: SYSTEM_PROMPT,
					model: "moonshotai/kimi-k2.5",
					provider: "openrouter",
					getApiKey: () => process.env.OPENROUTER_API_KEY,
					tools: [...ctx.electricTools],
				})
				await ctx.agent.run()
			} catch (err) {
				console.error("[assistant] run failed:", err)
				throw err
			}
		},
	})
}
