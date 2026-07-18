import { createHmac } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import { mintOrgReadJwt } from "./tinybird-jwt"

const decodePart = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

const SIGNING_KEY = "explicit-test-signing-key"

describe("mintOrgReadJwt", () => {
	it("produces a well-formed HS256 JWT with the right header, exp, and scopes", () => {
		const jwt = mintOrgReadJwt({
			signingKey: SIGNING_KEY,
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

		// Signature verifies independently against the explicit signing key.
		const expected = createHmac("sha256", SIGNING_KEY).update(`${header}.${payload}`).digest("base64url")
		assert.strictEqual(signature, expected)
	})

	it("escapes single quotes in the org id to prevent filter injection", () => {
		const jwt = mintOrgReadJwt({
			signingKey: SIGNING_KEY,
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
