import { describe, expect, it } from "@effect/vitest"
import { isAnticipatedErrorIdentifier } from "@maple/domain/anticipated-errors"
import { WarehouseUpstreamError, WarehouseValidationError } from "@maple/domain/http"
import { Cause, Context, Effect, type Exit, Layer, Schema, Tracer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Http5xxResponseError, serverErrorSpanMiddleware } from "./server-error-span"

// `HttpMiddleware.tracer` ends the root server span from the HttpApp's Exit, so
// a declared HttpApi error rendered into a response is `Exit.succeed(response)`
// — Ok status even for a 503. These tests pin the middleware's contract: the
// tracer must receive a Failure exit for 5xx responses (→ OTLP StatusCode
// Error), a Success exit for 2xx/4xx, an untouched Failure for genuine defects,
// and the client response is never altered.

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

// Production applies the middleware to the whole router, not just HttpApi
// groups (see worker.ts `apiRequestMiddleware`) — plain routes are the most
// direct 5xx trigger (`Exit.succeed` with no error rendering involved), and
// the defect route pins that genuine failures pass through untouched.
const PlainRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		yield* router.add("GET", "/plain-503", HttpServerResponse.text("nope", { status: 503 }))
		yield* router.add("GET", "/plain-500", HttpServerResponse.empty({ status: 500 }))
		yield* router.add("GET", "/defect", Effect.die(new Error("kaboom")))
	}),
)

const makeHarness = () => {
	const { ended, layer: tracerLayer } = makeCapturingTracer()
	const routes = Layer.mergeAll(
		HttpApiBuilder.layer(SpanTestApi).pipe(Layer.provide(SpansLive)),
		PlainRoutes,
	).pipe(Layer.provideMerge(tracerLayer))
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

const failReasonErrors = (exit: Exit.Exit<unknown, unknown>): Array<unknown> => {
	if (exit._tag !== "Failure") throw new Error(`expected Failure exit, got ${exit._tag}`)
	return exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
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
			// The tracer strips the Die(response) via `causeResponseStripped`; the
			// recorded cause is exactly the 5xx marker error, which is what the OTLP
			// exporter maps to StatusCode=Error (it is not an anticipated identifier).
			const errors = failReasonErrors(span.exit)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toBeInstanceOf(Http5xxResponseError)
			expect((errors[0] as Http5xxResponseError).message).toBe("HTTP 503 (GET /upstream)")
			if (span.exit._tag === "Failure") {
				expect(span.exit.cause.reasons.some(Cause.isDieReason)).toBe(false)
			}
		} finally {
			await harness.dispose()
		}
	})

	it("converts plain-router 5xx responses, including the exact 500 boundary", async () => {
		const harness = makeHarness()
		try {
			const plain503 = await harness.request("/plain-503")
			expect(plain503.status).toBe(503)
			expect(await plain503.text()).toBe("nope")
			const span503 = harness.serverSpan("/plain-503")
			expect(span503.attributes.get("http.response.status_code")).toBe(503)
			expect(failReasonErrors(span503.exit)[0]).toBeInstanceOf(Http5xxResponseError)

			const plain500 = await harness.request("/plain-500")
			expect(plain500.status).toBe(500)
			const span500 = harness.serverSpan("/plain-500")
			const errors = failReasonErrors(span500.exit)
			expect(errors[0]).toBeInstanceOf(Http5xxResponseError)
			expect((errors[0] as Http5xxResponseError).message).toBe("HTTP 500 (GET /plain-500)")
		} finally {
			await harness.dispose()
		}
	})

	it("passes an unhandled defect through untouched — no double-wrap, original cause preserved", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("/defect")
			expect(response.status).toBe(500)

			const span = harness.serverSpan("/defect")
			expect(span.exit._tag).toBe("Failure")
			if (span.exit._tag !== "Failure") return
			const reasons = span.exit.cause.reasons
			// The defect reaches the middleware as a Failure, so the flatMap never
			// runs: the original defect is recorded, and no marker error is added.
			const defects = reasons.filter(Cause.isDieReason).map((reason) => reason.defect)
			expect(defects.some((d) => d instanceof Error && d.message === "kaboom")).toBe(true)
			const markers = reasons
				.filter(Cause.isFailReason)
				.filter((reason) => reason.error instanceof Http5xxResponseError)
			expect(markers).toHaveLength(0)
		} finally {
			await harness.dispose()
		}
	})

	it("strips the query string from the marker message (OAuth `code` must not leak)", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.request("/upstream?code=super-secret&state=xyz")
			expect(response.status).toBe(503)

			const span = harness.serverSpan("/upstream")
			const errors = failReasonErrors(span.exit)
			const marker = errors[0] as Http5xxResponseError
			expect(marker).toBeInstanceOf(Http5xxResponseError)
			expect(marker.message).toBe("HTTP 503 (GET /upstream)")
			expect(marker.path).not.toContain("super-secret")
			expect(JSON.stringify({ ...marker })).not.toContain("super-secret")
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

	it("is never an anticipated error identifier — the invariant the whole fix hinges on", () => {
		// ANTICIPATED_ERROR_IDENTIFIERS is derived (4xx-annotated domain exports +
		// a hand-kept external list). If this tag ever enters the set — e.g. added
		// to EXTERNAL_ANTICIPATED_IDENTIFIERS during a noisy-dashboard triage —
		// every 5xx server span silently reverts to Ok.
		const marker = new Http5xxResponseError({ status: 503, method: "GET", path: "/x" })
		expect(marker._tag).toBe("@maple/api/http/Http5xxResponseError")
		expect(isAnticipatedErrorIdentifier(marker._tag)).toBe(false)
	})
})
