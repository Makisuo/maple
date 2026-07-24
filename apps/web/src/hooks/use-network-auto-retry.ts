import * as React from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"

/** Poll backoff: 5s → 10s → 20s, then every 30s (±10% jitter). */
const POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000]

/**
 * While `enabled`, invokes `onRetry` automatically:
 *
 * - immediately when the browser fires the window `online` event (or the tab
 *   becomes visible again),
 * - on a backoff poll per {@link POLL_DELAYS_MS}, with jitter so several error
 *   panels on one screen don't probe in lockstep.
 *
 * Poll ticks are skipped while the tab is hidden or the browser reports
 * offline (the `online`/`visibilitychange` listeners fire the probe instead).
 * The timer chain is mount-scoped; `enabled` and `onRetry` are read fresh at
 * fire time. If a probe unmounts the host (error → loading → error remount),
 * the backoff resets to 5s — effectively a steady poll during a long outage,
 * which the 5s floor keeps cheap.
 */
export function useNetworkAutoRetry(enabled: boolean, onRetry: (() => void) | undefined): void {
	const fire = React.useEffectEvent(() => {
		if (enabled) onRetry?.()
	})

	useMountEffect(() => {
		// React Doctor cannot infer that useMountEffect is an Effect; this is the
		// canonical Effect Event pattern for a mount-scoped external subscription.
		// oxlint-disable-next-line react-doctor/rules-of-hooks
		const probe = () => fire()

		let attempt = 0
		let timeout: ReturnType<typeof setTimeout> | undefined

		const schedule = () => {
			const base = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]
			const delay = base * (0.9 + Math.random() * 0.2)
			timeout = setTimeout(() => {
				attempt += 1
				if (!document.hidden && navigator.onLine !== false) probe()
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
}
