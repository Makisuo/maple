// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
"use client"

import * as React from "react"
import { toastManager } from "../components/ui/toast"

import { writeClipboardFallback } from "../lib/clipboard"
import { useClipboard } from "./use-clipboard"
import { useMountEffect } from "./use-mount-effect"

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

	// Restarted on every copy so a re-click during the hold extends the window
	// rather than letting the first timer snap the status back early.
	const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const mounted = React.useRef(true)
	useMountEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			clearTimeout(timer.current)
		}
	})

	const reset = React.useCallback(() => {
		clearTimeout(timer.current)
		setStatus("idle")
	}, [])

	const copy = React.useCallback(
		async (text: string | null | undefined): Promise<boolean> => {
			let ok = false
			let reason: Error | null = null

			if (!text) {
				reason = new Error("Nothing to copy")
			} else {
				try {
					await clipboard.copy(text)
					ok = true
				} catch (error) {
					reason = error instanceof Error ? error : new Error(String(error))
					try {
						ok = writeClipboardFallback(text)
					} catch {
						ok = false
					}
				}
			}

			if (ok && text) onCopy?.(text)
			if (!ok) onError?.(reason)

			if (toast) {
				if (ok) {
					toastManager.add({
						title: successMessage ?? (label ? `${label} copied` : "Copied to clipboard"),
						type: "success",
					})
				} else {
					toastManager.add({
						title: label ? `Failed to copy ${label.toLowerCase()}` : "Failed to copy",
						type: "error",
					})
				}
			}

			if (!mounted.current) return ok

			setStatus(ok ? "copied" : "error")
			clearTimeout(timer.current)
			timer.current = setTimeout(() => {
				if (mounted.current) setStatus("idle")
			}, timeout)

			return ok
		},
		[clipboard, label, onCopy, onError, successMessage, timeout, toast],
	)

	return { copied: status === "copied", copy, reset, status }
}
