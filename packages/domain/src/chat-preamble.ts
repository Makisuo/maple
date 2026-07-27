/**
 * Sentinels fencing the machine-written part of a chat message.
 *
 * A chat turn carries only a string, so context the model needs — an
 * investigation's subject snapshot, a page's entities, a broken widget's config —
 * travels inside the user's own message. Fencing it means the model reads it
 * while the transcript can leave it out of the bubble, which matters now that
 * user turns are durable and replay to everyone who opens the thread.
 *
 * Shared here because both ends have to agree: `apps/api` wraps the prompt that
 * seeds an investigation, `apps/web` wraps per-conversation context and strips
 * both at render time.
 */
export const CHAT_CONTEXT_OPEN = "<!--maple:context-->"
export const CHAT_CONTEXT_CLOSE = "<!--/maple:context-->"

/** Fence a context block ahead of the user's own words. */
export const wrapChatContext = (block: string, userText: string): string =>
	`${CHAT_CONTEXT_OPEN}\n${block}\n${CHAT_CONTEXT_CLOSE}${userText ? `\n\n${userText}` : ""}`

/**
 * Drop a leading fenced block. A message that was *entirely* context — the
 * server-seeded opening prompt — comes back empty, which is the signal to render
 * it as a marker rather than as something the engineer said.
 */
export const stripChatContext = (text: string): string => {
	if (!text.startsWith(CHAT_CONTEXT_OPEN)) return text
	const end = text.indexOf(CHAT_CONTEXT_CLOSE)
	if (end === -1) return text
	return text.slice(end + CHAT_CONTEXT_CLOSE.length).replace(/^\s+/, "")
}
