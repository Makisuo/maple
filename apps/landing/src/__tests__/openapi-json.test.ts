import { describe, expect, it } from "vitest"
import { GET, openApiDocument } from "../pages/openapi.json"

// Endpoint tests only need `site`; the rest of APIContext is unused.
const context = { site: new URL("https://maple.dev") } as Parameters<typeof GET>[0]

describe("/openapi.json", () => {
	it("serves a JSON OpenAPI 3.1 document that targets the API origin", async () => {
		const response = await GET(context)
		expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
		const doc = await response.json()
		expect(doc.openapi).toMatch(/^3\.1\./)
		expect(doc.info.title).toBe("Maple API")
		expect(doc.servers).toEqual([{ url: "https://api.maple.dev", description: "Production" }])
	})

	it("is function-calling ready: every operation has an operationId and a description", () => {
		const doc = openApiDocument()
		const operations = Object.values(doc.paths).flatMap((item) =>
			Object.values(item as Record<string, { operationId?: string; description?: string }>),
		)
		expect(operations.length).toBeGreaterThan(50)
		const ids = operations.map((operation) => operation.operationId)
		expect(new Set(ids).size).toBe(ids.length)
		for (const operation of operations) {
			expect(operation.operationId).toEqual(expect.any(String))
			expect(operation.description).toEqual(expect.any(String))
		}
	})
})
