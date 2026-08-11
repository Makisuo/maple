/**
 * Narrow accessors for the browser globals this package reads.
 *
 * The client SDK ships without the DOM lib (it also runs in Workers and Node), so
 * these are declared by hand rather than pulled from `lib.dom`. Each accessor names
 * exactly the fields we touch — an untyped `globalThis` bag would let a typo through.
 */

interface BrowserNavigator {
	readonly userAgent?: string
	readonly language?: string
}

interface BrowserDocument {
	readonly visibilityState?: string
}

export const browserNavigator = (): BrowserNavigator | undefined =>
	(globalThis as { navigator?: BrowserNavigator }).navigator

export const browserDocument = (): BrowserDocument | undefined =>
	(globalThis as { document?: BrowserDocument }).document
