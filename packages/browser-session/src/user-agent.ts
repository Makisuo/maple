interface ParsedUserAgent {
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
}

/** Best-effort UA parse — enough to populate filterable session facets. */
export function parseUserAgent(ua: string): ParsedUserAgent {
	const browserName = /edg/i.test(ua)
		? "Edge"
		: /opr|opera/i.test(ua)
			? "Opera"
			: /chrome|crios/i.test(ua)
				? "Chrome"
				: /firefox|fxios/i.test(ua)
					? "Firefox"
					: /safari/i.test(ua)
						? "Safari"
						: "Unknown"
	// iOS UAs contain "like Mac OS X", so test iOS before macOS
	const osName = /windows/i.test(ua)
		? "Windows"
		: /iphone|ipad|ios/i.test(ua)
			? "iOS"
			: /mac os|macintosh/i.test(ua)
				? "macOS"
				: /android/i.test(ua)
					? "Android"
					: /linux/i.test(ua)
						? "Linux"
						: "Unknown"
	const deviceType = /mobile|iphone|android.*mobile/i.test(ua)
		? "mobile"
		: /ipad|tablet/i.test(ua)
			? "tablet"
			: "desktop"
	return { browserName, osName, deviceType }
}
