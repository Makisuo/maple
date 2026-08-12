import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { V2SchemaErrors, V2UnexpectedErrors } from "@maple/domain/http/v2"
import { V2TransportErrorBoundaryLive } from "./error-envelope"

const ResponseSchemaGroup = HttpApiGroup.make("responseSchema").add(
	HttpApiEndpoint.get("invalidResponse", "/invalid-response", { success: Schema.String }),
)

class ResponseSchemaApi extends HttpApi.make("ResponseSchemaApi")
	.add(ResponseSchemaGroup)
	.middleware(V2SchemaErrors)
	.middleware(V2UnexpectedErrors) {}

const ResponseSchemaHandlersLive = HttpApiBuilder.group(ResponseSchemaApi, "responseSchema", (handlers) =>
	Effect.succeed(handlers.handle("invalidResponse", () => Effect.succeed(42 as never))),
)

describe("v2 response schema boundary", () => {
	it("logs response drift and returns a sanitized 500 envelope", async () => {
		const routes = HttpApiBuilder.layer(ResponseSchemaApi).pipe(
			Layer.provide(ResponseSchemaHandlersLive),
			Layer.provide(V2TransportErrorBoundaryLive),
		)
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		try {
			const response = await handler(
				new Request("http://maple.test/invalid-response"),
				Context.empty() as never,
			)
			const body = await response.json()
			expect(response.status).toBe(500)
			expect(body).toEqual({
				error: {
					_tag: "@maple/http/v2/ResponseSchemaError",
					type: "api_error",
					code: "internal_error",
					title: "Something went wrong",
					message: "An unexpected error occurred on our end.",
					retryable: false,
					recovery: "contact_support",
				},
			})
			expect(JSON.stringify(body)).not.toContain("42")
		} finally {
			await dispose()
		}
	})
})
