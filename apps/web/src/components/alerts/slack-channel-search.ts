/**
 * Ranking for the Slack channel picker.
 *
 * The picker holds every channel a workspace has (tens of thousands is a real
 * shape), so search has to be both forgiving — people type `depaler` for
 * `deploy-alerts` — and cheap enough to run on every keystroke over the whole
 * list. Scoring is a single pass per channel with no allocation beyond the
 * lowercased name, and the caller renders only the top {@link CHANNEL_RESULT_LIMIT}.
 */

/** The shape this module needs; the wire type `V2SlackChannel` is a superset. */
export interface RankableChannel {
	readonly name: string
	readonly is_member: boolean
}

/** How many rows the picker renders. Beyond this the list is noise, not choice. */
export const CHANNEL_RESULT_LIMIT = 50

/**
 * Slack channel names are already lowercase, but the list also carries display
 * names from older workspaces, and users type `#` out of habit. Normalise both
 * sides the same way so neither can miss a match.
 */
const normalize = (value: string): string => value.trim().toLowerCase().replace(/^#+/, "")

/** Characters that start a new "word" inside a channel name. */
const isBoundary = (char: string): boolean => char === "-" || char === "_" || char === "." || char === " "

/**
 * Subsequence match: every query char appears in order. Returns a penalty
 * proportional to how scattered the match is (0 = contiguous), or `null` when
 * the chars don't all appear.
 */
const subsequencePenalty = (name: string, query: string): number | null => {
	let nameIndex = 0
	let gaps = 0
	let firstIndex = -1
	for (const char of query) {
		const found = name.indexOf(char, nameIndex)
		if (found === -1) return null
		if (firstIndex === -1) firstIndex = found
		else gaps += found - nameIndex
		nameIndex = found + 1
	}
	return firstIndex + gaps
}

/**
 * Score a channel name against a query. Higher is better; `null` means no match.
 *
 * The tiers are deliberately far apart so a weaker match can never outrank a
 * stronger one on length alone: exact > prefix > word-boundary prefix >
 * substring > subsequence. Within a tier, earlier and shorter wins.
 */
export const scoreChannelName = (name: string, query: string): number | null => {
	const haystack = normalize(name)
	const needle = normalize(query)
	if (needle.length === 0) return 0
	if (haystack === needle) return 10_000
	if (haystack.startsWith(needle)) return 9_000 - Math.min(haystack.length, 500)

	const index = haystack.indexOf(needle)
	if (index !== -1) {
		// `deploy-alerts` should surface for `alerts` ahead of `stale-alerting`:
		// a match that starts a word beats one that lands mid-word.
		const atWordStart = isBoundary(haystack[index - 1] ?? "")
		const base = atWordStart ? 8_000 : 7_000
		return base - Math.min(index, 400) - Math.min(haystack.length, 500) / 100
	}

	const penalty = subsequencePenalty(haystack, needle)
	if (penalty === null) return null
	return 6_000 - Math.min(penalty, 500) - Math.min(haystack.length, 500) / 100
}

/**
 * Filter + rank + cap the channel list for a query.
 *
 * With an empty query this is the "just opened the picker" view: channels the
 * bot is already in first (those are the ones that will actually work without
 * an `/invite`), then alphabetical. Ties at equal score resolve the same way,
 * so ranking never reshuffles arbitrarily between keystrokes.
 */
export const rankChannels = <T extends RankableChannel>(
	channels: ReadonlyArray<T>,
	query: string,
	limit: number = CHANNEL_RESULT_LIMIT,
): Array<T> => {
	const scored: Array<{ channel: T; score: number }> = []
	for (const channel of channels) {
		const score = scoreChannelName(channel.name, query)
		if (score !== null) scored.push({ channel, score })
	}
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		if (a.channel.is_member !== b.channel.is_member) return a.channel.is_member ? -1 : 1
		return a.channel.name.localeCompare(b.channel.name)
	})
	return scored.slice(0, Math.max(limit, 0)).map((entry) => entry.channel)
}
