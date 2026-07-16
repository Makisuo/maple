import {
	detectPlatform,
	KEY_DISPLAY_SYMBOLS,
	LINUX_MODIFIER_LABELS,
	MAC_MODIFIER_SYMBOLS,
	parseHotkey,
	type ParsedHotkey,
	rawHotkeyToParsedHotkey,
	type RegisterableHotkey,
	WINDOWS_MODIFIER_LABELS,
} from "@tanstack/react-hotkeys"

export const SHORTCUT_GROUPS = [
	"Global",
	"Search & Time",
	"Lists & Tables",
	"Session Replay",
	"Chat",
] as const

type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]

export interface ShortcutDef {
	/** Primary combo in TanStack Hotkeys syntax (type-safe string or RawHotkey object). */
	combo: RegisterableHotkey
	/** Extra combos that trigger the same action (e.g. ArrowDown alongside J). */
	aliases?: ReadonlyArray<RegisterableHotkey>
	label: string
	group: ShortcutGroup
	/** Keep firing while a modal dialog is open (default: skipped via isDialogOpen guard). */
	allowWhenDialogOpen?: boolean
	/** Override the library's preventDefault (default true). */
	preventDefault?: boolean
	/** Override the library's ignoreInputs default (true for single keys, false for Mod combos / Escape). */
	ignoreInputs?: boolean
	/** Display tokens override for the help dialog (e.g. ["?"] instead of ["⇧", "/"]). */
	display?: ReadonlyArray<string>
}

/**
 * Single source of truth for app keyboard shortcuts. Components register
 * handlers via useAppHotkey(id, ...) and the keyboard-shortcuts help dialog
 * renders this table, so the two can never drift apart.
 */
const SHORTCUTS = {
	"palette.open": {
		combo: "Mod+K",
		label: "Open command palette",
		group: "Global",
		allowWhenDialogOpen: true,
	},
	"help.shortcuts": {
		combo: { key: "?", shift: true },
		label: "Show keyboard shortcuts",
		group: "Global",
		display: ["?"],
	},
	"theme.toggle": {
		combo: "T",
		label: "Toggle dark / light mode",
		group: "Global",
	},
	"search.focus": {
		combo: "/",
		label: "Focus search",
		group: "Search & Time",
	},
	"time.open": {
		combo: "D",
		label: "Open time range picker",
		group: "Search & Time",
	},
	"filter.advanced": {
		combo: "F",
		label: "Open advanced filter (traces)",
		group: "Search & Time",
	},
	"list.next": {
		combo: "J",
		aliases: ["ArrowDown"],
		label: "Next row",
		group: "Lists & Tables",
	},
	"list.prev": {
		combo: "K",
		aliases: ["ArrowUp"],
		label: "Previous row",
		group: "Lists & Tables",
	},
	"list.open": {
		combo: "Enter",
		label: "Open focused row",
		group: "Lists & Tables",
	},
	"list.select": {
		combo: "X",
		label: "Toggle selection (issues)",
		group: "Lists & Tables",
	},
	"list.clear": {
		combo: "Escape",
		label: "Clear focus / selection",
		group: "Lists & Tables",
		ignoreInputs: true,
		preventDefault: false,
	},
	"replay.playPause": {
		combo: "Space",
		label: "Play / pause replay",
		group: "Session Replay",
	},
	"replay.seekBack": {
		combo: "ArrowLeft",
		label: "Seek back 5s",
		group: "Session Replay",
	},
	"replay.seekForward": {
		combo: "ArrowRight",
		label: "Seek forward 5s",
		group: "Session Replay",
	},
	"chat.quickOpen": {
		combo: "C",
		label: "Open AI chat",
		group: "Chat",
	},
	"chat.newTab": {
		combo: "Mod+Shift+O",
		label: "New chat tab",
		group: "Chat",
	},
} as const satisfies Record<string, ShortcutDef>

export type ShortcutId = keyof typeof SHORTCUTS

export function shortcutDef(id: ShortcutId): ShortcutDef {
	return SHORTCUTS[id]
}

// Object.keys is typed string[]; this is the one sanctioned widening point.
const ALL_SHORTCUT_IDS = Object.keys(SHORTCUTS) as ReadonlyArray<ShortcutId>

export function allShortcutIds(): ReadonlyArray<ShortcutId> {
	return ALL_SHORTCUT_IDS
}

function toParsed(combo: RegisterableHotkey, platform: "mac" | "windows" | "linux"): ParsedHotkey {
	return typeof combo === "string" ? parseHotkey(combo, platform) : rawHotkeyToParsedHotkey(combo, platform)
}

function keyToken(key: string, platform: "mac" | "windows" | "linux"): string {
	if (key === "Space") return "Space"
	if (key in KEY_DISPLAY_SYMBOLS) {
		const symbols: Record<string, string> = KEY_DISPLAY_SYMBOLS
		const symbol = symbols[key]
		if (symbol !== undefined) return platform === "mac" ? symbol : key === "Escape" ? "Esc" : symbol
	}
	return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Platform-aware display tokens for a combo, one token per Kbd chip
 * (e.g. "Mod+K" → ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere).
 */
export function comboDisplayTokens(
	combo: RegisterableHotkey,
	platform: "mac" | "windows" | "linux" = detectPlatform(),
): string[] {
	const parsed = toParsed(combo, platform)
	const modifierLabels =
		platform === "mac"
			? MAC_MODIFIER_SYMBOLS
			: platform === "linux"
				? LINUX_MODIFIER_LABELS
				: WINDOWS_MODIFIER_LABELS
	const tokens = parsed.modifiers.map((modifier) => modifierLabels[modifier])
	tokens.push(keyToken(parsed.key, platform))
	return tokens
}

/**
 * Display alternates for a shortcut: primary combo plus aliases, each as
 * Kbd tokens. Honors the registry's `display` override.
 */
export function shortcutDisplayAlternates(
	id: ShortcutId,
	platform: "mac" | "windows" | "linux" = detectPlatform(),
): string[][] {
	const def = shortcutDef(id)
	if (def.display) return [[...def.display]]
	const combos = [def.combo, ...(def.aliases ?? [])]
	return combos.map((combo) => comboDisplayTokens(combo, platform))
}
