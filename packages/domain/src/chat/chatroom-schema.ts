/**
 * Shared chatroom schema for the Electric Agents chat-agent.
 *
 * One chatroom = one durable shared-state stream keyed by the entity id.
 * Agents observe it on the server (`db(chatroomId, chatroomSchema)`); the
 * web client observes the same shape via TanStack DB.
 *
 * The agents-runtime today accepts Zod for collection schemas — we re-derive
 * an Effect Schema in `./message.ts` for callers that want it.
 */
import { z } from "zod"

export const messageSchemaZod = z.object({
	key: z.string().min(1),
	role: z.enum(["user", "agent"]),
	sender: z.string().min(1),
	senderName: z.string().min(1),
	text: z.string(),
	timestamp: z.number(),
})

export type ChatMessage = z.infer<typeof messageSchemaZod>

/**
 * Collection schema accepted by `@electric-ax/agents-runtime`'s `db()` factory.
 * The `type` field is the event-type filter used by `wake: { collections }`.
 */
export const chatroomSchema = {
	messages: {
		schema: messageSchemaZod,
		type: "shared:message",
		primaryKey: "key",
	},
} as const

export type ChatroomSchema = typeof chatroomSchema
