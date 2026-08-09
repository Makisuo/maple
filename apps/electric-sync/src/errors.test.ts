import { assert, describe, it } from "@effect/vitest"
import {
	ElectricNotConfigured,
	ElectricUpstreamError,
	ElectricUpstreamUnreachable,
	errorResponse,
	type ShapeError,
	ShapeRequestInvalid,
	Unauthorized,
} from "./errors"

/**
 * The whole failure surface in one place. Every one of these was previously only
 * observable through a router test, which meant the mapping and the wiring failed
 * together and could not be told apart.
 */
const cases: ReadonlyArray<{
	readonly name: string
	readonly error: ShapeError
	readonly status: number
	readonly body: string
	readonly errorType: string
}> = [
	{
		name: "an unknown shape",
		error: new ShapeRequestInvalid({ message: "Unknown or missing shape" }),
		status: 400,
		// The validation message IS the client-facing body — it says what to fix
		// and reveals nothing the caller did not already send.
		body: "Unknown or missing shape",
		errorType: "ShapeRequestInvalid",
	},
	{
		name: "an unresolved tenant",
		error: new Unauthorized({ message: "Clerk authentication failed: token expired" }),
		status: 401,
		// Deliberately NOT the error's message: why a token failed is for the span.
		body: "Unauthorized",
		errorType: "Unauthorized",
	},
	{
		name: "no ELECTRIC_URL (expected on self-hosted)",
		error: new ElectricNotConfigured({ message: "no url", reason: "missing_url" }),
		status: 503,
		body: "Electric sync is not configured",
		errorType: "ElectricConfigUnavailable",
	},
	{
		name: "half-configured Cloud credentials (a misconfiguration to chase down)",
		error: new ElectricNotConfigured({ message: "half", reason: "incoherent_credentials" }),
		status: 503,
		// Same response as above — traces tell them apart, clients do not need to.
		body: "Electric sync is not configured",
		errorType: "ElectricConfigIncoherent",
	},
	{
		name: "an unreachable upstream",
		error: new ElectricUpstreamUnreachable({ message: "ECONNREFUSED" }),
		status: 502,
		body: "Electric upstream unreachable",
		errorType: "ElectricUpstreamUnavailable",
	},
]

describe("errorResponse", () => {
	for (const testCase of cases) {
		it(`maps ${testCase.name} to ${testCase.status}`, () => {
			const response = errorResponse(testCase.error)
			assert.strictEqual(response.status, testCase.status)
			assert.strictEqual(response.body, testCase.body)
			assert.strictEqual(response.errorType, testCase.errorType)
			assert.strictEqual(response.headers["content-type"], "text/plain; charset=utf-8")
		})
	}

	it("passes an upstream 5xx through with its own status and body", () => {
		const response = errorResponse(
			new ElectricUpstreamError({
				message: "Electric returned 503",
				status: 503,
				body: "electric exploded",
				headers: { "cache-control": "public, max-age=60" },
			}),
		)
		assert.strictEqual(response.status, 503)
		assert.strictEqual(response.body, "electric exploded")
		assert.strictEqual(response.errorType, "ElectricUpstreamError")
	})

	/**
	 * A 5xx is still an org-scoped response sitting on a URL that is byte-identical
	 * for every tenant, so it goes through the same cache isolation a 2xx does.
	 */
	it("cache-isolates an upstream error response", () => {
		const response = errorResponse(
			new ElectricUpstreamError({
				message: "boom",
				status: 500,
				body: "boom",
				headers: { "cache-control": "public, max-age=60", "content-length": "4" },
			}),
		)
		assert.strictEqual(response.headers.vary, "Authorization")
		assert.strictEqual(response.headers["cache-control"], "private, max-age=60")
		assert.isUndefined(response.headers["content-length"])
	})
})
