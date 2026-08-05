/**
 * Rendering Slack messages as model-visible background context.
 *
 * Shared by the two context surfaces, which differ only in which messages they
 * collect:
 *
 *   - `#lib/thread-context.js` — the thread the bot was tagged in
 *     (`conversations.replies`), injected on every turn.
 *   - `#lib/channel-context.js` — the channel messages that preceded a
 *     channel-level mention (`conversations.history`), injected when there is
 *     no thread to carry context, and on demand through the
 *     `read_channel_history` tool.
 *
 * Both need the same two things eve's own renderer does not do: content that
 * falls back to blocks and attachments (Maple's alert cards carry no top-level
 * `text` at all — see `#lib/thread-context.js` for that story) and speaker
 * attribution that tells this agent apart from every other bot in the channel.
 *
 * The envelope is eve's: `<slack_thread_context>` / `<slack_message>`, so the
 * model's view keeps the shape it already knows.
 */

/** Who posted a context message, from the model's point of view. */
export type ContextSenderType = "agent" | "bot" | "unknown" | "user"

export interface ContextFormatOptions {
	/**
	 * This workspace's bot user id (`#lib/bot-identity.js`). Distinguishes the
	 * agent's own replies from every other bot in the channel. When absent we
	 * fall back to eve's coarser "any bot is me".
	 */
	readonly botUserId?: string | undefined
	/**
	 * Hard cap on one message's rendered content, in characters. Off by default;
	 * `#lib/channel-context.js` sets it because channel history is unbounded in
	 * a way a thread the bot was invited into is not.
	 */
	readonly maxContentChars?: number | undefined
}

/**
 * The slice of a Slack message this renderer reads.
 *
 * eve's `SlackThreadMessage` satisfies it structurally, and so does a raw
 * `conversations.history` message once mapped (`#lib/channel-context.js`) —
 * which is the point: the two APIs return the same message with different
 * field coverage, not two different things.
 */
export interface RenderableSlackMessage {
	readonly text?: string | undefined
	/** eve's mrkdwn → GFM rendering of `text`, when the source has one. */
	readonly markdown?: string | undefined
	readonly user?: string | undefined
	readonly botId?: string | undefined
	readonly ts?: string | undefined
	readonly threadTs?: string | undefined
	/** eve's coarse "any bot is me"; only consulted when `botUserId` is unknown. */
	readonly isMe?: boolean | undefined
	readonly raw: Record<string, unknown>
}

/**
 * Renders messages inside a named context envelope, or `undefined` when there
 * are none.
 */
export function formatContextBlock(
	tag: string,
	messages: readonly RenderableSlackMessage[],
	options: ContextFormatOptions = {},
): string | undefined {
	if (messages.length === 0) return undefined
	return [
		`<${tag}>`,
		...messages.map((message) => formatContextMessage(message, options)),
		`</${tag}>`,
	].join("\n")
}

/** One `<slack_message>` element: attribution, timestamps, content. */
export function formatContextMessage(
	message: RenderableSlackMessage,
	options: ContextFormatOptions = {},
): string {
	const { content, fromAttachment } = slackMessageContent(message)
	const senderId = message.user ?? message.botId
	return [
		"<slack_message>",
		`sender_type: ${senderType(message, fromAttachment, options)}`,
		...(senderId ? [`sender_id: ${senderId}`] : []),
		...(message.threadTs ? [`thread_ts: ${message.threadTs}`] : []),
		...(message.ts ? [`message_ts: ${message.ts}`] : []),
		"<content>",
		truncateContent(content, options.maxContentChars),
		"</content>",
		"</slack_message>",
	].join("\n")
}

export function senderType(
	message: RenderableSlackMessage,
	fromAttachment: boolean,
	options: ContextFormatOptions,
): ContextSenderType {
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
 * The readable content of a Slack message, and whether it had to be recovered
 * from an attachment (Slack's legacy surface, which is where Block Kit cards
 * with a color bar live — Maple alerts among them).
 *
 * Precedence is plain text → top-level blocks → attachments, so a message that
 * has real text is never re-derived from its block rendering of that same text.
 */
export function slackMessageContent(message: RenderableSlackMessage): {
	readonly content: string
	readonly fromAttachment: boolean
} {
	// `markdown` is eve's mrkdwn → GFM rendering of `text`. Raw Slack API
	// messages have no such field, so their `text` is mrkdwn — readable, just
	// not GFM.
	const text = (message.markdown ?? "").trim() || (message.text ?? "").trim()
	if (text) return { content: text, fromAttachment: false }

	const blocks = blocksText(message.raw.blocks)
	if (blocks) return { content: blocks, fromAttachment: false }

	const attachments = attachmentsText(message.raw.attachments)
	if (attachments) return { content: attachments, fromAttachment: true }

	return { content: "", fromAttachment: false }
}

/**
 * Clips over-long content at a character budget. Kept crude on purpose: the
 * point is a ceiling on what one pasted log dump can cost the turn, not a
 * faithful summary.
 */
function truncateContent(content: string, maxChars: number | undefined): string {
	if (maxChars === undefined || content.length <= maxChars) return content
	return `${content.slice(0, maxChars)}\n[truncated]`
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
