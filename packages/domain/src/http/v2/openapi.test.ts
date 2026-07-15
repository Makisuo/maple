import { describe, expect, it } from "vitest"
import { OpenApi } from "effect/unstable/httpapi"
import { MapleApiV2 } from "./api"

/**
 * Contract freeze: the public v2 OpenAPI surface (paths + methods) is asserted
 * explicitly so an accidental route change fails CI. Additions require
 * updating this list — which is the point.
 */
describe("MapleApiV2 OpenAPI", () => {
	const spec = OpenApi.fromApi(MapleApiV2)

	it("derives with v2 metadata", () => {
		expect(spec.info.title).toBe("Maple API")
		expect(spec.info.version).toBe("2.0.0")
	})

	it("exposes exactly the committed v2 paths", () => {
		const surface = Object.entries(spec.paths ?? {})
			.flatMap(([path, item]) =>
				Object.keys(item ?? {})
					.filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
					.map((method) => `${method.toUpperCase()} ${path}`),
			)
			.sort()

		expect(surface).toEqual([
			"DELETE /v2/api_keys/{id}",
			"GET /v2/api_keys",
			"GET /v2/api_keys/{id}",
			"POST /v2/api_keys",
			"POST /v2/api_keys/{id}/roll",
		])
	})
})
