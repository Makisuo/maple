/**
 * Framework-free clipboard writes. Lives outside the React hook so the non-React
 * surfaces (the Astro landing site) share one implementation of the fiddly
 * insecure-origin fallback instead of keeping their own copy of it.
 */

import { Option } from "effect"

import { tryPromise, trySync } from "./try-sync"

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
	// `execCommand` throws outright in a sandboxed frame rather than returning
	// false, so an unavailable command and a refused one are one answer.
	const ok = Option.getOrElse(
		trySync(() => document.execCommand("copy")),
		() => false,
	)

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

	if (navigator.clipboard?.writeText) {
		const written = await tryPromise(() => navigator.clipboard.writeText(text))
		if (Option.isSome(written)) return true
	}

	// The API is missing, or it rejected — an insecure origin, a denied
	// permission, a document that was not focused. The textarea covers all three.
	return writeClipboardFallback(text)
}
