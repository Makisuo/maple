import { createClerkClient } from "@clerk/backend"

export interface VerifiedRequest {
	orgId: string
	userId: string
}

export interface AuthEnv {
	MAPLE_AUTH_MODE?: string
	MAPLE_ROOT_PASSWORD?: string
	CLERK_SECRET_KEY?: string
	CLERK_PUBLISHABLE_KEY?: string
	CLERK_JWT_KEY?: string
}

const ALLOWED_TOKEN_HEADERS = ["authorization", "x-maple-auth"] as const

const getAuthMode = (env: AuthEnv): "clerk" | "self_hosted" =>
	env.MAPLE_AUTH_MODE?.toLowerCase() === "clerk" ? "clerk" : "self_hosted"

const extractBearerToken = (request: Request): string | undefined => {
	for (const headerName of ALLOWED_TOKEN_HEADERS) {
		const header = request.headers.get(headerName)
		if (!header) continue
		const [scheme, token] = header.split(" ")
		if (scheme && token && scheme.toLowerCase() === "bearer") return token
		if (header && !token && headerName !== "authorization") return header
	}
	return undefined
}

const decodeBase64Url = (input: string): string | undefined => {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
	const padding = normalized.length % 4
	const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding)
	try {
		return atob(padded)
	} catch {
		return undefined
	}
}

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.byteLength !== b.byteLength) return false
	let mismatch = 0
	for (let i = 0; i < a.byteLength; i += 1) {
		mismatch |= a[i]! ^ b[i]!
	}
	return mismatch === 0
}

const verifyHs256 = async (
	token: string,
	secret: string,
): Promise<{ sub: string; org_id: string } | undefined> => {
	const parts = token.split(".")
	if (parts.length !== 3) return undefined
	const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
	const decodedHeader = decodeBase64Url(encodedHeader)
	if (decodedHeader === undefined) return undefined
	let header: { alg?: string }
	try {
		header = JSON.parse(decodedHeader) as { alg?: string }
	} catch {
		return undefined
	}
	if (header.alg !== "HS256") return undefined
	const enc = new TextEncoder()
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	)
	const expected = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, enc.encode(`${encodedHeader}.${encodedPayload}`)),
	)
	const decodedSignature = decodeBase64Url(encodedSignature)
	if (decodedSignature === undefined) return undefined
	const provided = Uint8Array.from(decodedSignature, (c) => c.charCodeAt(0))
	if (!constantTimeEqual(expected, provided)) return undefined
	const decodedPayload = decodeBase64Url(encodedPayload)
	if (decodedPayload === undefined) return undefined
	let payload: { sub?: unknown; org_id?: unknown; exp?: unknown; nbf?: unknown }
	try {
		payload = JSON.parse(decodedPayload) as typeof payload
	} catch {
		return undefined
	}
	const now = Math.floor(Date.now() / 1000)
	if (typeof payload.exp === "number" && now >= payload.exp) return undefined
	if (typeof payload.nbf === "number" && now < payload.nbf) return undefined
	if (typeof payload.sub !== "string" || typeof payload.org_id !== "string") return undefined
	return { sub: payload.sub, org_id: payload.org_id }
}

let cachedClerk: ReturnType<typeof createClerkClient> | undefined
const getClerk = (env: AuthEnv) => {
	if (!env.CLERK_SECRET_KEY) return undefined
	if (cachedClerk) return cachedClerk
	cachedClerk = createClerkClient({
		secretKey: env.CLERK_SECRET_KEY,
		publishableKey: env.CLERK_PUBLISHABLE_KEY,
		jwtKey: env.CLERK_JWT_KEY,
	})
	return cachedClerk
}

export const verifyRequest = async (
	request: Request,
	env: AuthEnv,
): Promise<VerifiedRequest | undefined> => {
	const token = extractBearerToken(request)
	if (!token) return undefined

	const mode = getAuthMode(env)
	if (mode === "clerk") {
		const clerk = getClerk(env)
		if (!clerk) return undefined
		const headers = new Headers(request.headers)
		headers.set("authorization", `Bearer ${token}`)
		const verifiable = new Request(request.url, { headers, method: "GET" })
		const state = await clerk
			.authenticateRequest(verifiable, { acceptsToken: ["session_token"] })
			.catch(() => undefined)
		if (!state || !state.isAuthenticated) return undefined
		const auth = state.toAuth()
		if (!auth || !auth.userId || !auth.orgId) return undefined
		return { orgId: auth.orgId, userId: auth.userId }
	}

	const secret = env.MAPLE_ROOT_PASSWORD
	if (!secret) return undefined
	const payload = await verifyHs256(token, secret)
	if (!payload) return undefined
	return { orgId: payload.org_id, userId: payload.sub }
}

/**
 * Encode an org-scoped entity id from orgId + tabId. The agents-server treats
 * `/` as a path separator inside entity URLs, so we use `--` to namespace.
 */
export const entityIdForTab = (orgId: string, tabId: string): string =>
	`${orgId}--${tabId}`

export const orgIdFromEntityId = (entityId: string): string | undefined => {
	const idx = entityId.indexOf("--")
	if (idx <= 0) return undefined
	return entityId.slice(0, idx)
}
