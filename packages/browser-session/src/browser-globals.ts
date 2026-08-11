/**
 * Narrow accessors for the browser globals this package reads.
 *
 * Session code also runs in tests and non-DOM embedders, so these are declared by
 * hand and every accessor may return `undefined`. Each names exactly the fields we
 * touch — an untyped `globalThis` bag would let a typo through as `any`.
 */

interface BrowserNavigator {
	readonly userAgent?: string
	readonly language?: string
}

interface BrowserLocation {
	readonly href?: string
	readonly host?: string
}

interface BrowserDocument {
	readonly visibilityState?: string
}

export const browserNavigator = (): BrowserNavigator | undefined =>
	(globalThis as { navigator?: BrowserNavigator }).navigator

export const browserLocation = (): BrowserLocation | undefined =>
	(globalThis as { window?: { location?: BrowserLocation } }).window?.location

export const browserDocument = (): BrowserDocument | undefined =>
	(globalThis as { document?: BrowserDocument }).document
