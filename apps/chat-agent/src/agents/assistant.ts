import { db } from "@electric-ax/agents-runtime"
import type { AgentTool, EntityRegistry } from "@electric-ax/agents-runtime"
import { Type } from "@sinclair/typebox"
import { chatroomSchema } from "@maple/domain/chat"
import { z } from "zod"
import { SYSTEM_PROMPT } from "../system-prompt.js"
import { createMapleAgentTools } from "../tools/maple-tools.js"

const assistantArgs = z.object({
	orgId: z.string().min(1),
	tabId: z.string().min(1),
	chatroomId: z.string().min(1),
})

export const ASSISTANT_TYPE = "assistant"
export const ASSISTANT_DISPLAY_NAME = "Maple AI"

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

interface MessageRow {
	key: string
	role: "user" | "agent"
	sender: string
	senderName: string
	text: string
	timestamp: number
}

interface MessagesCollection {
	toArray: Array<MessageRow>
	insert: (row: MessageRow) => { isPersisted?: { promise?: Promise<unknown> } }
}

function renderHistory(messages: ReadonlyArray<MessageRow>): string {
	if (messages.length === 0) return ""
	return (
		`Conversation so far:\n` +
		messages
			.map((m) => {
				const label = m.role === "user" ? `🧑 ${m.senderName}` : m.senderName
				return `[${label}]: ${m.text}`
			})
			.join("\n") +
		`\n`
	)
}

function createSendMessageTool(
	messages: MessagesCollection,
	entityUrl: string,
): AgentTool {
	return {
		name: "send_message",
		label: "Send Message",
		description: "Post your reply to the chat.",
		parameters: Type.Object({
			text: Type.String({ description: "The message to send to the user." }),
		}),
		execute: async (_toolCallId, params) => {
			const { text } = params as { text: string }
			const transaction = messages.insert({
				key: crypto.randomUUID(),
				role: "agent",
				sender: entityUrl,
				senderName: ASSISTANT_DISPLAY_NAME,
				text,
				timestamp: Date.now(),
			})
			// Wait for the durable-stream commit so the LLM can't queue a
			// second tool call before the first lands in the shared state.
			await transaction.isPersisted?.promise
			return {
				content: [{ type: "text" as const, text: "Message sent." }],
				details: { text },
			}
		},
	}
}

export function registerAssistantAgent(registry: EntityRegistry): void {
	registry.define(ASSISTANT_TYPE, {
		description: "Maple observability assistant",
		creationSchema: assistantArgs,

		async handler(ctx) {
			const { chatroomId, orgId, tabId } = ctx.args as z.infer<typeof assistantArgs>

			// `mkdb` must run on first wake so the shared-state stream exists.
			if (ctx.firstWake) ctx.mkdb(chatroomId, chatroomSchema)

			// `observe()` must be called on every wake (including the first)
			// and BEFORE any early return — that's how the wake subscription
			// keeps itself registered. See electric-agents AGENTS.md.
			const chatroom = (await ctx.observe(db(chatroomId, chatroomSchema), {
				wake: { on: "change", collections: ["shared:message"] },
			})) as unknown as { messages: MessagesCollection } & { id: string }

			// On first wake the shared state is empty; nothing to reply to yet.
			if (ctx.firstWake) return

			// Loop prevention: only respond if the latest user message hasn't
			// been answered yet. The single-agent variant of the philosopher
			// example's check — no "@-mention" semantics here.
			const all = [...chatroom.messages.toArray].sort(
				(a, b) => a.timestamp - b.timestamp,
			)
			const lastUserIdx = all.findLastIndex((m) => m.role === "user")
			if (lastUserIdx === -1) return
			const repliedAfter = all
				.slice(lastUserIdx + 1)
				.some((m) => m.sender === ctx.entityUrl)
			if (repliedAfter) return

			let mapleTools: AgentTool[] = []
			try {
				mapleTools = await getMapleToolsForOrg(orgId)
				console.log(
					`[assistant] wake org=${orgId} tab=${tabId} mapleTools=${mapleTools.length}`,
				)
			} catch (err) {
				console.error("[assistant] failed to load Maple tools:", err)
			}

			ctx.useContext({
				sourceBudget: 50_000,
				sources: {
					conversation: {
						cache: "volatile",
						content: async () => renderHistory(all),
					},
				},
			})

			ctx.useAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: "moonshotai/kimi-k2.5",
				provider: "openrouter",
				getApiKey: () => process.env.OPENROUTER_API_KEY,
				tools: [
					...mapleTools,
					createSendMessageTool(chatroom.messages, ctx.entityUrl),
				],
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

