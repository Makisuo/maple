import { useEffect } from "react"

/**
 * Run an effect exactly once, on mount (optionally returning a cleanup for
 * unmount). The sanctioned escape hatch for the no-useEffect convention: use it
 * for one-time external-system sync (DOM, browser APIs, persisting derived state
 * to storage) where the behavior is naturally "setup on mount, cleanup on
 * unmount". To re-run on a value change, give the host component a `key` so it
 * remounts — don't add dependencies here.
 */
export function useMountEffect(effect: () => void | (() => void)) {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(effect, [])
}
