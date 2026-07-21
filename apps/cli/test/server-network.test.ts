import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { Effect, Exit, Tracer } from "effect"
import { checkpointQueryUrl } from "../src/server/checkpoints"
import { __testables, corsHeadersForAllowedOrigin, isBrowserOriginAllowed } from "../src/server/serve"
import { serverProbeUrl } from "../src/commands/server-args"

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("local HTTP server span status", () => {
	it.effect("records a 4xx response as a successful Server span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const response = yield* __testables
				.recordServerResponse(new Response("invalid SQL", { status: 400 }))
				.pipe(Effect.withSpan("POST /local/query", { kind: "server" }), Effect.withTracer(tracer))

			strictEqual(response.status, 400)
			const span = spans.find((candidate) => candidate.name === "POST /local/query")
			ok(span)
			strictEqual(span.attributes.get("error.type"), "HTTP 400")
			ok(span.status._tag === "Ended" && Exit.isSuccess(span.status.exit))
		}),
	)

	it.effect("records a 5xx response as a failed Server span", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const exit = yield* __testables
				.recordServerResponse(new Response("database unavailable", { status: 503 }))
				.pipe(
					Effect.withSpan("POST /local/query", { kind: "server" }),
					Effect.withTracer(tracer),
					Effect.exit,
				)

			ok(Exit.isFailure(exit))
			const span = spans.find((candidate) => candidate.name === "POST /local/query")
			ok(span)
			ok(span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
		}),
	)
})

describe("local listener addresses", () => {
	it("reaches an IPv4 wildcard listener through the loopback probe URL", async () => {
		const server = Bun.serve({
			hostname: "0.0.0.0",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			const response = await fetch(serverProbeUrl("0.0.0.0", server.port))
			strictEqual(response.status, 200)
		} finally {
			await server.stop(true)
		}
	})

	it("does not assume IPv4 loopback for an IPv6-only listener", async () => {
		const server = Bun.serve({
			hostname: "::1",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			strictEqual((await fetch(serverProbeUrl("::1", server.port))).status, 200)
			await rejects(fetch(`http://127.0.0.1:${server.port}`))
		} finally {
			await server.stop(true)
		}
	})

	it("reaches an IPv6 wildcard listener through IPv6 loopback", async () => {
		const server = Bun.serve({
			hostname: "::",
			port: 0,
			fetch: () => new Response("OK"),
		})
		try {
			strictEqual((await fetch(serverProbeUrl("::", server.port))).status, 200)
		} finally {
			await server.stop(true)
		}
	})

	it("formats checkpoint query URLs for the resolved connection host", () => {
		strictEqual(checkpointQueryUrl("::1", 4418), "http://[::1]:4418/local/query")
	})
})

describe("browser origin policy", () => {
	const requestUrl = new URL("http://srvmini2.lan:4418/local/query")
	const hostedOrigin = "https://local.maple.dev"
	const browserHosts = ["srvmini2.lan", "127.0.0.1"]

	it("allows non-browser clients, the advertised same-origin UI, and the hosted UI", () => {
		strictEqual(isBrowserOriginAllowed(requestUrl, null, hostedOrigin, browserHosts), true)
		strictEqual(
			isBrowserOriginAllowed(requestUrl, "http://srvmini2.lan:4418", hostedOrigin, browserHosts),
			true,
		)
		strictEqual(
			isBrowserOriginAllowed(requestUrl, "https://srvmini2.lan:4418", hostedOrigin, browserHosts),
			true,
		)
		strictEqual(isBrowserOriginAllowed(requestUrl, hostedOrigin, hostedOrigin, browserHosts), true)
	})

	it("allows loopback aliases and the documented Vite proxy across ports", () => {
		strictEqual(
			isBrowserOriginAllowed(
				new URL("http://localhost:4318/local/query"),
				"http://localhost:4318",
				hostedOrigin,
				["127.0.0.1"],
			),
			true,
		)
		strictEqual(
			isBrowserOriginAllowed(
				new URL("http://127.0.0.1:4318/local/query"),
				"http://127.0.0.1:4319",
				hostedOrigin,
				["127.0.0.1"],
			),
			true,
		)
		strictEqual(
			isBrowserOriginAllowed(
				new URL("http://[::1]:4318/local/query"),
				"http://[::1]:4319",
				hostedOrigin,
				["[::1]"],
			),
			true,
		)
	})

	it("rejects arbitrary and DNS-rebinding browser origins", () => {
		strictEqual(
			isBrowserOriginAllowed(requestUrl, "https://attacker.example", hostedOrigin, browserHosts),
			false,
		)
		strictEqual(
			isBrowserOriginAllowed(
				new URL("http://rebind.attacker.example:4418/local/query"),
				"http://rebind.attacker.example:4418",
				hostedOrigin,
				browserHosts,
			),
			false,
		)
		strictEqual(
			isBrowserOriginAllowed(requestUrl, "http://localhost:4319", hostedOrigin, browserHosts),
			false,
		)
	})

	it("echoes any allowed origin instead of a wildcard", () => {
		deepStrictEqual(corsHeadersForAllowedOrigin(hostedOrigin), {
			"access-control-allow-origin": hostedOrigin,
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-allow-headers": "content-type, content-encoding",
			"access-control-allow-private-network": "true",
			vary: "Origin",
		})
		const loopbackOrigin = "http://localhost:3000"
		strictEqual(
			isBrowserOriginAllowed(new URL("http://127.0.0.1:4318/v1/traces"), loopbackOrigin, hostedOrigin, [
				"127.0.0.1",
			]),
			true,
		)
		strictEqual(
			corsHeadersForAllowedOrigin(loopbackOrigin)?.["access-control-allow-origin"],
			loopbackOrigin,
		)
		strictEqual(corsHeadersForAllowedOrigin(null), undefined)
	})
})
