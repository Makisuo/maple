import { createHmac } from "node:crypto"
import { escapeClickHouseString } from "@maple/query-engine/sql"

// ---------------------------------------------------------------------------
// Tinybird per-org read JWT minting.
//
// Tinybird "Forward" enforces row-level security via self-signed JWTs: a token
// carrying a `DATASOURCES:READ` scope with a `filter` has that filter ANDed onto
// every scan of the datasource server-side — inside subqueries, every UNION arm,
// both JOIN sides — regardless of the user's SQL. Verified live against the
// `/v0/sql` Query API: `WHERE 1=1` / `OR 1=1` / subqueries / direct other-org
// queries cannot escape the filter, and any datasource NOT listed in the token is
// denied outright (deny-by-default).
//
// We mint these locally (HMAC-SHA256 signed with the workspace admin token as the
// secret) rather than via the SDK's `createJWT`, which is a network round-trip.
// ---------------------------------------------------------------------------

/** Standard Tinybird JWT scope entry. */
export interface TinybirdJwtScope {
	readonly type: "DATASOURCES:READ"
	readonly resource: string
	readonly filter: string
}

export interface MintOrgReadJwtInput {
	/** The workspace admin token — the HMAC signing secret. */
	readonly adminToken: string
	/** The workspace UUID (see {@link deriveWorkspaceId}). */
	readonly workspaceId: string
	/** The org to scope the token to; embedded into every datasource filter. */
	readonly orgId: string
	/** Every datasource the token may read. Each gets an `OrgId = '<org>'` filter. */
	readonly datasourceNames: ReadonlyArray<string>
	/** Current time in whole seconds (Unix epoch). */
	readonly nowSeconds: number
	/** Token lifetime in seconds. */
	readonly ttlSeconds: number
}

const base64url = (input: string | Buffer): string =>
	(Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8")).toString("base64url")

/**
 * Mint a per-org Tinybird read JWT scoped to `datasourceNames`, each filtered to
 * `OrgId = '<orgId>'`. HS256, signed with the workspace admin token.
 */
export function mintOrgReadJwt(input: MintOrgReadJwtInput): string {
	const orgLiteral = `OrgId = '${escapeClickHouseString(input.orgId)}'`
	const scopes: ReadonlyArray<TinybirdJwtScope> = input.datasourceNames.map((resource) => ({
		type: "DATASOURCES:READ",
		resource,
		filter: orgLiteral,
	}))

	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
	const payload = base64url(
		JSON.stringify({
			workspace_id: input.workspaceId,
			name: "maple-raw-sql",
			exp: input.nowSeconds + input.ttlSeconds,
			scopes,
		}),
	)
	const signingInput = `${header}.${payload}`
	const signature = base64url(createHmac("sha256", input.adminToken).update(signingInput).digest())
	return `${signingInput}.${signature}`
}

/**
 * Extract the workspace UUID from a Tinybird admin token. Tinybird tokens are
 * `p.<base64-json>.<sig>`; the JSON payload carries the workspace id under `u`.
 * Throws if the token can't be decoded or lacks `u`, so a token-format change
 * fails loudly at mint time rather than producing invalid JWTs.
 */
export function deriveWorkspaceId(adminToken: string): string {
	const encodedPayload = adminToken.split(".")[1]
	if (!encodedPayload) {
		throw new Error("Cannot derive Tinybird workspace id: admin token is not a dotted JWT")
	}
	let decoded: unknown
	try {
		decoded = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8"))
	} catch (cause) {
		throw new Error("Cannot derive Tinybird workspace id: admin token payload is not valid JSON", {
			cause,
		})
	}
	const workspaceId =
		decoded && typeof decoded === "object" && "u" in decoded
			? (decoded as { u?: unknown }).u
			: undefined
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new Error("Cannot derive Tinybird workspace id: admin token payload has no 'u' field")
	}
	return workspaceId
}
