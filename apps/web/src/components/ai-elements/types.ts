/**
 * Local message/part types for the chat UI. The message shape is Flue's own
 * `FlueConversationMessage` — a materialized conversation entry with a role,
 * parts, an optional `submissionId`, and metadata (server timestamp, model,
 * token usage). It is aliased to `UIMessage` here because that is what every
 * component in this directory calls it, and the alias keeps the rename to one
 * place if Flue's type moves again.
 *
 * `ChatStatus`/`FileUIPart`/`SourceDocumentUIPart` were previously imported from
 * `ai`; they're declared here so the UI doesn't pull in the (removed) Vercel AI SDK.
 */
export type { FlueConversationMessage as UIMessage, FlueConversationPart as UIMessagePart } from "@flue/react"

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
