import { defineTool } from "eve/tools"
import { z } from "zod"
import { ALLOWED_REACTION_EMOJIS, reactToTriggeringMessage } from "#lib/reaction.js"

/**
 * Lets the agent swap the automatic `:eyes:` acknowledgement on the message
 * that triggered this turn for a contextual emoji reaction.
 *
 * The emoji is a closed enum (see ALLOWED_REACTION_EMOJIS): standard Slack
 * names only, so `reactions.add` can never fail on an unknown name, and
 * injected text in telemetry can at worst pick a different list entry — never
 * spell an arbitrary reaction.
 *
 * THE FILENAME IS THE TOOL NAME (see render_chart.ts for the contract);
 * behaviour lives in `agent/lib/reaction.ts`, this file stays the adapter
 * from eve's tool contract to it.
 */

const inputSchema = z.object({
	emoji: z
		.enum(ALLOWED_REACTION_EMOJIS)
		.describe(
			"Slack emoji name (no colons) to react with. Pick the one that best matches " +
				"the user's message and your findings — e.g. raised_hands for thanks, " +
				"white_check_mark for a confirmed fix, rotating_light for an active incident, " +
				"mag while nothing conclusive turned up.",
		),
})

export default defineTool({
	description:
		"React to the user's triggering Slack message with an emoji, replacing the " +
		"automatic :eyes: acknowledgement. Use it at most once per message, and only " +
		"when a reaction adds real signal — acknowledging thanks or praise, marking a " +
		"confirmed finding, flagging something alarming. Most messages need no " +
		"reaction. Never mention the reaction in your reply.",
	inputSchema,
	async execute(input, ctx) {
		return reactToTriggeringMessage(input.emoji, {
			id: ctx.session.id,
			attributes: ctx.session.auth.current?.attributes ?? {},
		})
	},
})
