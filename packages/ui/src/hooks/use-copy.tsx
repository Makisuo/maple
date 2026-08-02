"use client"

import * as React from "react"
import { toast as sonner } from "sonner"

import { useClipboard } from "./use-clipboard"

export type CopyStatus = "idle" | "copied" | "error"

export interface UseCopyOptions {
	/** Human label for the thing being copied, e.g. "Trace ID". Drives toast copy. */
	label?: string
	/** How long `status` holds before falling back to `"idle"`. */
	timeout?: number
	/**
	 * Sonner feedback. **On by default**: a copy that gives no confirmation reads
	 * as a copy that didn't happen, and the `CopyIndicator` alone can't be relied
	 * on — it's 14px, it's often the thing under your cursor, and on triggers that
	 * close (menu items, popovers) or carry no glyph at all (inline text, badges)
	 * there's nothing left to see.
	 *
	 * Pass `false` only where the surface gives its own unmistakable feedback and
	 * a toast would pile up — per-row metadata, chat message actions.
	 */
	toast?: boolean
	/** Overrides the default `"<label> copied"` toast body. */
	successMessage?: string
	onCopy?: (value: string) => void
	onError?: (reason: unknown) => void
}

export interface CopyAPI {
	/** `null`/empty resolves to the `error` state — there was nothing to copy. */
	copy: (text: string | null | undefined) => Promise<boolean>
	reset: () => void
	status: CopyStatus
	copied: boolean
}

/**
 * Last-resort clipboard write for insecure origins and embedded contexts where
 * `navigator.clipboard` is missing or rejects. Restores the user's selection so
 * copying doesn't visibly steal the caret.
 */
function writeFallback(text: string): boolean {
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
 * The one copy-to-clipboard hook. Writes through the platform `ClipboardAPI`
 * (so a `ClipboardProvider` override still applies), falls back to
 * `document.execCommand` when that rejects, and exposes an `idle | copied |
 * error` status for `CopyIndicator` to animate.
 *
 * A re-click during the hold restarts the reset window rather than being
 * swallowed, so hammering the button keeps re-confirming.
 */
export function useCopy({
	label,
	timeout = 2000,
	toast = true,
	successMessage,
	onCopy,
	onError,
}: UseCopyOptions = {}): CopyAPI {
	const clipboard = useClipboard()
	const [status, setStatus] = React.useState<CopyStatus>("idle")
	// Bumped on every copy so a re-click during the hold restarts the timer.
	const [ticket, setTicket] = React.useState(0)

	const mounted = React.useRef(true)
	React.useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	// Kept in refs so `copy` stays referentially stable across renders.
	const latest = React.useRef({ clipboard, label, onCopy, onError, successMessage, toast })
	latest.current = { clipboard, label, onCopy, onError, successMessage, toast }

	const reset = React.useCallback(() => {
		setStatus("idle")
		setTicket(0)
	}, [])

	const copy = React.useCallback(async (text: string | null | undefined): Promise<boolean> => {
		const {
			clipboard: api,
			label: name,
			onCopy: copied,
			onError: failed,
			successMessage: message,
			toast: notify,
		} = latest.current

		let ok = false
		let reason: unknown = null

		if (!text) {
			reason = new Error("Nothing to copy")
		} else {
			try {
				await api.copy(text)
				ok = true
			} catch (error) {
				reason = error
				try {
					ok = writeFallback(text)
				} catch {
					ok = false
				}
			}
		}

		if (ok && text) copied?.(text)
		if (!ok) failed?.(reason)

		if (notify) {
			if (ok) sonner.success(message ?? (name ? `${name} copied` : "Copied to clipboard"))
			else sonner.error(name ? `Failed to copy ${name.toLowerCase()}` : "Failed to copy")
		}

		if (!mounted.current) return ok

		setStatus(ok ? "copied" : "error")
		setTicket((t) => t + 1)

		return ok
	}, [])

	React.useEffect(() => {
		if (ticket === 0 || status === "idle") return
		const id = setTimeout(() => setStatus("idle"), timeout)
		return () => clearTimeout(id)
	}, [ticket, status, timeout])

	return { copied: status === "copied", copy, reset, status }
}
