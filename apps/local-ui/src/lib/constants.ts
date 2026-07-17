// Local mode pins a single synthetic tenant. The Rust ingest binary writes
// every decoded span/log/metric under this `OrgId`, and every `CH.compile(...)`
// call must pass the same constant so the WHERE `OrgId = 'local'` filter matches.
export const LOCAL_ORG_ID = "local"

// Default OTLP/HTTP + query port for `maple start`.
const DEFAULT_LOCAL_PORT = "4318"
const DEFAULT_LOOPBACK_ENDPOINT = `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`
const HOSTED_LOCAL_UI_HOST = "local.maple.dev"
const HOSTED_API_MODE_PARAM = "maple-local-api"

interface LocalUiLocation {
	readonly hostname: string
	readonly origin: string
	readonly search: string
}

const localPort = (search: string): string => {
	const value = new URLSearchParams(search).get("port")
	if (!value || !/^\d+$/.test(value)) return DEFAULT_LOCAL_PORT
	const port = Number(value)
	return port >= 1 && port <= 65_535 ? value : DEFAULT_LOCAL_PORT
}

/**
 * Resolve the origin of the local `maple` binary's `/local/query` endpoint for
 * the current page.
 *
 * The same SPA build is served two ways:
 *   - **Same-origin** — by the binary on its selected address (`maple start
 *     --offline`) or behind the dev vite proxy (`localhost` / `*.localhost`).
 *     Return `""` so fetches stay relative; no CORS or Private Network Access.
 *   - **Remote** — deployed to `local.maple.dev` (the binary's default), or to
 *     another `MAPLE_LOCAL_UI_URL` carrying `?maple-local-api=loopback`. The page
 *     is a public origin, so it must reach the binary on loopback. Use the
 *     `?port=` the startup banner encodes into the URL, defaulting to 4318.
 */
export const localApiBaseForLocation = (location: LocalUiLocation): string => {
	const search = new URLSearchParams(location.search)
	const isHosted =
		location.hostname === HOSTED_LOCAL_UI_HOST || search.get(HOSTED_API_MODE_PARAM) === "loopback"
	return isHosted ? `http://127.0.0.1:${localPort(location.search)}` : ""
}

export function localApiBase(): string {
	return typeof window === "undefined" ? "" : localApiBaseForLocation(window.location)
}

/** OTLP/HTTP endpoint shown in the UI's connection hints. */
export const localOtlpEndpointForLocation = (location: LocalUiLocation): string =>
	localApiBaseForLocation(location) || location.origin

export function localOtlpEndpoint(): string {
	return typeof window === "undefined"
		? DEFAULT_LOOPBACK_ENDPOINT
		: localOtlpEndpointForLocation(window.location)
}

export const LOCAL_OTLP_ENDPOINT = localOtlpEndpoint()
