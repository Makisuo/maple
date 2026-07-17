import { lazy, Suspense, useCallback, useState } from "react"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { isDialogOpen, isEditableTarget } from "@/lib/keyboard"

const CommandPalette = lazy(() =>
	import("@/components/command-palette/command-palette").then((module) => ({
		default: module.CommandPalette,
	})),
)

const KeyboardShortcutsDialog = lazy(() =>
	import("@/components/command-palette/keyboard-shortcuts-dialog").then((module) => ({
		default: module.KeyboardShortcutsDialog,
	})),
)

const SHOW_SHORTCUTS_EVENT = "maple:show-keyboard-shortcuts"

/** Open the keyboard-shortcuts help dialog from anywhere (e.g. the sidebar Support menu). */
export function showKeyboardShortcuts() {
	document.dispatchEvent(new CustomEvent(SHOW_SHORTCUTS_EVENT))
}

function focusSearch() {
	// Pages opt in by tagging their primary search affordance. Inputs get
	// focused; anything else (e.g. the traces Advanced Filter trigger) is
	// clicked to open its editor.
	const target = document.querySelector<HTMLElement>('[data-shortcut-focus="search"]')
	if (!target) return
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		target.focus()
		target.select()
	} else {
		target.click()
	}
}

/**
 * App-wide keyboard UX, mounted once in the root AppFrame:
 * ⌘K command palette, "?" shortcuts help, and "/" focus-search.
 */
export function GlobalShortcuts() {
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [shortcutsOpen, setShortcutsOpen] = useState(false)
	const { setTheme } = useTheme()

	const handleShowShortcuts = useCallback(() => {
		setPaletteOpen(false)
		setShortcutsOpen(true)
	}, [])

	useMountEffect(() => {
		const onShow = () => setShortcutsOpen(true)
		const onKeyDown = (event: KeyboardEvent) => {
			const key = event.key.toLowerCase()
			const mod = event.metaKey || event.ctrlKey
			if (mod && key === "k") {
				event.preventDefault()
				setPaletteOpen((current) => !current)
				return
			}
			if (
				isEditableTarget(event.target) ||
				isDialogOpen() ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey
			) {
				return
			}
			if (event.key === "?") {
				event.preventDefault()
				setShortcutsOpen(true)
			} else if (key === "t") {
				event.preventDefault()
				setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")
			} else if (event.key === "/") {
				event.preventDefault()
				focusSearch()
			}
		}
		document.addEventListener(SHOW_SHORTCUTS_EVENT, onShow)
		document.addEventListener("keydown", onKeyDown)
		return () => {
			document.removeEventListener(SHOW_SHORTCUTS_EVENT, onShow)
			document.removeEventListener("keydown", onKeyDown)
		}
	})

	return (
		<Suspense fallback={null}>
			{paletteOpen && (
				<CommandPalette open onOpenChange={setPaletteOpen} onShowShortcuts={handleShowShortcuts} />
			)}
			{shortcutsOpen && <KeyboardShortcutsDialog open onOpenChange={setShortcutsOpen} />}
		</Suspense>
	)
}
