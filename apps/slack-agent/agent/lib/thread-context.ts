import { loadThreadContextMessages, type SlackThread, type SlackThreadMessage } from "eve/channels/slack"
import { formatContextBlock, type ContextFormatOptions } from "./slack-context-format.js"

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
 * So we render context ourselves (`#lib/slack-context-format.js`): same
 * `<slack_thread_context>` / `<slack_message>` envelope eve uses (the model's
 * view is unchanged in shape), but content falls back to blocks and attachments
 * when `text` is empty, and the whole thread is included — the `thread-root`
 * boundary. Full-thread is also what makes this survive a lost session: eve
 * sessions are keyed `channelId:threadTs` and a Railway redeploy can drop the
 * history that an incremental boundary silently assumes is still there.
 *
 * Wired in `#channels/slack.js` through `onAppMention` / `onDirectMessage`,
 * which return these strings as the mention result's `context`. A mention that
 * is not itself in a thread has no thread context by construction — that case
 * belongs to `#lib/channel-context.js`.
 *
 * Two bounds worth knowing: every turn re-injects the transcript (so a long
 * thread pays for its history once per mention), and eve's `thread.refresh()`
 * fetches one oldest-first page of 50 replies, so past 50 the tail is the part
 * that goes missing. Alert threads are short; revisit if that stops holding.
 *
 * Loading and rendering are separate steps rather than one `loadThreadContext`
 * call because this transcript now has a second reader: `confirmThreadFollowUp`
 * (`#lib/thread-follow-up.js`) decides from these same messages whether an
 * optimistically promoted follow-up becomes a turn at all. Fetching the thread
 * twice for two questions about the same thread would be the easy mistake here
 * — and one of them would be answering about a slightly different thread.
 */

export type ThreadContextOptions = ContextFormatOptions

/**
 * Loads the thread the triggering message belongs to, oldest-first and without
 * the triggering message itself. Returns `[]` for a thread root (there is
 * nothing before it) and `null` when Slack could not be read at all — callers
 * need those apart: "empty thread" is an answer, "no answer" is not.
 *
 * Never throws: eve drops the whole mention when an `onAppMention` handler
 * throws, and losing the reply entirely is far worse than losing its context.
 */
export async function loadThreadMessages(
	thread: Pick<SlackThread, "recentMessages" | "refresh">,
	message: { readonly threadTs: string; readonly ts: string },
): Promise<readonly SlackThreadMessage[] | null> {
	try {
		return await loadThreadContextMessages(thread, message, { since: "thread-root" })
	} catch (error) {
		console.warn("[slack-thread-context] Failed to load thread context; dispatching without it.", error)
		return null
	}
}

/**
 * Renders thread messages as attributed background context, or `undefined`
 * when there are none. Mirrors eve's `formatSlackThreadContext` envelope.
 */
export function formatThreadContext(
	messages: readonly SlackThreadMessage[],
	options: ThreadContextOptions = {},
): string | undefined {
	return formatContextBlock("slack_thread_context", messages, options)
}
