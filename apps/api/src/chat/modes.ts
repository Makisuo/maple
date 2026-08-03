// Conversation modes → system prompt.
//
// Moved into apps/api from apps/chat-flue when the chat shell came off Flue. The mode itself lives
// in the shared wire contract (`chatModeFromSessionId` in `@maple/domain/chat-session`), so the
// client, the Durable Object and this prompt assembly all derive it the same way; only the prompt
// text is here.
//
// **Per-conversation context is not assembled here.** Alert / widget-fix / page context reaches the
// model as a fenced preamble on the conversation's first user message, built client-side by
// `apps/web/src/components/chat/context-preamble.ts` and stripped from the visible bubble by
// `stripChatContext`. This file used to carry a second, server-side copy of those same formatters,
// inherited from the pre-Flue agent that received context out-of-band in the request body. Nothing
// reached them — `ChatSendRequest` carries only `text`, so there was no wire path for that context
// to arrive on — and keeping two divergent formatters for one prompt block was worse than keeping
// the one the client actually uses.

import type { ChatMode } from "@maple/domain/chat-session"
import { DASHBOARD_BUILDER_SYSTEM_PROMPT, INVESTIGATE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"

export interface BuildSystemPromptArgs {
	mode: ChatMode
}

/** The system prompt for a turn, chosen by the conversation's mode. */
export const buildSystemPrompt = ({ mode }: BuildSystemPromptArgs): string =>
	mode === "dashboard-builder"
		? DASHBOARD_BUILDER_SYSTEM_PROMPT
		: mode === "investigate"
			? INVESTIGATE_SYSTEM_PROMPT
			: SYSTEM_PROMPT
