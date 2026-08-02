/**
 * Local message/part types for the chat UI, materialized from Maple's own durable
 * chat transport (`@maple/domain/chat-session`) by `useMapleChat`. A message is a
 * role plus an ordered list of parts; a part is either prose or one tool call's
 * full lifecycle (`input-available` → `output-available`/`output-error`).
 *
 * This used to be Flue's `FlueConversationMessage`/`FlueConversationPart` (hence
 * `UIMessage`/`UIMessagePart` — the alias outlived the type it was aliasing). Kept
 * as the name here because every component in this directory already calls it
 * that, and `ChatStatus`/`FileUIPart`/`SourceDocumentUIPart` are declared locally
 * so the UI doesn't pull in the (removed) Vercel AI SDK.
 */
export type UIMessagePart =
	| { type: "text"; text: string; state: "streaming" | "done" }
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "input-available"
			input: unknown
	  }
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "output-available"
			input: unknown
			output: unknown
	  }
	| {
			type: "dynamic-tool"
			toolCallId: string
			toolName: string
			state: "output-error"
			input: unknown
			errorText: string
	  }

export interface UIMessage {
	id: string
	role: "user" | "assistant"
	parts: UIMessagePart[]
}

/** Composer status. Flue's `idle`/`connecting` map to `ready` for the submit button. */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error"

export interface FileUIPart {
	type: "file"
	mediaType: string
	filename?: string
	url: string
}

export interface SourceDocumentUIPart {
	type: "source-document"
	sourceId: string
	mediaType: string
	title: string
	filename?: string
	providerMetadata?: Record<string, unknown>
}
