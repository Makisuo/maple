import { useState, useEffect } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

export function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false)

	useEffect(() => {
		const mql = window.matchMedia(QUERY)
		setReduced(mql.matches)

		const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
		mql.addEventListener("change", handler)
		return () => mql.removeEventListener("change", handler)
	}, [])

	return reduced
}
