import { useEffect, useState } from "react"

/**
 * A `Date.now()` that re-renders its consumer once a second while `enabled`.
 *
 * The sanctioned timer exception to the no-useEffect rule, same as
 * `useIntervalRefresh`: a clock is wall time, not derived state, so there is
 * nothing to compute it from.
 *
 * A self-rescheduling `setTimeout` aimed at the next whole second, not
 * `setInterval` — an interval started mid-second lands the tick permanently off
 * the boundary it is displaying, so a 1s-resolution readout drifts and
 * occasionally skips or repeats a number.
 *
 * The value is read from `Date.now()` on every tick rather than accumulated, so
 * a throttled background tab resyncs on its first tick back instead of showing
 * however far behind it fell.
 */
export function useTickingNow(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (!enabled) return
		let id: ReturnType<typeof setTimeout>
		const schedule = () => {
			id = setTimeout(
				() => {
					setNow(Date.now())
					schedule()
				},
				1000 - (Date.now() % 1000),
			)
		}
		// Catch up first: mounting after a long render, or re-enabling, must not
		// show a stale number for up to a second before the first tick arrives.
		setNow(Date.now())
		schedule()
		return () => clearTimeout(id)
	}, [enabled])

	return now
}
