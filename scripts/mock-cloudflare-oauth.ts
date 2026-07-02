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

		return json({ success: false, errors: [{ code: 7003, message: "not found" }], result: null }, 404)
	},
})

console.log("[mock-cf] listening on http://127.0.0.1:9781")
