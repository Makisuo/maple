import { describe, expect, it } from "vitest"
import { extractBearerToken, instanceIdFromAgentPath, verifyHs256, verifyRequest } from "./auth.ts"
import type { ChatFlueEnv } from "./env.ts"

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const mintHs256 = async (payload: Record<string, unknown>, secret: string): Promise<string> => {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
	const body = b64url(JSON.stringify(payload))
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	)
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)),
	)
	let bin = ""
	for (const byte of sig) bin += String.fromCharCode(byte)
	const sigB64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
	return `${header}.${body}.${sigB64}`
}

const nowSec = () => Math.floor(Date.now() / 1000)

describe("extractBearerToken", () => {
	it("reads a Bearer authorization header", () => {
		const r = new Request("https://x/", { headers: { authorization: "Bearer tok123" } })
		expect(extractBearerToken(r)).toBe("tok123")
	})
	it("reads a raw x-maple-auth header", () => {
		const r = new Request("https://x/", { headers: { "x-maple-auth": "rawtok" } })
		expect(extractBearerToken(r)).toBe("rawtok")
	})
	it("falls back to the ?token= query param", () => {
		expect(extractBearerToken(new Request("https://x/agents/a/b?token=qtok"))).toBe("qtok")
	})
	it("returns undefined with no token", () => {
		expect(extractBearerToken(new Request("https://x/"))).toBeUndefined()
	})
})

describe("verifyHs256", () => {
	const secret = "s3cr3t"

	it("accepts a valid token and returns sub/org_id", async () => {
		const tok = await mintHs256({ sub: "user_1", org_id: "org_1", exp: nowSec() + 60 }, secret)
		expect(await verifyHs256(tok, secret)).toEqual({ sub: "user_1", org_id: "org_1" })
	})
	it("rejects a wrong secret", async () => {
		const tok = await mintHs256({ sub: "u", org_id: "o" }, secret)
		expect(await verifyHs256(tok, "nope")).toBeUndefined()
	})
	it("rejects an expired token", async () => {
		const tok = await mintHs256({ sub: "u", org_id: "o", exp: nowSec() - 1 }, secret)
		expect(await verifyHs256(tok, secret)).toBeUndefined()
	})
	it("rejects a tampered payload (signature mismatch)", async () => {
		const tok = await mintHs256({ sub: "u", org_id: "o" }, secret)
		const [h, , s] = tok.split(".")
		const forged = `${h}.${b64url(JSON.stringify({ sub: "u", org_id: "evil" }))}.${s}`
		expect(await verifyHs256(forged, secret)).toBeUndefined()
	})
	it("rejects tokens without exactly three parts", async () => {
		expect(await verifyHs256("not.a.jwt.x", secret)).toBeUndefined()
		expect(await verifyHs256("nope", secret)).toBeUndefined()
	})
})

describe("instanceIdFromAgentPath", () => {
	it("extracts the instance id", () => {
		expect(instanceIdFromAgentPath("/agents/maple-chat/org_1:tab9")).toBe("org_1:tab9")
	})
	it("url-decodes the id", () => {
		expect(instanceIdFromAgentPath("/agents/maple-chat/org_1%3Atab9")).toBe("org_1:tab9")
	})
	it("returns undefined for non-agent paths", () => {
		expect(instanceIdFromAgentPath("/health")).toBeUndefined()
		expect(instanceIdFromAgentPath("/agents/maple-chat")).toBeUndefined()
	})
})

describe("tenant resolution", () => {
	const clerkless = { MAPLE_AUTH_MODE: "self_hosted", MAPLE_ROOT_PASSWORD: "s3cret" } as ChatFlueEnv

	// apps/api pins the tenant with MAPLE_ORG_ID_OVERRIDE and seeds an
	// investigation's agent under that org. If this worker resolved the same token
	// to the token's own org, it would 403 the conversation the API just created.
	it("honours MAPLE_ORG_ID_OVERRIDE the way apps/api does", async () => {
		const token = await mintHs256({ sub: "user_1", org_id: "org_from_token", exp: nowSec() + 600 }, "s3cret")
		const request = new Request("https://chat.test/agents/maple-chat/x", {
			headers: { authorization: `Bearer ${token}` },
		})

		expect(await verifyRequest(request, clerkless)).toEqual({
			orgId: "org_from_token",
			userId: "user_1",
		})
		expect(
			await verifyRequest(request, { ...clerkless, MAPLE_ORG_ID_OVERRIDE: "org_pinned" }),
		).toEqual({ orgId: "org_pinned", userId: "user_1" })
	})
})
