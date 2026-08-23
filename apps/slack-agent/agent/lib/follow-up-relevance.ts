import { generateText } from "ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { SlackThreadMessage } from "eve/channels/slack"
import { formatContextBlock, formatContextMessage, type RenderableSlackMessage } from "./slack-context-format.js"

/**
 * Relevance gate for promoted thread follow-ups: should the bot answer this
 * reply at all?
 *
 * `#lib/thread-follow-up.js` answers a *mechanical* question — is the bot part
 * of this thread — and once it is, every human reply in the thread dispatched a
 * full agent turn. In an incident thread where two engineers are talking to
 * each other, that meant the bot answered every one of their messages: a cost
 * amplifier and, worse, a bot that butts into conversations that were never
 * addressed to it.
 *
 * So an engaged follow-up now has to pass a second, *semantic* question before
 * it becomes a turn: given the thread, is this reply directed at the bot or
 * does it expect the bot to act? A small classifier call decides — one model
 * round-trip with no tools, orders of magnitude cheaper than the agent turn it
 * gates. Real @mentions and DMs never come here: an explicit address is the
 * user answering this question themselves.
 *
 * The gate runs on the dispatch path (post-200, inside eve's `waitUntil`), so
 * it spends nothing from Slack's webhook budget, and it runs *before* the
 * `:eyes:` ack and the typing indicator — a message the bot decides not to
 * answer gets no reaction at all, exactly like one it was never going to
 * answer. A pass is silent by design: the bot staying out of a conversation
 * between humans must not announce itself.
 *
 * **It fails open**, same asymmetry as `confirmThreadFollowUp`: when the
 * classifier errors, times out, or answers gibberish, the follow-up is
 * answered. A wrong drop loses a user's message with nothing on screen to
 * explain it; a wrong answer costs one turn in a thread the bot was already
 * part of. The tiebreak inside the prompt leans the same way.
 */

/**
 * Bound on the classifier round-trip. Past it the reply is answered without a
 * verdict (fail open) — a stalled gate must not turn into a silent drop, and
 * the turn behind it is slower than this anyway.
 */
const RELEVANCE_TIMEOUT_MS = 10_000

/**
 * How much thread the classifier sees. The addressing question is local — who
 * is this reply talking to — so the recent tail decides it; the full
 * transcript belongs to the turn, not the gate.
 */
const RELEVANCE_THREAD_TAIL = 12
const RELEVANCE_MAX_CONTENT_CHARS = 600

export type FollowUpRelevanceDecision =
	| {
			readonly respond: true
			readonly reason: "model-respond" | "classifier-error" | "unparseable-verdict"
	  }
	| { readonly respond: false; readonly reason: "model-pass" }

export interface FollowUpRelevanceInput {
	/** The reply being judged, as the handler received it. */
	readonly reply: RenderableSlackMessage
	/**
	 * The thread the handler already loaded for turn context (oldest-first,
	 * without the reply itself), or `null` when Slack could not be read.
	 */
	readonly threadMessages: readonly SlackThreadMessage[] | null
	/** The workspace's bot user id. */
	readonly botUserId: string
}

export interface FollowUpRelevanceDeps {
	/** One classifier completion. The default calls OpenRouter via the AI SDK. */
	readonly complete: (input: {
		readonly system: string
		readonly prompt: string
		readonly signal: AbortSignal
	}) => Promise<string>
}

/**
 * The gate model is separately configurable because the job wants a small,
 * fast model, not the agent's; unset, it follows the agent's model rather
 * than silently using a third one. The literal fallback matches
 * `agent/agent.ts` — keep them in sync.
 */
function gateModelId(): string {
	return process.env.OPENROUTER_GATE_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna"
}

/**
 * Lazily built so importing this module never requires the key; same
 * referer/title identity as `agent/agent.ts` on purpose — a different one
 * would mint a second OpenRouter app entry and split the rankings.
 */
let defaultDeps: FollowUpRelevanceDeps | undefined

function buildDefaultDeps(): FollowUpRelevanceDeps {
	const openrouter = createOpenRouter({
		apiKey: process.env.OPENROUTER_API_KEY ?? "",
		appUrl: "https://maple.dev",
		appName: "Maple",
		extraBody: { trace: { trace_name: "slack" } },
	})
	const model = openrouter(gateModelId())
	return {
		complete: async ({ system, prompt, signal }) => {
			const result = await generateText({ model, system, prompt, abortSignal: signal })
			return result.text
		},
	}
}

export function relevanceSystemPrompt(botUserId: string): string {
	return [
		`You decide whether Maple AI, an observability assistant in a Slack thread, should reply to the newest message. The assistant's Slack user id is <@${botUserId}>. Users in a thread the assistant is active in can talk to it without @-mentioning it, so the absence of a mention means nothing.`,
		"",
		"Answer RESPOND when the message is directed at the assistant or expects it to act: a question or request it can serve, a follow-up, correction, or new instruction about work it has been doing in this thread, an answer to something the assistant asked, criticism of its output, or thanks and praise clearly meant for the assistant. Criticism counts however it is dressed — a complaint, mockery, or a joke at the assistant's expense (\"this chart is useless lol\") is a defect report and gets a reply. A thank-you meant for the assistant gets a reply too — ghosting it reads wrong.",
		"",
		"Answer PASS when the message expects nothing from the assistant: people talking to each other, a message explicitly addressed to another person, status updates and side conversation, or a bare acknowledgment (\"ok\", \"done\", an emoji) that needs no reply. Thanks and praise are PASS when they are meant for another person or for no one in particular — butting into someone else's thank-you is worse than staying quiet. Do not file criticism of the assistant's work under banter or acknowledgment — that is RESPOND.",
		"",
		"When genuinely torn, answer RESPOND — silently dropping a message meant for the assistant is worse than replying once too often.",
		"",
		"Your entire answer must be exactly one word: RESPOND or PASS.",
	].join("\n")
}

/** The user-message half of the classifier prompt. Pure; exported for tests. */
export function relevancePrompt(input: FollowUpRelevanceInput): string {
	const tail = (input.threadMessages ?? []).slice(-RELEVANCE_THREAD_TAIL)
	const transcript = formatContextBlock("slack_thread_context", tail, {
		botUserId: input.botUserId,
		maxContentChars: RELEVANCE_MAX_CONTENT_CHARS,
	})
	return [
		transcript ??
			(input.threadMessages === null
				? "(The thread could not be loaded; judge from the reply alone.)"
				: "(No earlier thread messages.)"),
		"",
		"Newest message:",
		formatContextMessage(input.reply, {
			botUserId: input.botUserId,
			maxContentChars: RELEVANCE_MAX_CONTENT_CHARS,
		}),
	].join("\n")
}

/**
 * First RESPOND/PASS token in the model's answer, or `null` when there is no
 * unambiguous verdict — reasoning models sometimes wrap the word, so this
 * scans rather than string-compares, but an answer containing both is no
 * answer.
 */
export function parseRelevanceVerdict(text: string): "respond" | "pass" | null {
	const respond = /\bRESPOND\b/i.test(text)
	const pass = /\bPASS\b/i.test(text)
	if (respond === pass) return null
	return respond ? "respond" : "pass"
}

/**
 * Judges one promoted follow-up. Never throws — every failure mode is a
 * fail-open `respond: true` with a reason the caller can log.
 */
export async function judgeFollowUpRelevance(
	input: FollowUpRelevanceInput,
	deps?: FollowUpRelevanceDeps,
): Promise<FollowUpRelevanceDecision> {
	const { complete } = deps ?? (defaultDeps ??= buildDefaultDeps())
	let answer: string
	try {
		answer = await complete({
			system: relevanceSystemPrompt(input.botUserId),
			prompt: relevancePrompt(input),
			signal: AbortSignal.timeout(RELEVANCE_TIMEOUT_MS),
		})
	} catch (error) {
		console.warn("[follow-up-relevance] Classifier call failed; answering the follow-up.", error)
		return { respond: true, reason: "classifier-error" }
	}

	const verdict = parseRelevanceVerdict(answer)
	if (verdict === null) {
		console.warn(
			`[follow-up-relevance] Unparseable verdict ${JSON.stringify(answer.slice(0, 200))}; answering the follow-up.`,
		)
		return { respond: true, reason: "unparseable-verdict" }
	}
	return verdict === "respond"
		? { respond: true, reason: "model-respond" }
		: { respond: false, reason: "model-pass" }
}

/** Test-only: resets the memoized default deps. */
export function resetFollowUpRelevanceStateForTests(): void {
	defaultDeps = undefined
}
