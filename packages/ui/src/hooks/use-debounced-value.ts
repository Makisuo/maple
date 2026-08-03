import { useEffect, useState } from "react"

/**
 * Trails `value` by `delayMs`.
 *
 * Used where a keystroke would otherwise become a warehouse query — the pod
 * search filters server-side, so the input has to stay instant while the query
 * behind it waits for the typing to stop.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
	const [debounced, setDebounced] = useState(value)

	useEffect(() => {
		if (Object.is(value, debounced)) return
		const timer = setTimeout(() => setDebounced(value), delayMs)
		return () => clearTimeout(timer)
	}, [value, debounced, delayMs])

	return debounced
}
