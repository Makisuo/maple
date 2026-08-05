import { loadThreadContextMessages, type SlackThread, type SlackThreadMessage } from "eve/channels/slack"

/**
 * Background context for a turn: the Slack thread the bot was tagged in,
 * rendered for the model.
 *
 * eve ships this as `slackChannel({ threadContext })`, but two of its choices
 * made an @mention inside a Maple alert thread arrive with no usable context at
 * all — the exact case where context matters most, since the user is replying
 * to something the bot said rather than starting a topic:
 *
 *   1. **Content comes from `message.text` only.** Maple's alert notifications
 *      carry no top-level text: they are `chat.postMessage` with one colored
 *      attachment holding the Block Kit blocks
 *      (`apps/api/src/services/alerts/AlertDeliveryDispatch.ts` — the color bar
 *      has no block equivalent, and top-level text would render as a duplicate
 *      line above it). eve rendered them as an empty `<content></content>`, so
 *      "why did this fire?" hung on nothing and the user had to paste a recap
 *      of the alert by hand.
 *   2. **`since: "last-agent-reply"` treated the alert as the agent's own last
 *      reply** (eve's `isMe` is `bot_id !== undefined`, i.e. any bot), and cut
 *      the context off *after* it — dropping the alert and everything before it.
 *
 * So we render context ourselves: same `<slack_thread_context>` /
 * `<slack_message>` envelope eve uses (the model's view is unchanged in shape),
 * but content falls back to blocks and attachments when `text` is empty, and
 * the whole thread is included — the `thread-root` boundary. Full-thread is
 * also what makes this survive a lost session: eve sessions are keyed
 * `channelId:threadTs` and a Railway redeploy can drop the history that an
 * incremental boundary silently assumes is still there.
 *
 * Wired in `#channels/slack.js` through `onAppMention` / `onDirectMessage`,
 * which return these strings as the mention result's `context`.
 *
 * Two bounds worth knowing: every turn re-injects the transcript (so a long
 * thread pays for its history once per mention), and eve's `thread.refresh()`
 * fetches one oldest-first page of 50 replies, so past 50 the tail is the part
 * that goes missing. Alert threads are short; revisit if that stops holding.
 */

/** Who posted a context message, from the model's point of view. */
export type ThreadContextSenderType = "agent" | "bot" | "unknown" | "user"

export interface ThreadContextOptions {
	/**
	 * This workspace's bot user id (`#lib/bot-identity.js`). Distinguishes the
	 * agent's own replies from every other bot in the channel. When absent we
	 * fall back to eve's coarser "any bot is me".
	 */
	readonly botUserId?: string | undefined
}

/**
 * Loads the thread the triggering message belongs to and renders it as one
 * context string, or `[]` when there is nothing to add (thread root, empty
 * thread, or a Slack call that failed).
 *
 * Never throws: eve drops the whole mention when an `onAppMention` handler
 * throws, and losing the reply entirely is far worse than losing its context.
 */
export async function loadThreadContext(
	thread: Pick<SlackThread, "recentMessages" | "refresh">,
	message: { readonly threadTs: string; readonly ts: string },
	options: ThreadContextOptions = {},
): Promise<readonly string[]> {
	let messages: readonly SlackThreadMessage[]
	try {
		messages = await loadThreadContextMessages(thread, message, { since: "thread-root" })
	} catch (error) {
		console.warn("[slack-thread-context] Failed to load thread context; dispatching without it.", error)
		return []
	}
	const rendered = formatThreadContext(messages, options)
	return rendered === undefined ? [] : [rendered]
}

/**
 * Renders thread messages as attributed background context, or `undefined`
 * when there are none. Mirrors eve's `formatSlackThreadContext` envelope.
 */
export function formatThreadContext(
	messages: readonly SlackThreadMessage[],
	options: ThreadContextOptions = {},
): string | undefined {
	if (messages.length === 0) return undefined
	return [
		"<slack_thread_context>",
		...messages.map((message) => formatThreadContextMessage(message, options)),
		"</slack_thread_context>",
	].join("\n")
}

function formatThreadContextMessage(message: SlackThreadMessage, options: ThreadContextOptions): string {
	const { content, fromAttachment } = slackMessageContent(message)
	const senderId = message.user ?? message.botId
	return [
		"<slack_message>",
		`sender_type: ${senderType(message, fromAttachment, options)}`,
		...(senderId ? [`sender_id: ${senderId}`] : []),
		`thread_ts: ${message.threadTs}`,
		`message_ts: ${message.ts}`,
		"<content>",
		content,
		"</content>",
		"</slack_message>",
	].join("\n")
}

function senderType(
	message: SlackThreadMessage,
	fromAttachment: boolean,
	options: ThreadContextOptions,
): ThreadContextSenderType {
	// An app notification posted through the same bot user — a Maple alert card —
	// is not something the agent said. Labelling it `agent` would have the model
	// believe it already reported the incident it is being asked about. The
	// agent's own replies never use attachments (eve posts `markdown_text` or
	// top-level blocks), so "content came from an attachment" separates them.
	if (fromAttachment) return "bot"
	if (options.botUserId !== undefined) {
		if (message.user === options.botUserId) return "agent"
		if (message.botId !== undefined) return "bot"
	} else if (message.isMe) {
		return "agent"
	}
	if (message.user !== undefined) return "user"
	if (message.botId !== undefined) return "bot"
	return "unknown"
}

/**
 * The readable content of a thread message, and whether it had to be recovered
 * from an attachment (Slack's legacy surface, which is where Block Kit cards
 * with a color bar live — Maple alerts among them).
 *
 * Precedence is plain text → top-level blocks → attachments, so a message that
 * has real text is never re-derived from its block rendering of that same text.
 */
export function slackMessageContent(message: SlackThreadMessage): {
	readonly content: string
	readonly fromAttachment: boolean
} {
	// `markdown` is eve's mrkdwn → GFM rendering of `text`.
	const text = message.markdown.trim() || message.text.trim()
	if (text) return { content: text, fromAttachment: false }

	const blocks = blocksText(message.raw.blocks)
	if (blocks) return { content: blocks, fromAttachment: false }

	const attachments = attachmentsText(message.raw.attachments)
	if (attachments) return { content: attachments, fromAttachment: true }

	return { content: "", fromAttachment: false }
}

function attachmentsText(value: unknown): string {
	return joinLines(
		asArray(value).map((attachment) => {
			if (!isRecord(attachment)) return ""
			const blocks = blocksText(attachment.blocks)
			if (blocks) return joinLines([str(attachment.title), blocks])
			// Legacy attachments carry their body in `text`; `fallback` is the
			// notification-preview one-liner and the last thing worth showing.
			return joinLines([str(attachment.title), str(attachment.text)]) || str(attachment.fallback)
		}),
	)
}

function blocksText(value: unknown): string {
	return joinLines(asArray(value).map(blockText))
}

function blockText(block: unknown): string {
	if (!isRecord(block)) return ""
	switch (block.type) {
		case "divider":
			return ""
		case "header":
		case "section":
			return joinLines([textObject(block.text), ...asArray(block.fields).map(textObject)])
		case "context":
		case "actions":
			return joinLines(asArray(block.elements).map(elementText))
		case "rich_text":
			return joinLines(asArray(block.elements).map(richTextBlockText))
		case "markdown":
			return str(block.text)
		case "image":
			return imageText(block)
		default:
			// Unknown / future block types: sweep every text object out of them
			// rather than dropping content we simply don't have a case for.
			return joinLines(collectTextObjects(block))
	}
}

function elementText(element: unknown): string {
	if (!isRecord(element)) return ""
	if (element.type === "image") return imageText(element)
	const label = textObject(element.text)
	// Buttons: the label alone ("Open in Maple") says nothing the model can act
	// on — the link is the payload.
	const url = str(element.url)
	if (label && url) return `${label}: ${url}`
	return label || url || joinLines(collectTextObjects(element))
}

function richTextBlockText(element: unknown): string {
	if (!isRecord(element)) return ""
	switch (element.type) {
		case "rich_text_list":
			return joinLines(asArray(element.elements).map((item) => `- ${richTextBlockText(item)}`))
		case "rich_text_quote":
			return joinLines(
				inlineText(element.elements)
					.split("\n")
					.map((line) => `> ${line}`),
			)
		default:
			// rich_text_section / rich_text_preformatted, and anything Slack adds.
			return inlineText(element.elements)
	}
}

/** Inline rich-text runs concatenate — they are one paragraph, not a list. */
function inlineText(value: unknown): string {
	return asArray(value)
		.map((element) => {
			if (!isRecord(element)) return ""
			switch (element.type) {
				case "text":
					// Not `str()`: the whitespace between runs is the sentence's own
					// spacing, and trimming each run glues the words together.
					return typeof element.text === "string" ? element.text : ""
				case "link": {
					const label = str(element.text)
					const url = str(element.url)
					return label && label !== url ? `${label} (${url})` : url
				}
				case "user":
					return `<@${str(element.user_id)}>`
				case "usergroup":
					return `<!subteam^${str(element.usergroup_id)}>`
				case "channel":
					return `<#${str(element.channel_id)}>`
				case "emoji":
					return `:${str(element.name)}:`
				case "broadcast":
					return `<!${str(element.range)}>`
				default:
					return ""
			}
		})
		.join("")
		.trim()
}

function imageText(block: Record<string, unknown>): string {
	const alt = str(block.alt_text) || textObject(block.title)
	return alt ? `[image: ${alt}]` : ""
}

/** The text of a Slack `{ type: "mrkdwn" | "plain_text", text }` object. */
function textObject(value: unknown): string {
	return isRecord(value) ? str(value.text) : ""
}

function collectTextObjects(value: unknown, out: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) collectTextObjects(item, out)
		return out
	}
	if (!isRecord(value)) return out
	if ((value.type === "mrkdwn" || value.type === "plain_text") && typeof value.text === "string") {
		const text = value.text.trim()
		if (text) out.push(text)
		return out
	}
	for (const item of Object.values(value)) collectTextObjects(item, out)
	return out
}

function joinLines(parts: readonly string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n")
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
