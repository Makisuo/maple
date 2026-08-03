// Keyboard-shortcut guards shared by every surface that binds page-level keys
// (web hotkeys, the docs search overlay, the trace timeline).

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

/** True when the event target is a text field / contentEditable — skip shortcuts there. */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	if (EDITABLE_TAGS.has(target.tagName)) return true
	if (target.isContentEditable) return true
	return false
}

/** True when a modal dialog is open — skip page-level shortcuts so the dialog owns the keyboard. */
export function isDialogOpen(): boolean {
	// Base UI marks open popups with a bare `data-open` attribute (not Radix's `data-state="open"`).
	return document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]') !== null
}
