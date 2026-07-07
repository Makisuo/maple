import { type Emit, safeEmit } from "./shared"

/**
 * Capture page views as session events: the initial load plus every SPA
 * navigation (history pushState/replaceState, popstate, hashchange).
 */
export function installNavigationCapture(emit: Emit): () => void {
	let lastUrl = ""
	const emitNav = (): void => {
		const url = location.href
		// SPA frameworks often replaceState repeatedly with the same URL; dedupe.
		if (url === lastUrl) return
		lastUrl = url
		safeEmit(emit, { type: "navigation", url })
	}

	emitNav() // initial page view

	const origPush = history.pushState
	const origReplace = history.replaceState
	history.pushState = function (this: History, ...args) {
		const result = origPush.apply(this, args as never)
		emitNav()
		return result
	}
	history.replaceState = function (this: History, ...args) {
		const result = origReplace.apply(this, args as never)
		emitNav()
		return result
	}
	window.addEventListener("popstate", emitNav)
	window.addEventListener("hashchange", emitNav)

	return () => {
		history.pushState = origPush
		history.replaceState = origReplace
		window.removeEventListener("popstate", emitNav)
		window.removeEventListener("hashchange", emitNav)
	}
}
