import { describe, expect, it } from "@effect/vitest"
import { WarehouseUpstreamError, WarehouseValidationError } from "@maple/domain/http"
import { Cause, Context, Effect, type Exit, Layer, Schema, Tracer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Http5xxResponseError, serverErrorSpanMiddleware } from "./server-error-span"

// `HttpMiddleware.tracer` ends the root server span from the HttpApp's Exit, so
// a declared HttpApi error rendered into a response is `Exit.succeed(response)`
// — Ok status even for a 503. These tests pin the middleware's contract: the
// tracer must receive a Failure exit for 5xx responses (→ OTLP StatusCode
// Error), a Success exit for 2xx/4xx, and the client response is untouched.

interface EndedSpan {
	readonly name: string
	readonly kind: Tracer.SpanKind
	readonly attributes: ReadonlyMap<string, unknown>
	readonly exit: Exit.Exit<unknown, unknown>
}

const makeCapturingTracer = () => {
	const ended: Array<EndedSpan> = []
	let spanCounter = 0
	const tracer = Tracer.make({
		span(options) {
			const attributes = new Map<string, unknown>()
			const span: Tracer.Span = {
				_tag: "Span",
				name: options.name,
				traceId: "test-trace",
				spanId: `test-span-${spanCounter++}`,
				parent: options.parent,
				annotations: options.annotations,
				links: options.links,
				sampled: options.sampled,
				kind: options.kind,
				status: { _tag: "Started", startTime: options.startTime },
				attributes,
				end(_endTime, exit) {
					ended.push({ name: span.name, kind: span.kind, attributes, exit })
				},
				attribute(key, value) {
					attributes.set(key, value)
				},
				event() {},
				addLinks() {},
			}
			return span
		},
	})
	return { ended, layer: Layer.succeed(Tracer.Tracer, tracer) }
}

class SpanTestApi extends HttpApi.make("SpanTestApi").add(
	HttpApiGroup.make("spans")
		.add(HttpApiEndpoint.get("ok", "/ok", { success: Schema.String }))
		.add(
			HttpApiEndpoint.get("upstream", "/upstream", {
				success: Schema.String,
				error: [WarehouseUpstreamError],
			}),
		)
		.add(
			HttpApiEndpoint.get("badRequest", "/bad-request", {
				success: Schema.String,
				error: [WarehouseValidationError],
			}),
		),
) {}

const SpansLive = HttpApiBuilder.group(SpanTestApi, "spans", (handlers) =>
	Effect.succeed(
		handlers
			.handle("ok", () => Effect.succeed("ok"))
			.handle("upstream", () =>
				Effect.fail(
					new WarehouseUpstreamError({ pipeName: "spanTest", message: "upstream unavailable" }),
				),
			)
			.handle("badRequest", () =>
				Effect.fail(new WarehouseValidationError({ pipeName: "spanTest", message: "bad request" })),
			),
	),
)

const makeHarness = () => {
	const { ended, layer: tracerLayer } = makeCapturingTracer()
	const routes = HttpApiBuilder.layer(SpanTestApi).pipe(
		Layer.provide(SpansLive),
		Layer.provideMerge(tracerLayer),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, {
		middleware: serverErrorSpanMiddleware,
		disableLogger: true,
	})
	const request = async (path: string) => {
		const response = await handler(
			new Request(`https://api.example.com${path}`),
			Context.empty() as never,
		)
		// The tracer ends the server span on a deferred macrotask
		// (`scheduleTask(span.end, 0)`) — yield one before reading `ended`.
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		return response
	}
	const serverSpan = (path: string): EndedSpan => {
		const span = ended.find(
			(candidate) =>
				candidate.kind === "server" && candidate.attributes.get("url.path") === path,
		)
		if (span === undefined) throw new Error(`no server span ended for ${path}`)
		return span
	}
	return { request, serverSpan, dispose }
}

describe("serverErrorSpanMiddleware", () => {
	it("records a Failure-exit server span for a declared 5xx error, without touching the response", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("/upstream")
			expect(response.status).toBe(503)
			expect(await response.json()).toMatchObject({
				_tag: "@maple/http/errors/WarehouseUpstreamError",
				message: "upstream unavailable",
			})

			const span = harness.serverSpan("/upstream")
			expect(span.attributes.get("http.response.status_code")).toBe(503)
			expect(span.exit._tag).toBe("Failure")
			if (span.exit._tag !== "Failure") return
			// The tracer strips the Die(response) via `causeResponseStripped`; the
			// recorded cause is exactly the 5xx marker error, which is what the OTLP
			// exporter maps to StatusCode=Error (it is not an anticipated identifier).
			const errors = span.exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toBeInstanceOf(Http5xxResponseError)
			expect((errors[0] as Http5xxResponseError).message).toBe("HTTP 503 (GET /upstream)")
			expect(span.exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
		} finally {
			await harness.dispose()
		}
	})

	it("keeps 2xx and declared 4xx server spans on a Success exit", async () => {
		const harness = makeHarness()
		try {
			const ok = await harness.request("/ok")
			expect(ok.status).toBe(200)
			expect(harness.serverSpan("/ok").exit._tag).toBe("Success")

			const badRequest = await harness.request("/bad-request")
			expect(badRequest.status).toBe(400)
			expect(harness.serverSpan("/bad-request").exit._tag).toBe("Success")
			expect(harness.serverSpan("/bad-request").attributes.get("http.response.status_code")).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})
