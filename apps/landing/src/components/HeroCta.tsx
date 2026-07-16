import { useEffect, useState } from "react"
import * as m from "../paraglide/messages"
import { SIGNED_IN_EVENT } from "./auth-signal"

/**
 * Hero "Start free trial" link that flips to "Dashboard" when the user is signed in.
 * Clerk must only be mounted once per page (a second ClerkProvider island crashes the
 * first), so this listens to the auth signal broadcast by the NavBar island instead.
 */
export function HeroCta({ className }: { className?: string }) {
	const [signedIn, setSignedIn] = useState(false)
	useEffect(() => {
		setSignedIn(window.__mapleSignedIn === true)
		const onChange = (event: Event) => setSignedIn((event as CustomEvent<boolean>).detail === true)
		document.addEventListener(SIGNED_IN_EVENT, onChange)
		return () => document.removeEventListener(SIGNED_IN_EVENT, onChange)
	}, [])
	return (
		<a href="https://app.maple.dev" data-hero-cta className={className}>
			{signedIn ? m.nav_dashboard() : m.cta_get_started()}
		</a>
	)
}
