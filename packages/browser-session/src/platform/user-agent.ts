interface ParsedUserAgent {
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
}

// The UA is constant for a page's lifetime but every metadata row re-parses it
// — including the 60s heartbeats of a tab left open all day. One slot is enough:
// callers pass `navigator.userAgent` and nothing else.
let memo: { ua: string; parsed: ParsedUserAgent } | undefined

/** Best-effort UA parse — enough to populate filterable session facets. */
export function parseUserAgent(ua: string): ParsedUserAgent {
	if (memo?.ua === ua) return memo.parsed
	const parsed = parse(ua)
	memo = { parsed, ua }
	return parsed
}

function parse(ua: string): ParsedUserAgent {
	const browserName = /edg/i.test(ua)
		? "Edge"
		: /opr|opera/i.test(ua)
			? "Opera"
			: /chrome|crios/i.test(ua)
				? "Chrome"
				: /firefox|fxios/i.test(ua)
					? "Firefox"
					: /safari/i.test(ua)
						? "Safari"
						: "Unknown"
	// iOS UAs contain "like Mac OS X", so test iOS before macOS
	const osName = /windows/i.test(ua)
		? "Windows"
		: /iphone|ipad|ios/i.test(ua)
			? "iOS"
			: /mac os|macintosh/i.test(ua)
				? "macOS"
				: /android/i.test(ua)
					? "Android"
					: /linux/i.test(ua)
						? "Linux"
						: "Unknown"
	const deviceType = /mobile|iphone|android.*mobile/i.test(ua)
		? "mobile"
		: /ipad|tablet/i.test(ua)
			? "tablet"
			: "desktop"
	return { browserName, osName, deviceType }
}

/**
 * Crawler tokens, every one carrying a delimiter or a scheme on purpose.
 *
 * A bare `bot` substring matches `CUBOT`, an Android phone brand that appears in
 * ordinary mobile UAs, and would file those visitors as crawlers. Requiring
 * `bot/`, `bot;` or `bot)` keeps the `Name/version` and `(compatible; Name;
 * +url)` conventions real crawlers follow while missing the phone. This mirrors
 * the generic tail of the server-side classifier in
 * `@maple/query-engine`'s `user-agent.ts`, deliberately without the ~50 named
 * signatures: every one of those ends in a token already listed here, and the
 * list ships in a size-budgeted bundle to customers.
 */
const BOT_TOKENS = ["bot/", "bot;", "bot)", "crawler", "spider", "+http", "headless"]

/**
 * Whether the UA is a crawler rather than a person.
 *
 * Used to route crawlers to a metadata-only session: they still appear in Web
 * Analytics — the server-side classifier is what labels them there — but they do
 * not download rrweb or upload replay chunks. Crawlers execute the beacon and
 * then tear the page down mid-flush, which produced the large majority of all
 * corrupt replay-chunk uploads, and every chunk they did manage to upload spent
 * a customer's replay quota on a session nobody will ever watch.
 *
 * Deliberately does not consult `navigator.webdriver`: it is set by Playwright
 * and Puppeteer, so keying on it would silently stop recording in customers'
 * own end-to-end suites — exactly the runs where they check replay works.
 */
export function isLikelyBot(ua: string): boolean {
	const lower = ua.toLowerCase()
	return BOT_TOKENS.some((token) => lower.includes(token))
}
