import { defineTool } from "eve/tools"
import { z } from "zod"
import {
	CHANNEL_CONTEXT_MAX_MESSAGES,
	CHANNEL_CONTEXT_MESSAGE_COUNT,
	readChannelHistory,
} from "#lib/channel-context.js"

/**
 * Lets the agent read the top-level messages posted in this Slack channel just
 * before the message it is answering — the alert cards, the incident chatter,
 * whatever the user is pointing at with "this".
 *
 * A threadless mention gets those messages injected eagerly (see
 * `agent/lib/channel-context.ts`), so this tool is for the other case: a
 * mention *inside* a thread whose subject clearly started outside it. Thread
 * replies are not returned — `conversations.history` is top-level only — so it
 * never re-reads what `<slack_thread_context>` already carries.
 *
 * THE FILENAME IS THE TOOL NAME (see render_chart.ts for the contract);
 * behaviour lives in `agent/lib/channel-context.ts`, this file stays the
 * adapter from eve's tool contract to it.
 */

const inputSchema = z.object({
	limit: z
		.number()
		.int()
		.min(1)
		.max(CHANNEL_CONTEXT_MAX_MESSAGES)
		.optional()
		.describe(
			`How many messages back to read. Defaults to ${CHANNEL_CONTEXT_MESSAGE_COUNT}; ` +
				`${CHANNEL_CONTEXT_MAX_MESSAGES} is the maximum Slack returns in one call.`,
		),
})

export default defineTool({
	description:
		"Read the last few top-level messages posted in this Slack channel before the " +
		"message you are answering, with Maple alert cards rendered in full. Call it " +
		"whenever the user refers to something that is not in <slack_thread_context> — " +
		'"this alert", "what happened", "the ship is sinking", a bare "why?" — or when ' +
		"the thread you are in cannot explain what the user is reacting to. Read the " +
		"result before answering, and never ask the user to restate something it " +
		"already contains. Replies inside other threads are not returned, so a single " +
		"call is enough — do not call it repeatedly for the same question.",
	inputSchema,
	async execute(input, ctx) {
		return readChannelHistory(input.limit ?? CHANNEL_CONTEXT_MESSAGE_COUNT, {
			id: ctx.session.id,
			attributes: ctx.session.auth.current?.attributes ?? {},
		})
	},
})
