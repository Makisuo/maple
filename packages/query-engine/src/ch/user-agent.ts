// Bot classification over a raw `User-Agent` string.
//
// The browser SDK records a session for anything that executes the beacon, and
// a crawler is not distinguishable from a visitor by any column we store: the
// SDK's own parser reports Googlebot as Chrome / Android / mobile, because that
// is literally what its UA claims to be. Every number on the Web Analytics page
// counted crawlers as people until this existed — on one org that meant 11,431
// of 11,491 "unique visitors" were Googlebot.
//
// COVERAGE CEILING, and it is a low one: this classifies what the browser SDK
// saw, and a crawler only lands in `session_replays` if it executes JavaScript.
// Measured across the whole platform over 14 days, that is Google, Yandex,
// Applebot and a long tail — and *zero* sessions from GPTBot, ClaudeBot,
// PerplexityBot or OAI-SearchBot, all of which fetch without running the page.
// On the org where this was first investigated those four were 350k+ requests a
// day server-side and 0 browser sessions. So "bot share" here means "share of
// recorded sessions", never "share of traffic", and the UI must not imply the
// latter. Reaching the non-executing crawlers needs `http.user_agent` off
// Server spans, which is a different source and a different feature.

import * as CH from "@maple-dev/clickhouse-builder/expr"

/**
 * What a bot is *for*, which is the axis a site owner acts on: an AI training
 * fetcher is a licensing question, a search crawler is a ranking question, and
 * an SEO tool is somebody else's audit running against your origin.
 */
export type BotCategory = "ai" | "search" | "seo" | "social" | "automation" | "other"

export interface BotSignature {
	/** Case-insensitive substring, matched against the full UA. */
	readonly token: string
	/** Display name. Stable — it becomes a filter value in shareable URLs. */
	readonly name: string
	readonly category: BotCategory
}

/**
 * Ordered, and the order is load-bearing: the first match wins, so a token that
 * is a prefix of another must come after it. `Applebot-Extended` (AI training)
 * before `Applebot` (search) is the case that actually bites — matching the
 * shorter one first would file every training fetch under search.
 *
 * Only names observed in real traffic, plus the well-documented AI fetchers we
 * expect to start seeing. A signature that never matches costs one `position()`
 * per row scanned, so this list is not a place to be exhaustive for its own sake.
 */
export const BOT_SIGNATURES: ReadonlyArray<BotSignature> = [
	// AI — training corpora and answer engines.
	{ token: "GPTBot", name: "GPTBot", category: "ai" },
	{ token: "OAI-SearchBot", name: "OAI-SearchBot", category: "ai" },
	{ token: "ChatGPT-User", name: "ChatGPT-User", category: "ai" },
	{ token: "ClaudeBot", name: "ClaudeBot", category: "ai" },
	{ token: "Claude-User", name: "Claude-User", category: "ai" },
	{ token: "PerplexityBot", name: "PerplexityBot", category: "ai" },
	{ token: "Google-Extended", name: "Google-Extended", category: "ai" },
	{ token: "Applebot-Extended", name: "Applebot-Extended", category: "ai" },
	{ token: "meta-externalagent", name: "Meta AI", category: "ai" },
	{ token: "meta-webindexer", name: "Meta AI", category: "ai" },
	{ token: "Bytespider", name: "Bytespider", category: "ai" },
	{ token: "CCBot", name: "CCBot", category: "ai" },
	{ token: "Amazonbot", name: "Amazonbot", category: "ai" },
	{ token: "DuckAssistBot", name: "DuckAssistBot", category: "ai" },
	// Search — the crawlers that decide whether anyone finds the site.
	{ token: "Googlebot", name: "Googlebot", category: "search" },
	{ token: "GoogleOther", name: "GoogleOther", category: "search" },
	{ token: "AdsBot-Google", name: "AdsBot-Google", category: "search" },
	{ token: "Google-Read-Aloud", name: "Google-Read-Aloud", category: "search" },
	{ token: "bingbot", name: "Bingbot", category: "search" },
	{ token: "YandexBot", name: "YandexBot", category: "search" },
	{ token: "Baiduspider", name: "Baiduspider", category: "search" },
	{ token: "DuckDuckBot", name: "DuckDuckBot", category: "search" },
	{ token: "Applebot", name: "Applebot", category: "search" },
	{ token: "Sogou", name: "Sogou", category: "search" },
	{ token: "SeznamBot", name: "SeznamBot", category: "search" },
	// SEO / site auditing.
	{ token: "AhrefsSiteAudit", name: "AhrefsSiteAudit", category: "seo" },
	{ token: "AhrefsBot", name: "AhrefsBot", category: "seo" },
	{ token: "SemrushBot", name: "SemrushBot", category: "seo" },
	{ token: "DataForSeoBot", name: "DataForSeoBot", category: "seo" },
	{ token: "DotBot", name: "DotBot", category: "seo" },
	{ token: "MJ12bot", name: "MJ12bot", category: "seo" },
	{ token: "Barkrowler", name: "Barkrowler", category: "seo" },
	{ token: "Screaming Frog", name: "Screaming Frog", category: "seo" },
	// Social / link unfurlers.
	{ token: "facebookexternalhit", name: "Facebook", category: "social" },
	{ token: "Twitterbot", name: "Twitterbot", category: "social" },
	{ token: "LinkedInBot", name: "LinkedInBot", category: "social" },
	{ token: "Slackbot", name: "Slackbot", category: "social" },
	{ token: "Discordbot", name: "Discordbot", category: "social" },
	{ token: "TelegramBot", name: "TelegramBot", category: "social" },
	{ token: "Pinterest", name: "Pinterest", category: "social" },
	// Automation — commercial crawlers and uptime checks that are neither
	// indexing nor auditing you.
	{ token: "HubSpot Crawler", name: "HubSpot", category: "automation" },
	{ token: "Stripebot", name: "Stripebot", category: "automation" },
	{ token: "UptimeRobot", name: "UptimeRobot", category: "automation" },
	{ token: "Pingdom", name: "Pingdom", category: "automation" },
	{ token: "StatusCake", name: "StatusCake", category: "automation" },
]

/**
 * Headless browsers, kept apart from {@link BOT_SIGNATURES} because the label is
 * an admission rather than an identification: a `HeadlessChrome` UA is a real
 * browser engine driven by something that did not say who it is. It is the
 * second most common non-human agent on the platform, and it lands entirely on
 * public marketing hosts rather than on app hosts — so it reads as scrapers and
 * monitors, not as customers' own end-to-end suites. Named `Headless browser`,
 * never folded into a vendor's row.
 */
const HEADLESS_TOKEN = "Headless"

/**
 * Generic fallbacks for the unnamed tail, which is most distinct UAs and very
 * few sessions.
 *
 * Every token here carries a delimiter or a scheme on purpose. A bare `bot`
 * substring matches `CUBOT`, an Android phone brand that appears in ordinary
 * mobile UAs, and would file those visitors as crawlers. Requiring `bot/`,
 * `bot;` or `bot)` keeps the `Name/version` and `(compatible; Name; +url)`
 * conventions that real crawlers follow while missing the phone. Checked
 * against 14 days of production UAs: the tail these catch is 100% genuine bots
 * — Baiduspider-render, DuckDuckBot, Sogou web spider, PromptingBot,
 * FossickBot, OKX-dolphin-crawler — with no human UA caught.
 */
const GENERIC_BOT_TOKENS: ReadonlyArray<string> = ["bot/", "bot;", "bot)", "crawler", "spider", "+http"]

/** Every needle, in one array: signatures, headless, and the generic tail. */
const ALL_BOT_TOKENS: ReadonlyArray<string> = [
	...BOT_SIGNATURES.map((signature) => signature.token),
	HEADLESS_TOKEN,
	...GENERIC_BOT_TOKENS,
]

/**
 * True when the UA is anything other than a person's browser.
 *
 * One `multiSearchAnyCaseInsensitive` over the whole needle set rather than the
 * OR of ~50 `positionCaseInsensitive(...) > 0` calls it started as. This is what
 * the `traffic` filter compiles into, so it sits in the WHERE of every query the
 * page runs and is evaluated per scanned row: ClickHouse builds one automaton
 * over the needles and scans the UA once, instead of walking it once per
 * signature. It also keeps the emitted SQL readable, which the fifty-deep nest
 * of parentheses very much was not.
 */
export function isBotCond(userAgent: CH.Expr<string>): CH.Condition {
	return CH.multiSearchAnyCaseInsensitive(userAgent, ALL_BOT_TOKENS)
}
