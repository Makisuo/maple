const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

/**
 * Empty string = same origin (production behind Caddy). Dev defaults to the
 * local API port. `""` must not be used with `url.startsWith(apiBaseUrl)` —
 * every URL starts with empty; use {@link isMapleApiRequestUrl}.
 */
export const apiBaseUrl =
	configuredApiBaseUrl && configuredApiBaseUrl.length > 0
		? configuredApiBaseUrl.replace(/\/$/, "")
		: import.meta.env.DEV
			? "http://127.0.0.1:3472"
			: ""

export const isMapleApiRequestUrl = (url: string): boolean => {
	if (apiBaseUrl.length > 0) return url.startsWith(apiBaseUrl)
	if (url.startsWith("/")) return true
	if (typeof location !== "undefined" && location.origin.length > 0) {
		return url.startsWith(location.origin)
	}
	return false
}
