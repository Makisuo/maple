import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Layer, Tracer } from "effect"
import { Env } from "@/lib/Env"
import { GithubAppClient } from "@/services/vcs/vendor/github/GithubAppClient"
import { GithubHttp, type GithubHttpShape } from "@/services/vcs/vendor/github/GithubHttp"

// The GitHub REST call must be a Client-kind span carrying `peer.service` —
// that pair is what draws the GitHub node and its edge on the service map. An
// Internal span with neither leaves the whole dependency invisible there, so
// these assertions are the regression guard for that (see maple-audit MAP-01).

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const env = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				PORT: "3472",
				TINYBIRD_HOST: "https://api.tinybird.co",
				TINYBIRD_TOKEN: "test-token",
				MAPLE_AUTH_MODE: "self_hosted",
				MAPLE_ROOT_PASSWORD: "test-root-password",
				MAPLE_DEFAULT_ORG_ID: "default",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
				GITHUB_APP_ID: "123456",
				GITHUB_APP_PRIVATE_KEY: privateKey,
			}),
		),
	),
)

/** Records every span so the request span's kind and attributes are assertable. */
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

const requestSpans = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
	spans.filter((span) => span.name === "GithubAppClient.request")

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubHttp = (respond: () => Response) =>
	Layer.succeed(GithubHttp, { fetch: async () => respond() } satisfies GithubHttpShape)

describe("GithubAppClient request span", () => {
	it.effect("emits a Client-kind span with peer.service and HTTP attributes", () => {
		const layer = GithubAppClient.layer.pipe(
			Layer.provide(
				stubHttp(() =>
					jsonResponse({
						id: 42,
						account: { login: "octo", id: 7, type: "Organization" },
						repository_selection: "all",
					}),
				),
			),
			Layer.provide(env),
		)

		return Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const client = yield* GithubAppClient

			yield* client.getInstallation("42").pipe(Effect.withTracer(tracer))

			const [span, ...rest] = requestSpans(spans)
			assert.isDefined(span)
			assert.deepStrictEqual(rest, [], "one HTTP span per GitHub call")
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("peer.service"), "github")
			assert.strictEqual(span.attributes.get("server.address"), "api.github.com")
			assert.strictEqual(span.attributes.get("url.path"), "/app/installations/42")
			assert.strictEqual(span.attributes.get("http.request.method"), "GET")
			assert.strictEqual(span.attributes.get("http.response.status_code"), 200)
		}).pipe(Effect.provide(layer))
	})

	it.effect("records the upstream status on a failing call", () => {
		const layer = GithubAppClient.layer.pipe(
			Layer.provide(stubHttp(() => jsonResponse({ message: "Not Found" }, 404))),
			Layer.provide(env),
		)

		return Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const client = yield* GithubAppClient

			const exit = yield* client.getInstallation("42").pipe(Effect.withTracer(tracer), Effect.exit)
			assert.isTrue(exit._tag === "Failure")

			// The status lands on the span even though the call failed, so an upstream
			// 4xx/5xx is attributable without reading the error message.
			const [span] = requestSpans(spans)
			assert.isDefined(span)
			assert.strictEqual(span.attributes.get("http.response.status_code"), 404)
			assert.strictEqual(span.attributes.get("peer.service"), "github")
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not record the search query text on the span", () => {
		const layer = GithubAppClient.layer.pipe(
			Layer.provide(
				stubHttp(() =>
					jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" }),
				),
			),
			Layer.provide(env),
		)

		return Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const client = yield* GithubAppClient

			// The token mint succeeds; the search decode then fails on the same stub —
			// irrelevant here, the span for the search request is what is under test.
			yield* client
				.searchCode("42", "octo", "shop", "card declined", undefined, 5)
				.pipe(Effect.withTracer(tracer), Effect.exit)

			const searchSpan = requestSpans(spans).find((span) =>
				String(span.attributes.get("url.path")).includes("/search/code"),
			)
			assert.isDefined(searchSpan)
			// `url.path` on purpose, never `url.full`: the query carries the caller's
			// raw search text, which has no business in telemetry.
			assert.isUndefined(searchSpan?.attributes.get("url.full"))
			for (const value of searchSpan?.attributes.values() ?? []) {
				assert.notInclude(String(value), "card declined")
			}
		}).pipe(Effect.provide(layer))
	})
})
