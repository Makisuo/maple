import { useState } from "react"
import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys"

import { isDialogOpen } from "@maple/ui/lib/keyboard"

export interface ListNavigationOptions<T extends string> {
	/** Row ids in display order. */
	ids: ReadonlyArray<T>
	enabled?: boolean
	/** Enter on the focused row. */
	onOpen?: (id: T) => void
	/** "x" on the focused row (shiftKey enables range-select semantics). */
	onToggleSelect?: (id: T, mods: { shiftKey: boolean }) => void
	/** Escape — return true when consumed (e.g. a selection was cleared). */
	onEscape?: () => boolean
	/** Keep the focused row visible (virtualizer scrollToIndex or DOM scrollIntoView). */
	scrollTo?: (id: T, index: number) => void
}

function isInteractiveTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return target.closest("button, a, [role='button'], [role='menuitem'], [role='option']") !== null
}

/**
 * Vim-style list navigation (j/k/↑/↓ to move, Enter to open, x to select,
 * Escape to clear) shared by the issues list and the logs/traces tables.
 *
 * Suspended while a modal dialog/sheet is open so detail panels own the
 * keyboard (the dialog's own Escape still closes it first).
 */
export function useListNavigation<T extends string>(
	options: ListNavigationOptions<T>,
): {
	focusedId: T | null
	setFocusedId: (id: T | null) => void
} {
	const { ids, enabled = true, onOpen, onToggleSelect, onEscape, scrollTo } = options
	const [focusedId, setFocusedId] = useState<T | null>(null)

	const move = (delta: 1 | -1) => {
		if (isDialogOpen()) return
		if (ids.length === 0) return
		const currentIndex = focusedId !== null ? ids.indexOf(focusedId) : -1
		const nextIndex =
			delta === 1
				? currentIndex < 0
					? 0
					: Math.min(currentIndex + 1, ids.length - 1)
				: currentIndex <= 0
					? 0
					: currentIndex - 1
		const id = ids[nextIndex]
		if (id === undefined) return
		setFocusedId(id)
		scrollTo?.(id, nextIndex)
	}

	const open = (event: KeyboardEvent) => {
		if (isDialogOpen()) return
		if (focusedId === null || !onOpen) return
		// Don't hijack Enter from a keyboard-focused button/link elsewhere on the page.
		if (isInteractiveTarget(event.target)) return
		event.preventDefault()
		onOpen(focusedId)
	}

	const toggleSelect = (event: KeyboardEvent) => {
		if (isDialogOpen()) return
		if (focusedId === null || !onToggleSelect) return
		event.preventDefault()
		onToggleSelect(focusedId, { shiftKey: event.shiftKey })
	}

	const escape = (event: KeyboardEvent) => {
		if (isDialogOpen()) return
		if (onEscape?.()) {
			event.preventDefault()
			return
		}
		if (focusedId !== null) setFocusedId(null)
	}

	const definitions: UseHotkeyDefinition[] = [
		{ hotkey: "J", callback: () => move(1) },
		{ hotkey: "ArrowDown", callback: () => move(1) },
		{ hotkey: "K", callback: () => move(-1) },
		{ hotkey: "ArrowUp", callback: () => move(-1) },
		{ hotkey: "Enter", callback: open, options: { preventDefault: false } },
	]
	if (onToggleSelect) {
		// Plain x toggles; Shift+x range-selects from the anchor — register both
		// because the matcher requires exact modifier state.
		definitions.push(
			{ hotkey: "X", callback: toggleSelect, options: { preventDefault: false } },
			{ hotkey: "Shift+X", callback: toggleSelect, options: { preventDefault: false } },
		)
	}
	definitions.push({
		hotkey: "Escape",
		callback: escape,
		options: { preventDefault: false, ignoreInputs: true },
	})

	useHotkeys(definitions, { enabled, stopPropagation: false })

	return { focusedId, setFocusedId }
}
