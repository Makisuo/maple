// Single source of truth for docs navigation ordering + the header category bar.
// The sidebar (DocsSidebar), mobile nav (DocsMobileNav), index page, and the
// header category bar (DocsCategoryNav) all read from here so group order and
// icons never drift apart.

export const SDK_OVERVIEW_SLUG = "sdks/overview"

/** Order of non-SDK ("universal") doc groups in the sidebar + index page. */
export const UNIVERSAL_GROUP_ORDER = [
	"Getting Started",
	"Concepts",
	"Session Replay",
	"Infrastructure",
	"Integrations",
	"Alerting",
] as const

/** Order of SDK-scoped groups (Effect SDK pages). */
export const SDK_GROUP_ORDER = ["Effect SDK", "Platforms", "Instrumentation"] as const

/**
 * Universal groups omitted from the sidebar's "General" section when a language
 * (SDK) is selected — e.g. "Getting Started" is redundant on a language page.
 * They remain reachable via the header category bar and on non-SDK pages.
 */
export const SDK_HIDDEN_UNIVERSAL_GROUPS = new Set<string>(["Getting Started"])

export type HeaderNavItem = {
	/** Display label (also the icon id for `kind: "group"`). */
	key: string
	icon: string
	kind: "group" | "sdks"
}

/**
 * Left-to-right order of the header category bar. Each `group` entry links to
 * the first page of its universal group; the `sdks` entry links to the SDK
 * overview. `icon` maps to a glyph in DocsCategoryIcon.
 */
export const HEADER_NAV: HeaderNavItem[] = [
	{ key: "Getting Started", icon: "Getting Started", kind: "group" },
	{ key: "SDKs", icon: "sdks", kind: "sdks" },
	{ key: "Concepts", icon: "Concepts", kind: "group" },
	{ key: "Session Replay", icon: "Session Replay", kind: "group" },
	{ key: "Infrastructure", icon: "Infrastructure", kind: "group" },
	{ key: "Integrations", icon: "Integrations", kind: "group" },
	{ key: "Alerting", icon: "Alerting", kind: "group" },
]

/** Group names (and the synthetic `sdks` key) that have a DocsCategoryIcon glyph. */
const CATEGORY_ICON_KEYS = new Set<string>([
	"Getting Started",
	"Concepts",
	"Session Replay",
	"Infrastructure",
	"Integrations",
	"Alerting",
	"sdks",
])

export const hasCategoryIcon = (name: string): boolean => CATEGORY_ICON_KEYS.has(name)
