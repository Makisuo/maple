import * as React from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"

const POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000]
const MAX_POLL_ATTEMPTS = 6

/**
 * Retries on reconnect, visibility, and bounded jittered backoff. Hidden or
 * offline poll ticks wait for their corresponding browser event.
 */
export function useNetworkAutoRetry(enabled: boolean, onRetry: (() => void) | undefined): boolean {
	const [exhausted, setExhausted] = React.useState(false)
	const fire = React.useEffectEvent(() => {
		if (!enabled || onRetry === undefined) return false
		onRetry()
		return true
	})

	useMountEffect(() => {
		// react-doctor-disable-next-line react-doctor/rules-of-hooks -- React Doctor does not recognize useMountEffect as an Effect Event boundary.
		const probe = () => fire()

		let attempt = 0
		let timeout: ReturnType<typeof setTimeout> | undefined

		const schedule = () => {
			if (attempt >= MAX_POLL_ATTEMPTS) {
				setExhausted(true)
				return
			}
			const base = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]
			const delay = base * (0.9 + Math.random() * 0.2)
			timeout = setTimeout(() => {
				if (!document.hidden && navigator.onLine !== false && probe()) attempt += 1
				schedule()
			}, delay)
		}

		const onOnline = () => probe()
		const onVisibilityChange = () => {
			if (!document.hidden && navigator.onLine !== false) probe()
		}

		window.addEventListener("online", onOnline)
		document.addEventListener("visibilitychange", onVisibilityChange)
		schedule()

		return () => {
			window.removeEventListener("online", onOnline)
			document.removeEventListener("visibilitychange", onVisibilityChange)
			if (timeout !== undefined) clearTimeout(timeout)
		}
	})

	return enabled && !exhausted
}
