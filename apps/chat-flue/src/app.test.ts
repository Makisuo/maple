import { describe, expect, it } from "vitest"
import app from "./app.ts"

const AGENT_URL = "https://chat.example/agents/maple-chat/org_1:default?offset=-1"
const TRIAGE_URL = "https://chat.example/agents/triage/incident_1"
const ORIGIN = "https://app.maple.dev"

// Minimal env — these tests only exercise CORS + the deny-by-default auth gate,
// neither of which reads worker bindings.
const env = {} as never
// The /agents/triage/* guard reads INTERNAL_SERVICE_TOKEN off the env.
const SERVICE_TOKEN = "svc-secret-123"
const serviceEnv = { INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN } as never

describe("chat-flue CORS", () => {
	it("answers the /agents preflight without auth (before the 401 gate)", async () => {
		const res = await app.fetch(
			new Request(AGENT_URL, {
				method: "OPTIONS",
				headers: {
					Origin: ORIGIN,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "authorization",
				},
			}),
			env,
		)

		expect(res.status).toBe(204)
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
		// Hono reflects the requested headers, so Authorization is allowed.
		expect((res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase()).toContain(
			"authorization",
		)
		// The Durable-Streams offset header must be readable by the browser.
		expect(res.headers.get("Access-Control-Expose-Headers") ?? "").toContain("Stream-Next-Offset")
	})

	it("keeps CORS headers on the 401 so the browser can read the rejection", async () => {
		const res = await app.fetch(
			new Request(AGENT_URL, { method: "GET", headers: { Origin: ORIGIN } }),
			env,
		)

		expect(res.status).toBe(401)
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
	})
})

describe("chat-flue /agents/triage/* internal-service guard", () => {
	it("rejects an unauthenticated triage invocation with 401", async () => {
		const res = await app.fetch(new Request(TRIAGE_URL, { method: "POST", body: "{}" }), serviceEnv)
		expect(res.status).toBe(401)
	})

	it("rejects a wrong / mis-scoped bearer token with 401", async () => {
		const res = await app.fetch(
			new Request(TRIAGE_URL, {
				method: "POST",
				headers: { Authorization: "Bearer maple_svc_wrong" },
				body: "{}",
			}),
			serviceEnv,
		)
		expect(res.status).toBe(401)
	})

	it("rejects when the token is set but the worker has no INTERNAL_SERVICE_TOKEN", async () => {
		const res = await app.fetch(
			new Request(TRIAGE_URL, {
				method: "POST",
				headers: { Authorization: `Bearer maple_svc_${SERVICE_TOKEN}` },
				body: "{}",
			}),
			env,
		)
		expect(res.status).toBe(401)
	})

	it("passes the guard with the correct maple_svc_ token (past the 401)", async () => {
		const res = await app.fetch(
			new Request(TRIAGE_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer maple_svc_${SERVICE_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					message: "Investigate this incident.",
					initialData: {
						orgId: "org_1",
						incidentKind: "error",
						incidentId: "i_1",
						context: {},
					},
				}),
			}),
			serviceEnv,
		)
		// The guard let it through to the agent router; without the AI binding the
		// submission won't complete, but the point is it is no longer a guard 401.
		expect(res.status).not.toBe(401)
	})
})
