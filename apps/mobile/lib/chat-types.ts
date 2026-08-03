/**
 * Local chat message types for mobile. Mirrors the AI-SDK-v5 `UIMessage` data
 * shape the chat UI renders, without depending on the `ai` package — the chat
 * backend is Maple's own durable transport (`chat-client.ts` / `chat-stream.ts`),
 * not the Vercel AI SDK.
 */
export interface TextUIPart {
	type: "text"
	text: string
	state?: "streaming" | "done"
}

export interface ToolUIPart {
	/** `tool-<name>` or `dynamic-tool`. */
	type: string
	toolCallId: string
	toolName?: string
	state: "input-streaming" | "input-available" | "proposed" | "output-available" | "output-error"
	input?: unknown
	output?: unknown
	errorText?: string
}

export type UIMessagePart = TextUIPart | ToolUIPart

export interface UIMessage {
	id: string
	role: "user" | "assistant" | "system"
	parts: UIMessagePart[]
}
