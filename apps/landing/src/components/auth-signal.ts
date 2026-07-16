/**
 * Cross-island auth signal. Clerk is only mounted by the NavBar island; other
 * islands (e.g. HeroCta) learn about the signed-in state through this event
 * plus the window flag for late mounters.
 */
export const SIGNED_IN_EVENT = "maple:signed-in"

declare global {
	interface Window {
		__mapleSignedIn?: boolean
	}
}

export function broadcastSignedIn(signedIn: boolean) {
	window.__mapleSignedIn = signedIn
	document.dispatchEvent(new CustomEvent(SIGNED_IN_EVENT, { detail: signedIn }))
}
