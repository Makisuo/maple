import { createHmac } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import { deriveWorkspaceId, mintOrgReadJwt } from "./tinybird-jwt"

const decodePart = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

// A Tinybird-style admin token: `p.<base64-json>.<sig>` whose payload carries the
// workspace id under `u`.
const makeAdminToken = (payload: Record<string, unknown>): string =>
	`p.${Buffer.from(JSON.stringify(payload)).toString("base64")}.sig`

const ADMIN = makeAdminToken({ u: "ws-uuid-123", id: "tok-id", host: "eu_shared" })

describe("mintOrgReadJwt", () => {
	it("produces a well-formed HS256 JWT with the right header, exp, and scopes", () => {
		const jwt = mintOrgReadJwt({
			adminToken: ADMIN,
			workspaceId: "ws-uuid-123",
			orgId: "org_abc",
			datasourceNames: ["traces", "logs"],
			nowSeconds: 1_000,
			ttlSeconds: 600,
		})

		const [header, payload, signature] = jwt.split(".")
		assert.deepStrictEqual(decodePart(header), { alg: "HS256", typ: "JWT" })

		const decoded = decodePart(payload) as {
			workspace_id: string
			name: string
			exp: number
			scopes: ReadonlyArray<{ type: string; resource: string; filter: string }>
		}
		assert.strictEqual(decoded.workspace_id, "ws-uuid-123")
		assert.strictEqual(decoded.name, "maple-raw-sql")
		assert.strictEqual(decoded.exp, 1_600)
		assert.deepStrictEqual(decoded.scopes, [
			{ type: "DATASOURCES:READ", resource: "traces", filter: "OrgId = 'org_abc'" },
			{ type: "DATASOURCES:READ", resource: "logs", filter: "OrgId = 'org_abc'" },
		])

		// Signature verifies independently against the admin token as HMAC secret.
		const expected = createHmac("sha256", ADMIN).update(`${header}.${payload}`).digest("base64url")
		assert.strictEqual(signature, expected)
	})

	it("escapes single quotes in the org id to prevent filter injection", () => {
		const jwt = mintOrgReadJwt({
			adminToken: ADMIN,
			workspaceId: "ws-uuid-123",
			orgId: "org_' OR 1=1 --",
			datasourceNames: ["traces"],
			nowSeconds: 0,
			ttlSeconds: 60,
		})
		const decoded = decodePart(jwt.split(".")[1]) as {
			scopes: ReadonlyArray<{ filter: string }>
		}
		// The embedded quote is backslash-escaped, so the ClickHouse literal stays closed.
		assert.strictEqual(decoded.scopes[0].filter, "OrgId = 'org_\\' OR 1=1 --'")
	})
})

describe("deriveWorkspaceId", () => {
	it("extracts the workspace uuid from the token payload's `u` field", () => {
		assert.strictEqual(deriveWorkspaceId(ADMIN), "ws-uuid-123")
	})

	it("throws when the token is not dotted", () => {
		assert.throws(() => deriveWorkspaceId("not-a-jwt"), /not a dotted JWT/)
	})

	it("throws when the payload has no `u` field", () => {
		assert.throws(() => deriveWorkspaceId(makeAdminToken({ id: "x" })), /no 'u' field/)
	})
})
