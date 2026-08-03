import { useHotkeys, type UseHotkeyOptions } from "@tanstack/react-hotkeys"

import { isDialogOpen } from "@maple/ui/lib/keyboard"
import { type ShortcutId, shortcutDef } from "@/lib/shortcuts"

export interface UseAppHotkeyOptions {
	/** Soft-disable: registration stays (visible in devtools) but doesn't fire. */
	enabled?: boolean
	/** Scope the listener to an element instead of the document. */
	target?: UseHotkeyOptions["target"]
}

/**
 * Register a handler for an app shortcut from the SHORTCUTS registry.
 *
 * Combos, preventDefault/ignoreInputs behavior, and dialog-open scoping all
 * come from the registry entry, so the combo shown in the help dialog is
 * always the one that fires.
 */
export function useAppHotkey(
	id: ShortcutId,
	handler: (event: KeyboardEvent) => void,
	options?: UseAppHotkeyOptions,
): void {
	const def = shortcutDef(id)

	const callback = (event: KeyboardEvent) => {
		// DOM-level guard: while a modal dialog/sheet is open it owns the
		// keyboard, so nested overlays consume keys before page shortcuts.
		if (!def.allowWhenDialogOpen && isDialogOpen()) return
		handler(event)
	}

	const combos = [def.combo, ...(def.aliases ?? [])]

	// The manager merges options via object spread, so unset keys must be
	// omitted entirely — an explicit `enabled: undefined` would clobber the
	// library default and permanently disable the hotkey.
	const commonOptions: UseHotkeyOptions = {
		// Never block other document-level keydown handlers (e.g. Base UI's
		// own Escape handling) — our guards decide whether to act instead.
		stopPropagation: false,
		preventDefault: def.preventDefault ?? true,
		meta: { name: def.label },
	}
	if (def.ignoreInputs !== undefined) commonOptions.ignoreInputs = def.ignoreInputs
	if (options?.enabled !== undefined) commonOptions.enabled = options.enabled
	if (options?.target !== undefined) commonOptions.target = options.target

	useHotkeys(
		combos.map((hotkey) => ({ hotkey, callback })),
		commonOptions,
	)
}
