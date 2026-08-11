/**
 * Narrow optional globals for the DOM-free SDK build, which also runs in
 * Workers and Node.
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
