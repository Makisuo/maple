// Single source of truth for docs navigation ordering + the header category bar.
// The sidebar (DocsSidebar), the index page, prev/next, search and the header
// category bar (DocsCategoryNav) all read from here so group order and icons
// never drift apart. Pure data — client islands import it.

/** Doc groups in sidebar order. Every doc's `group` must appear here. */
export const GROUP_ORDER = [
	"Getting Started",
	"Instrumentation",
	"Concepts",
	"Session Replay",
	"Infrastructure",
	"Integrations",
	"Alerting",
	"Local Mode",
	"Reference",
] as const

export type DocGroup = (typeof GROUP_ORDER)[number]

export const isDocGroup = (group: string): group is DocGroup =>
	GROUP_ORDER.some((known) => known === group)

export const groupRank = (group: string): number => {
	const i = GROUP_ORDER.findIndex((known) => known === group)
	return i === -1 ? GROUP_ORDER.length : i
}

/** Slug of the instrumentation overview — the "SDKs" entry point everywhere. */
export const INSTRUMENTATION_SLUG = "instrumentation"

/**
 * Left-to-right order of the header category bar. Each entry links to the
 * first page of its group; the group name doubles as the DocsCategoryIcon id.
 */
export const HEADER_NAV: readonly DocGroup[] = [
	"Getting Started",
	"Instrumentation",
	"Concepts",
	"Session Replay",
	"Infrastructure",
	"Integrations",
	"Alerting",
	"Local Mode",
	"Reference",
]

/** One-line blurb per group for the docs index cards. */
export const GROUP_BLURBS = {
	"Getting Started": "What Maple is and the three steps to first data.",
	Instrumentation: "Setup guides for every language, framework and runtime.",
	Concepts: "How Maple reads OpenTelemetry data and what it expects from yours.",
	"Session Replay": "Record browser sessions and product events alongside traces.",
	Infrastructure: "Stream host, container and cluster metrics next to your services.",
	Integrations: "Pull metrics and context from the services around your app.",
	Alerting: "Route alerts to Slack, PagerDuty, Discord, Telegram or a webhook.",
	"Local Mode": "The whole product as one binary on your machine.",
	Reference: "The REST API and the MCP server for AI agents.",
} satisfies Record<DocGroup, string>

export const groupBlurb = (group: string): string => (isDocGroup(group) ? GROUP_BLURBS[group] : "")
