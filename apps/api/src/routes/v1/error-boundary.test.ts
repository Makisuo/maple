import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { V1SchemaErrors, V1UnexpectedErrors } from "@maple/domain/http"
import { V1ErrorBoundaryLive } from "./error-boundary"

const BoundaryGroup = HttpApiGroup.make("boundary")
	.add(
		HttpApiEndpoint.post("validate", "/validate", {
			payload: Schema.Struct({ name: Schema.String.check(Schema.isMinLength(2)) }),
			success: Schema.String,
		}),
	)
	.add(HttpApiEndpoint.get("invalidResponse", "/invalid-response", { success: Schema.String }))
	.add(HttpApiEndpoint.get("defect", "/defect", { success: Schema.String }))

class BoundaryApi extends HttpApi.make("BoundaryApi")
	.add(BoundaryGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const BoundaryHandlersLive = HttpApiBuilder.group(BoundaryApi, "boundary", (handlers) =>
	Effect.succeed(
		handlers
			.handle("validate", ({ payload }) => Effect.succeed(payload.name))
			.handle("invalidResponse", () => Effect.succeed(42 as never))
			.handle("defect", () => Effect.die(new Error("database password must not cross the wire"))),
	),
)

const makeHarness = () => {
	const routes = HttpApiBuilder.layer(BoundaryApi).pipe(
		Layer.provide(BoundaryHandlersLive),
		Layer.provide(V1ErrorBoundaryLive),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const request = async (method: string, path: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}
	return { request, dispose }
}

describe("v1 HTTP error boundary", () => {
	it("returns a structured, path-anchored 400 for every request decode failure", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("POST", "/validate", { name: "" })
			expect(response.status).toBe(400)
			expect(response.body).toMatchObject({
				_tag: "@maple/http/v1/V1RequestValidationError",
				param: "name",
				details: [expect.stringContaining("name")],
			})
		} finally {
			await harness.dispose()
		}
	})

	it("logs defects and returns a sanitized 500", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("GET", "/defect")
			expect(response.status).toBe(500)
			expect(response.body).toEqual({
				_tag: "@maple/http/v1/V1UnexpectedError",
				message: "An unexpected error occurred on our end.",
			})
			expect(JSON.stringify(response.body)).not.toContain("database password")
		} finally {
			await harness.dispose()
		}
	})

	it("treats an invalid handler response as a sanitized 500, not a caller 400", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("GET", "/invalid-response")
			expect(response.status).toBe(500)
			expect(response.body).toEqual({
				_tag: "@maple/http/v1/V1UnexpectedError",
				message: "An unexpected error occurred on our end.",
			})
			expect(JSON.stringify(response.body)).not.toContain("42")
		} finally {
			await harness.dispose()
		}
	})
})
