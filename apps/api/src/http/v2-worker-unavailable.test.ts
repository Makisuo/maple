import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { V2WorkerUnavailable } from "@maple/domain/http/v2"
import { v2WorkerUnavailableResponse } from "./v2-worker-unavailable"

describe("v2 worker fallback", () => {
	it("uses the declared 504 tag and canonical body", async () => {
		const response = v2WorkerUnavailableResponse()
		const body = await response.json()

		expect(response.status).toBe(504)
		expect(response.headers.get("retry-after")).toBe("1")
		expect(body).toEqual({ error: V2WorkerUnavailable.make().error })
		expect(() => Schema.decodeUnknownSync(V2WorkerUnavailable.schema)(body)).not.toThrow()
	})
})
