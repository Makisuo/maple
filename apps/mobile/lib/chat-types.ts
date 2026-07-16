/**
 * Local chat message types for mobile. Mirrors the AI-SDK-v5 `UIMessage` data
 * shape the chat UI renders, without depending on the `ai` package (the chat
 * backend is now Flue + Workers AI via `@flue/sdk`, not the Vercel AI SDK).
 */
import { Schema } from "effect"

export const TextUIPartSchema = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
	state: Schema.optionalKey(Schema.Literals(["streaming", "done"])),
})
export type TextUIPart = typeof TextUIPartSchema.Type

export const ToolUIPartSchema = Schema.Struct({
	/** `tool-<name>` or `dynamic-tool`. */
	type: Schema.String,
	toolCallId: Schema.String,
	toolName: Schema.optionalKey(Schema.String),
	state: Schema.Literals(["input-streaming", "input-available", "output-available", "output-error"]),
	input: Schema.optionalKey(Schema.Unknown),
	output: Schema.optionalKey(Schema.Unknown),
	errorText: Schema.optionalKey(Schema.String),
})
export type ToolUIPart = typeof ToolUIPartSchema.Type

export type UIMessagePart = TextUIPart | ToolUIPart

export const UIMessageSchema = Schema.Struct({
	id: Schema.String,
	role: Schema.Literals(["user", "assistant", "system"]),
	parts: Schema.Array(Schema.Union([TextUIPartSchema, ToolUIPartSchema])),
})
export type UIMessage = typeof UIMessageSchema.Type
