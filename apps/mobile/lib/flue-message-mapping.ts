import type { FlueConversationMessage, FlueConversationPart } from "@flue/sdk"
import type { UIMessage, UIMessagePart } from "./chat-types"

/**
 * Map Flue's materialized conversation onto the local `UIMessage` shape the
 * mobile chat renders.
 *
 * Flue 2 replaced the delta stream (`agents.stream` + a client-side reducer)
 * with a server-materialized conversation, so this is a pure projection: no
 * accumulation, no partial-state bookkeeping, and streaming is expressed by a
 * part's own `state` rather than by the order deltas arrived in.
 */

/** `dynamic-tool` is Flue's shape; the UI keys tool rendering off `tool-<name>`. */
const mapPart = (part: FlueConversationPart): UIMessagePart | null => {
	if (part.type === "text") return { type: "text", text: part.text, state: part.state }
	if (part.type === "dynamic-tool") {
		return {
			type: part.toolName ? `tool-${part.toolName}` : "dynamic-tool",
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			state: part.state,
			input: part.input,
			...(part.state === "output-available" ? { output: part.output } : {}),
			...(part.state === "output-error" ? { errorText: part.errorText } : {}),
		}
	}
	// `reasoning`, `file`, and `data-*` parts have no mobile renderer yet — drop
	// them rather than surfacing an untyped blob in the transcript.
	return null
}

export const toMobileMessages = (messages: readonly FlueConversationMessage[]): UIMessage[] =>
	messages
		// `diagnostic`/`hidden` messages are runtime advisories and internal
		// dispatch input; the mobile transcript shows primary chat only.
		.filter((message) => message.display === "visible")
		.map((message) => ({
			id: message.id,
			role: message.role,
			parts: message.parts.map(mapPart).filter((part): part is UIMessagePart => part !== null),
		}))
