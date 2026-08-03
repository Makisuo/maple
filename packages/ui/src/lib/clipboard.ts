/**
 * Framework-free clipboard writes. Lives outside the React hook so the non-React
 * surfaces (the Astro landing site) share one implementation of the fiddly
 * insecure-origin fallback instead of keeping their own copy of it.
 */

/**
 * Last-resort clipboard write for insecure origins and embedded contexts where
 * `navigator.clipboard` is missing or rejects. Restores the user's selection so
 * copying doesn't visibly steal the caret.
 */
export function writeClipboardFallback(text: string): boolean {
	if (typeof document === "undefined") return false

	const area = document.createElement("textarea")
	area.value = text
	area.setAttribute("readonly", "")
	area.style.position = "fixed"
	area.style.top = "0"
	area.style.left = "0"
	area.style.opacity = "0"
	document.body.appendChild(area)

	const selection = document.getSelection()
	const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

	area.select()
	let ok = false
	try {
		ok = document.execCommand("copy")
	} catch {
		ok = false
	}

	document.body.removeChild(area)
	if (selection && previous) {
		selection.removeAllRanges()
		selection.addRange(previous)
	}
	return ok
}

/**
 * Write `text` through `navigator.clipboard`, falling back to the hidden
 * textarea when the API is missing or rejects. React callers should prefer
 * `useCopy`, which routes through the platform `ClipboardAPI` first so a
 * `ClipboardProvider` override still applies.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
	if (!text) return false

	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text)
			return true
		}
	} catch {
		// fall through to the legacy path
	}

	return writeClipboardFallback(text)
}
