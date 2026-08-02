import { useMemo, useRef } from "react"

import { useMountEffect } from "./use-mount-effect"

export interface DebouncedCallback<Args extends ReadonlyArray<unknown>> {
	(...args: Args): void
	/** Drop the pending invocation, if any. */
	cancel: () => void
}

/**
 * Debounce a callback: each call restarts the timer, and only the last call's
 * arguments reach `fn`. The returned function is referentially stable while
 * always seeing the latest `fn`/`delayMs`, and the pending invocation is
 * cancelled on unmount so a debounced search can't fire after its page is gone.
 */
export function useDebouncedCallback<Args extends ReadonlyArray<unknown>>(
	fn: (...args: Args) => void,
	delayMs: number,
): DebouncedCallback<Args> {
	const fnRef = useRef(fn)
	fnRef.current = fn
	const delayRef = useRef(delayMs)
	delayRef.current = delayMs
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const debounced = useMemo(() => {
		const cancel = () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current)
				timerRef.current = null
			}
		}
		const call = (...args: Args) => {
			cancel()
			timerRef.current = setTimeout(() => {
				timerRef.current = null
				fnRef.current(...args)
			}, delayRef.current)
		}
		return Object.assign(call, { cancel })
	}, [])

	useMountEffect(() => () => debounced.cancel())

	return debounced
}
