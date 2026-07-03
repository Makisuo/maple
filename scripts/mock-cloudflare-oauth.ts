/**
 * Mock Cloudflare OAuth + API server for local end-to-end testing of Maple's Cloudflare
 * integration. Serves the three OAuth endpoints (authorize/token/revoke) plus the
 * /accounts API the way dash.cloudflare.com + api.cloudflare.com/client/v4 do.
 *
 * Point the Maple api at it via .env.local:
 *   CLOUDFLARE_OAUTH_CLIENT_ID=mock-cf-client
 *   CLOUDFLARE_OAUTH_AUTHORIZE_URL=http://127.0.0.1:9781/oauth2/auth
 *   CLOUDFLARE_OAUTH_TOKEN_URL=http://127.0.0.1:9781/oauth2/token
 *   CLOUDFLARE_OAUTH_REVOKE_URL=http://127.0.0.1:9781/oauth2/revoke
 *   MAPLE_CLOUDFLARE_API_BASE_URL=http://127.0.0.1:9781
 */
import { createHash } from "node:crypto"

const issuedCodes = new Map<string, { challenge: string | null }>()
let revoked = 0

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

Bun.serve({
	port: 9781,
	async fetch(req) {
		const url = new URL(req.url)
		console.log(`[mock-cf] ${req.method} ${url.pathname}${url.search}`)

		// --- OAuth authorize: immediately "grant" and bounce back with code+state ---
		if (url.pathname === "/oauth2/auth") {
			const redirectUri = url.searchParams.get("redirect_uri")
			const state = url.searchParams.get("state")
			const challenge = url.searchParams.get("code_challenge")
			const method = url.searchParams.get("code_challenge_method")
			if (!redirectUri || !state) return new Response("missing redirect_uri/state", { status: 400 })
			if (!challenge || method !== "S256") {
				return new Response("PKCE S256 code_challenge required", { status: 400 })
			}
			const code = `mock-code-${Math.random().toString(36).slice(2, 10)}`
			issuedCodes.set(code, { challenge })
			const target = new URL(redirectUri)
			target.searchParams.set("code", code)
			target.searchParams.set("state", state)
			return Response.redirect(target.toString(), 302)
		}

		// --- OAuth token: verify PKCE verifier against the stored challenge ---
		if (url.pathname === "/oauth2/token" && req.method === "POST") {
			const form = new URLSearchParams(await req.text())
			const grant = form.get("grant_type")
			if (grant === "authorization_code") {
				const code = form.get("code") ?? ""
				const verifier = form.get("code_verifier") ?? ""
				const issued = issuedCodes.get(code)
				if (!issued) return json({ error: "invalid_grant" }, 400)
				const derived = createHash("sha256").update(verifier).digest("base64url")
				if (issued.challenge !== derived) {
					console.log("[mock-cf] PKCE MISMATCH", { expected: issued.challenge, derived })
					return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400)
				}
				issuedCodes.delete(code)
				return json({
					access_token: "mock-cf-access-token",
					refresh_token: "mock-cf-refresh-token",
					token_type: "bearer",
					expires_in: 3600,
					scope: form.get("scope") ?? "account.settings:read workers_observability:write",
				})
			}
			if (grant === "refresh_token") {
				return json({
					access_token: "mock-cf-access-token-refreshed",
					refresh_token: "mock-cf-refresh-token",
					token_type: "bearer",
					expires_in: 3600,
				})
			}
			return json({ error: "unsupported_grant_type" }, 400)
		}

		// --- OAuth revoke ---
		if (url.pathname === "/oauth2/revoke" && req.method === "POST") {
			revoked += 1
			console.log(`[mock-cf] token revoked (total ${revoked})`)
			return new Response(null, { status: 200 })
		}

		// --- Cloudflare API: list accounts (client/v4 envelope) ---
		if (url.pathname === "/accounts") {
			return json({
				success: true,
				errors: [],
				messages: [],
				result: [{ id: "mock-account-1", name: "Maple Mock Account", type: "standard" }],
				result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
			})
		}

		// --- Cloudflare API: list zones (paginated; page 2+ is empty) ---
		if (url.pathname === "/zones") {
			const page = Number(url.searchParams.get("page") ?? "1")
			const zones = page === 1 ? MOCK_ZONES : []
			return json({
				success: true,
				errors: [],
				messages: [],
				result: zones,
				result_info: { count: zones.length, page, per_page: 50, total_count: MOCK_ZONES.length },
			})
		}

		// --- GraphQL Analytics: settings + httpRequestsAdaptiveGroups + workersInvocationsAdaptive ---
		if (url.pathname === "/graphql" && req.method === "POST") {
			const body = (await req.json()) as { query?: string; variables?: Record<string, unknown> }
			const query = body.query ?? ""
			if (query.includes("MapleCfDatasetSettings")) return json({ data: settingsData() })
			if (query.includes("MapleCfHttpAnalytics")) {
				return json({ data: httpAnalyticsData(body.variables) })
			}
			if (query.includes("MapleCfWorkersAnalytics")) {
				return json({ data: workersAnalyticsData(body.variables) })
			}
			return json({ data: null, errors: [{ message: `unknown operation: ${query.slice(0, 60)}` }] })
		}

		return json({ success: false, errors: [{ code: 7003, message: "not found" }], result: null }, 404)
	},
})

// ---------------------------------------------------------------------------
// Analytics fixtures — deterministic-ish synthetic edge traffic so the poller
// produces plausible cloudflare.* metrics locally.
// ---------------------------------------------------------------------------

const zoneFixture = (id: string, name: string) => ({
	id,
	name,
	status: "active",
	account: { id: "mock-account-1", name: "Maple Mock Account" },
	activated_on: "2025-01-01T00:00:00Z",
	created_on: "2025-01-01T00:00:00Z",
	development_mode: 0,
	meta: {},
	modified_on: "2025-01-01T00:00:00Z",
	name_servers: ["ns1.mock.example"],
	original_dnshost: null,
	original_name_servers: null,
	original_registrar: null,
	owner: { id: null, name: null, type: null },
	plan: { id: "pro", name: "Pro" },
	paused: false,
	type: "full",
})

const MOCK_ZONES = [zoneFixture("mock-zone-1", "example.com"), zoneFixture("mock-zone-2", "assets.example.com")]

const datasetSettings = () => ({
	enabled: true,
	notOlderThan: 2419200, // 28 days
	maxDuration: 2678400,
	availableFields: ["count", "edgeTimeToFirstByteMsP50", "cpuTimeP50"],
})

const settingsData = () => ({
	viewer: {
		zones: MOCK_ZONES.map((zone) => ({
			zoneTag: zone.id,
			settings: { httpRequestsAdaptiveGroups: datasetSettings() },
		})),
		accounts: [{ settings: { workersInvocationsAdaptive: datasetSettings() } }],
	},
})

/** 5-minute bucket starts (ISO) covering [start, end) from the GraphQL variables. */
const bucketsInWindow = (variables: Record<string, unknown> | undefined): string[] => {
	const start = Date.parse(String(variables?.start ?? "")) || Date.now() - 30 * 60_000
	const end = Date.parse(String(variables?.end ?? "")) || Date.now()
	const out: string[] = []
	for (let t = Math.ceil(start / 300_000) * 300_000; t < end; t += 300_000) {
		out.push(new Date(t).toISOString().replace(".000Z", "Z"))
	}
	return out.slice(0, 288)
}

const jitter = (bucket: string, salt: number, max: number) => {
	// Deterministic per (bucket, salt) so repeated polls of a window return identical data.
	const h = createHash("sha256").update(`${bucket}:${salt}`).digest()
	return (h[0]! * 256 + h[1]!) % max
}

const httpAnalyticsData = (variables: Record<string, unknown> | undefined) => {
	const zoneTags = Array.isArray(variables?.zoneTags) ? (variables?.zoneTags as string[]) : []
	const buckets = bucketsInWindow(variables)
	return {
		viewer: {
			zones: zoneTags.map((zoneTag, zi) => ({
				zoneTag,
				groups: buckets.flatMap((bucket) => [
					{
						count: 40 + jitter(bucket, zi, 30),
						avg: { sampleInterval: 10 },
						sum: { edgeResponseBytes: 800_000 + jitter(bucket, zi + 10, 400_000), visits: 25 + jitter(bucket, zi + 20, 20) },
						dimensions: { datetimeFiveMinutes: bucket, cacheStatus: "hit", edgeResponseStatus: 200 },
					},
					{
						count: 12 + jitter(bucket, zi + 30, 10),
						avg: { sampleInterval: 10 },
						sum: { edgeResponseBytes: 300_000 + jitter(bucket, zi + 40, 150_000), visits: 8 + jitter(bucket, zi + 50, 6) },
						dimensions: { datetimeFiveMinutes: bucket, cacheStatus: "miss", edgeResponseStatus: 200 },
					},
					{
						count: 1 + jitter(bucket, zi + 60, 3),
						avg: { sampleInterval: 10 },
						sum: { edgeResponseBytes: 20_000, visits: 1 },
						dimensions: { datetimeFiveMinutes: bucket, cacheStatus: "dynamic", edgeResponseStatus: 503 },
					},
				]),
				latency: buckets.map((bucket) => ({
					count: 50,
					quantiles: {
						edgeTimeToFirstByteMsP50: 35 + jitter(bucket, zi + 70, 20),
						edgeTimeToFirstByteMsP95: 140 + jitter(bucket, zi + 80, 80),
						edgeTimeToFirstByteMsP99: 380 + jitter(bucket, zi + 90, 200),
						originResponseDurationMsP50: 18 + jitter(bucket, zi + 100, 12),
						originResponseDurationMsP95: 95 + jitter(bucket, zi + 110, 60),
						originResponseDurationMsP99: 260 + jitter(bucket, zi + 120, 150),
					},
					dimensions: { datetimeFiveMinutes: bucket },
				})),
			})),
		},
	}
}

const workersAnalyticsData = (variables: Record<string, unknown> | undefined) => {
	const buckets = bucketsInWindow(variables)
	return {
		viewer: {
			accounts: [
				{
					invocations: buckets.flatMap((bucket) => [
						{
							sum: { requests: 120 + jitter(bucket, 200, 60), errors: jitter(bucket, 210, 4), subrequests: 40 },
							quantiles: {
								cpuTimeP50: 1200 + jitter(bucket, 220, 800),
								cpuTimeP99: 8000 + jitter(bucket, 230, 4000),
								durationP50: 0.004,
								durationP99: 0.06,
							},
							dimensions: { datetimeFiveMinutes: bucket, scriptName: "mock-api-worker", status: "success" },
						},
						{
							sum: { requests: jitter(bucket, 240, 5), errors: jitter(bucket, 240, 5), subrequests: 0 },
							quantiles: {
								cpuTimeP50: 900,
								cpuTimeP99: 5000,
								durationP50: 0.003,
								durationP99: 0.04,
							},
							dimensions: { datetimeFiveMinutes: bucket, scriptName: "mock-api-worker", status: "scriptThrewException" },
						},
					]),
				},
			],
		},
	}
}

console.log("[mock-cf] listening on http://127.0.0.1:9781")
