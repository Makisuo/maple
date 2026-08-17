/**
 * Narrow optional globals for tests and non-DOM embedders, without pulling in
 * the full DOM types.
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
