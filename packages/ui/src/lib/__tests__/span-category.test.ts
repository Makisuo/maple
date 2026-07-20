import { describe, expect, it } from "vitest"

import { describeSpan } from "../span-category"

const span = (input: {
	spanName: string
	spanKind?: string
	spanAttributes?: Record<string, string>
}) => ({
	spanName: input.spanName,
	spanKind: input.spanKind ?? "SPAN_KIND_INTERNAL",
	spanAttributes: input.spanAttributes ?? {},
})

describe("describeSpan", () => {
	it("categorizes a server HTTP span", () => {
		const { category, httpInfo } = describeSpan(
			span({
				spanName: "GET /api/users",
				spanKind: "SPAN_KIND_SERVER",
				spanAttributes: { "http.method": "GET", "http.route": "/api/users" },
			}),
		)
		expect(category.id).toBe("server")
		expect(httpInfo?.kind).toBe("server")
	})

	it("categorizes a client HTTP span", () => {
		const { category } = describeSpan(
			span({
				spanName: "GET",
				spanKind: "SPAN_KIND_CLIENT",
				spanAttributes: { "http.request.method": "GET", "url.full": "https://api.example.com/v1" },
			}),
		)
		expect(category.id).toBe("http")
	})

	it("categorizes a redis cache span with the system as label", () => {
		const { category, cacheInfo } = describeSpan(
			span({
				spanName: "cache.get",
				spanKind: "SPAN_KIND_CLIENT",
				spanAttributes: { "cache.system": "redis", "cache.result": "hit", "db.system": "redis" },
			}),
		)
		expect(category.id).toBe("cache")
		expect(category.label).toBe("redis")
		expect(cacheInfo?.result).toBe("hit")
	})

	it("categorizes a postgres db span via the database adapter", () => {
		const { category } = describeSpan(
			span({
				spanName: "SELECT users",
				spanKind: "SPAN_KIND_CLIENT",
				spanAttributes: { "db.system.name": "postgresql", "db.operation.name": "SELECT" },
			}),
		)
		expect(category.id).toBe("db")
		expect(category.label).toBe("PostgreSQL")
	})

	it("categorizes a cloudflare platform span", () => {
		const { category, platform } = describeSpan(
			span({
				spanName: "worker fetch",
				spanKind: "SPAN_KIND_SERVER",
				spanAttributes: { "cloud.platform": "cloudflare.workers" },
			}),
		)
		expect(category.id).toBe("platform")
		expect(platform).not.toBeNull()
	})

	it("categorizes producer and consumer spans as messaging", () => {
		expect(describeSpan(span({ spanName: "publish", spanKind: "SPAN_KIND_PRODUCER" })).category).toMatchObject(
			{ id: "messaging", label: "Producer" },
		)
		expect(describeSpan(span({ spanName: "receive", spanKind: "SPAN_KIND_CONSUMER" })).category).toMatchObject(
			{ id: "messaging", label: "Consumer" },
		)
	})

	it("categorizes a Class.method span as function", () => {
		const { category, className } = describeSpan(
			span({ spanName: "UserService.findById", spanKind: "SPAN_KIND_INTERNAL" }),
		)
		expect(category.id).toBe("function")
		expect(className).toBe("UserService")
	})

	it("falls back to internal for bare spans", () => {
		const { category } = describeSpan(span({ spanName: "process items" }))
		expect(category.id).toBe("internal")
		expect(category.label).toBe("Internal")
	})

	it("handles unknown and empty span kinds without crashing", () => {
		expect(describeSpan(span({ spanName: "x", spanKind: "SPAN_KIND_WEIRD" })).category.label).toBe("WEIRD")
		expect(describeSpan(span({ spanName: "x", spanKind: "" })).category).toMatchObject({
			id: "internal",
			label: "Internal",
		})
	})

	it("categorizes a non-HTTP server span as server", () => {
		const { category } = describeSpan(span({ spanName: "grpc.handle", spanKind: "SPAN_KIND_SERVER" }))
		expect(category.id).toBe("server")
	})
})
