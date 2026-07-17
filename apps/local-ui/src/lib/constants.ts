// Local mode pins a single synthetic tenant. The Rust ingest binary writes
// every decoded span/log/metric under this `OrgId`, and every `CH.compile(...)`
// call must pass the same constant so the WHERE `OrgId = 'local'` filter matches.
export const LOCAL_ORG_ID = "local"

// Default OTLP/HTTP + query port for `maple start`.
const DEFAULT_LOCAL_PORT = "4318"
const DEFAULT_LOOPBACK_ENDPOINT = `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`
const HOSTED_LOCAL_UI_HOST = "local.maple.dev"

/**
 * Resolve the origin of the local `maple` binary's `/local/query` endpoint for
 * the current page.
 *
 * The same SPA build is served two ways:
 *   - **Same-origin** — by the binary on `127.0.0.1` (`maple start --offline`)
 *     or behind the dev vite proxy (`localhost` / `*.localhost`). Return `""`
 *     so fetches stay relative; no CORS, no Private Network Access.
 *   - **Remote** — deployed to `local.maple.dev` (the binary's default). The
 *     page is a public origin, so it must reach the binary on loopback. Use the
 *     `?port=` the startup banner encodes into the URL, defaulting to 4318.
 */
export function localApiBase(): string {
	if (typeof window === "undefined") return ""
	const { hostname, search } = window.location
	// Only the separately hosted dashboard needs to reach back into the
	// browser's loopback interface. An embedded UI may be served from a LAN
	// hostname, container address, or reverse proxy and must remain same-origin.
	if (hostname !== HOSTED_LOCAL_UI_HOST) return ""
	const port = new URLSearchParams(search).get("port") ?? DEFAULT_LOCAL_PORT
	return `http://127.0.0.1:${port}`
}

/** OTLP/HTTP endpoint shown in the UI's connection hints. */
export function localOtlpEndpoint(): string {
	if (typeof window === "undefined") return DEFAULT_LOOPBACK_ENDPOINT
	return localApiBase() || window.location.origin
}

export const LOCAL_OTLP_ENDPOINT = localOtlpEndpoint()
