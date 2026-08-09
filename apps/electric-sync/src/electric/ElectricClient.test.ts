import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { type RecordedRequest, stubFetch, syncConfigLayer } from "../test-support"
import { SHAPE_NAMES, type ShapeName, shapeScopeColumn } from "../shapes/registry"
import type { ShapeRequest } from "../shapes/request"
import {
	buildUpstreamShapeUrl,
	describeUpstreamFailure,
	ElectricClient,
	isElectricConfigCoherent,
} from "./ElectricClient"

const parse = (raw: string) => {
	const url = new URL(raw)
	return { url, params: url.searchParams }
}

const shapeRequest = (
	shape: ShapeName,
	options: { scopeValue?: string; query?: string } = {},
): ShapeRequest => {
	const column = shapeScopeColumn(shape)
	return {
		shape,
		scope:
			column === null || options.scopeValue === undefined
				? null
				: { column, value: options.scopeValue },
		clientParams: new URLSearchParams(options.query ?? ""),
	}
}

const base = { electricUrl: "http://electric:3000", orgId: "org_123" }

const buildUrl = (
	shape: ShapeName,
	options: {
		scopeValue?: string
		query?: string
		sourceId?: string
		secret?: string
		electricUrl?: string
	} = {},
) =>
	parse(
		buildUpstreamShapeUrl({
			...base,
			...(options.electricUrl ? { electricUrl: options.electricUrl } : {}),
			request: shapeRequest(shape, options),
			sourceId: options.sourceId,
			secret: options.secret,
		}),
	)

describe("isElectricConfigCoherent", () => {
	it("accepts self-hosted (neither source id nor secret)", () => {
		assert.isTrue(isElectricConfigCoherent({ sourceId: Option.none(), secret: Option.none() }))
	})

	it("accepts Electric Cloud (both source id and secret)", () => {
		assert.isTrue(
			isElectricConfigCoherent({
				sourceId: Option.some("src_1"),
				secret: Option.some(Redacted.make("sh_secret")),
			}),
		)
	})

	it("rejects a source id without a secret (the skipped-per-PR-source case)", () => {
		assert.isFalse(isElectricConfigCoherent({ sourceId: Option.some("src_1"), secret: Option.none() }))
	})

	it("rejects a secret without a source id", () => {
		assert.isFalse(
			isElectricConfigCoherent({
				sourceId: Option.none(),
				secret: Option.some(Redacted.make("sh_secret")),
			}),
		)
	})
})

/**
 * The upstream URL carries the Electric Cloud source `secret`, and error text
 * routinely embeds that URL — so every string this produces lands in a span
 * message and a log annotation, and must not carry the credential.
 */
describe("describeUpstreamFailure", () => {
	const SECRET = "sh_supersecret"
	const failingUrl = `http://electric:3000/v1/shape?table=dashboards&secret=${SECRET}&offset=-1`

	it("redacts the secret in the error's own text", () => {
		const described = describeUpstreamFailure(new Error(`Transport error (GET ${failingUrl})`))
		assert.notInclude(described, SECRET)
		assert.include(described, "secret=REDACTED")
	})

	/**
	 * The regression this exists for: redacting the outer text and then appending
	 * `String(error.cause)` verbatim leaked the credential, because a fetch
	 * failure's cause commonly embeds the request URL as well.
	 */
	it("redacts the secret in the appended cause, not just the outer text", () => {
		const described = describeUpstreamFailure(
			new Error("Transport error", { cause: new Error(`connect ECONNREFUSED ${failingUrl}`) }),
		)
		assert.notInclude(described, SECRET)
		// The diagnosis still survives — redaction must not cost the cause.
		assert.include(described, "ECONNREFUSED")
	})

	it("keeps the cause when there is nothing to redact", () => {
		const described = describeUpstreamFailure(
			new Error("Transport error", { cause: new Error("getaddrinfo ENOTFOUND electric") }),
		)
		assert.include(described, "Transport error")
		assert.include(described, "ENOTFOUND")
	})

	it("falls back to a name rather than interpolating an empty message", () => {
		// `Cause.TimeoutError` carries no `message`.
		const nameless = new Error()
		nameless.name = "TimeoutError"
		assert.include(describeUpstreamFailure(nameless), "TimeoutError")
	})
})

describe("buildUpstreamShapeUrl", () => {
	it("pins table + org scope and targets /v1/shape", () => {
		const { url, params } = buildUrl("dashboards")
		assert.strictEqual(url.pathname, "/v1/shape")
		assert.strictEqual(params.get("table"), "dashboards")
		assert.strictEqual(params.get("where"), `"org_id" = $1`)
		assert.strictEqual(params.get("params[1]"), "org_123")
	})

	it("org-scopes every whitelisted shape via the positional param", () => {
		// The tenant boundary, asserted across the whole whitelist rather than one
		// shape: a new entry can never ship without `"org_id" = $1` leading its WHERE
		// (a shape's own `extraWhere` may only narrow it further, never replace it).
		for (const shape of SHAPE_NAMES) {
			const { params } = buildUrl(shape, { scopeValue: "scope_1" })
			assert.match(params.get("where") ?? "", /^"org_id" = \$1(?: AND |$)/, shape)
			assert.strictEqual(params.get("params[1]"), "org_123", shape)
		}
	})

	it("forwards only the reserved cursor params from the client", () => {
		const { params } = buildUrl("dashboards", {
			query: "offset=42_7&handle=abc&live=true&cursor=99&shape=dashboards",
		})
		assert.strictEqual(params.get("offset"), "42_7")
		assert.strictEqual(params.get("handle"), "abc")
		assert.strictEqual(params.get("live"), "true")
		assert.strictEqual(params.get("cursor"), "99")
		// The Maple `shape` selector is not forwarded upstream.
		assert.isNull(params.get("shape"))
	})

	it("forwards Electric's cache-recovery params so the client can escape a stale CDN entry", () => {
		// When Electric rotates a shape handle, @electric-sql/client re-requests with
		// `expired_handle` (and a `cache-buster`) set to bust Cloudflare's cache of our
		// upstream fetch. If the proxy drops them the upstream URL is unchanged, the CDN
		// keeps serving the expired-handle response, and the client spins in an infinite
		// 409 loop. So these MUST reach Electric.
		const { params } = buildUrl("alert_rules", {
			query: "offset=-1&expired_handle=130-9999&cache-buster=1751742000000&shape=alert_rules",
		})
		assert.strictEqual(params.get("expired_handle"), "130-9999")
		assert.strictEqual(params.get("cache-buster"), "1751742000000")
	})

	it("never lets the client override the pinned table / where / params / columns", () => {
		const { params } = buildUrl("dashboards", {
			query: "table=api_keys&where=1%3D1&params%5B1%5D=org_victim&columns=org_id%2Csecret&replica=full",
		})
		// Pinned values win; the injected ones are ignored entirely.
		assert.strictEqual(params.get("table"), "dashboards")
		assert.strictEqual(params.get("where"), `"org_id" = $1`)
		assert.strictEqual(params.get("params[1]"), "org_123")
		assert.isNull(params.get("columns"))
		assert.isNull(params.get("replica"))
	})

	it("pins a shape's column projection and drops the secret columns", () => {
		const columns = buildUrl("alert_destinations").params.get("columns")?.split(",") ?? []
		// PK + org scope must be present for Electric.
		assert.include(columns, "id")
		assert.include(columns, "org_id")
		// The public config the browser renders is allowed…
		assert.include(columns, "config_json")
		// …but the encrypted secret columns must never be projected.
		assert.notInclude(columns, "secret_ciphertext")
		assert.notInclude(columns, "secret_iv")
		assert.notInclude(columns, "secret_tag")
	})

	it("projects only safe API-key display fields", () => {
		const { params } = buildUrl("api_keys")
		const columns = params.get("columns")?.split(",") ?? []
		assert.strictEqual(params.get("table"), "api_keys")
		assert.strictEqual(params.get("where"), `"org_id" = $1`)
		assert.include(columns, "id")
		assert.include(columns, "org_id")
		assert.include(columns, "key_prefix")
		assert.include(columns, "scopes")
		assert.notInclude(columns, "key_hash")
		assert.notInclude(columns, "metadata_json")
	})

	it("never lets the client widen a column-restricted shape back to secrets", () => {
		const columns =
			buildUrl("alert_destinations", {
				query: "columns=id%2Corg_id%2Csecret_ciphertext%2Csecret_iv%2Csecret_tag",
			})
				.params.get("columns")
				?.split(",") ?? []
		assert.notInclude(columns, "secret_ciphertext")
		assert.include(columns, "config_json")
	})

	/**
	 * The investigation shapes are the first parameterised ones. Org alone is too
	 * wide: an org accumulates investigations forever and a browser renders one, so
	 * an org-wide shape would stream the whole history to read a single page.
	 */
	it("narrows a scoped shape to one investigation, positionally", () => {
		const { params } = buildUrl("investigation", { scopeValue: "inv_1" })
		assert.strictEqual(params.get("table"), "investigations")
		assert.strictEqual(params.get("where"), `"org_id" = $1 AND "id" = $2`)
		assert.strictEqual(params.get("params[1]"), "org_123")
		assert.strictEqual(params.get("params[2]"), "inv_1")

		const lanes = buildUrl("investigation_lens_runs", { scopeValue: "inv_1" }).params
		assert.strictEqual(lanes.get("where"), `"org_id" = $1 AND "investigation_id" = $2`)
		assert.strictEqual(lanes.get("params[2]"), "inv_1")
	})

	/**
	 * The scope value is bound as `$2`, never interpolated — so a value carrying
	 * SQL is inert data, and the column it is compared against comes from our own
	 * whitelist rather than the request.
	 */
	it("binds a hostile scope value as a parameter rather than into the WHERE", () => {
		const { params } = buildUrl("investigation", { scopeValue: `x" OR "org_id" <> '` })
		assert.strictEqual(params.get("where"), `"org_id" = $1 AND "id" = $2`)
		assert.strictEqual(params.get("params[2]"), `x" OR "org_id" <> '`)
	})

	it("projects only the investigation columns the page renders", () => {
		const columns =
			buildUrl("investigation", { scopeValue: "inv_1" }).params.get("columns")?.split(",") ?? []
		assert.include(columns, "id")
		assert.include(columns, "org_id")
		assert.include(columns, "report_json")
		// Needed to filter lanes to the live attempt, exactly as the service does.
		assert.include(columns, "fanout_attempt")
		// Nothing renders the planner's transcript; it is also the largest column.
		assert.notInclude(columns, "plan_json")
		assert.notInclude(columns, "workflow_instance_id")

		const lanes =
			buildUrl("investigation_lens_runs", { scopeValue: "inv_1" }).params.get("columns")?.split(",") ??
			[]
		assert.include(lanes, "progress_note")
		assert.include(lanes, "started_at")
		assert.notInclude(lanes, "evidence_json")
		assert.notInclude(lanes, "hypothesis_json")
	})

	it("adds Electric Cloud source credentials only when provided", () => {
		const without = buildUrl("dashboards").params
		assert.isNull(without.get("source_id"))
		assert.isNull(without.get("secret"))

		const withCreds = buildUrl("dashboards", { sourceId: "src_1", secret: "sh_secret" }).params
		assert.strictEqual(withCreds.get("source_id"), "src_1")
		assert.strictEqual(withCreds.get("secret"), "sh_secret")
	})

	it("tolerates a trailing slash on the Electric base URL", () => {
		const { url } = buildUrl("dashboards", { electricUrl: "http://electric:3000/" })
		assert.strictEqual(url.pathname, "/v1/shape")
		assert.strictEqual(url.host, "electric:3000")
	})
})

/**
 * The upstream half, driven through a stubbed `fetch` — the repo idiom from
 * `apps/scraper/src/ApiClient.test.ts`. These are the paths that had no coverage
 * at all while the transport was welded into the route.
 */
describe("ElectricClient.fetchShape", () => {
	const clientLayer = (config: Parameters<typeof syncConfigLayer>[0] = {}) =>
		ElectricClient.layer.pipe(
			Layer.provide(Layer.mergeAll(FetchHttpClient.layer, syncConfigLayer(config))),
		)

	const withFetch = (recorded: Array<RecordedRequest>, respond: () => Response) =>
		Effect.provideService(FetchHttpClient.Fetch, stubFetch(recorded, respond))

	it.effect("sends the org-scoped upstream URL and returns the upstream response", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const electric = yield* ElectricClient
			const response = yield* electric
				.fetchShape(shapeRequest("dashboards", { query: "offset=-1" }), "org_live")
				.pipe(
					withFetch(recorded, () =>
						Response.json([{ key: "row" }], { headers: { "electric-handle": "h1" } }),
					),
				)

			const { params } = parse(recorded[0]?.url ?? "")
			assert.strictEqual(params.get("table"), "dashboards")
			assert.strictEqual(params.get("params[1]"), "org_live")
			assert.strictEqual(params.get("offset"), "-1")
			assert.strictEqual(response.status, 200)
			assert.strictEqual(response.headers["electric-handle"], "h1")
		}).pipe(Effect.provide(clientLayer())),
	)

	/**
	 * The browser's session bearer authenticates the caller to US. Electric
	 * authenticates on its own source credentials, and forwarding a user's token to
	 * a third-party service would be a credential leak.
	 */
	it.effect("never forwards the caller's Authorization header upstream", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const electric = yield* ElectricClient
			yield* electric
				.fetchShape(shapeRequest("dashboards"), "org_live")
				.pipe(withFetch(recorded, () => Response.json([])))

			assert.isUndefined(recorded[0]?.headers.authorization)
		}).pipe(Effect.provide(clientLayer())),
	)

	it.effect("attaches Electric Cloud credentials from config", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const electric = yield* ElectricClient
			yield* electric
				.fetchShape(shapeRequest("dashboards"), "org_live")
				.pipe(withFetch(recorded, () => Response.json([])))

			const { params } = parse(recorded[0]?.url ?? "")
			assert.strictEqual(params.get("source_id"), "src_1")
			assert.strictEqual(params.get("secret"), "sh_secret")
		}).pipe(
			Effect.provide(
				clientLayer({
					ELECTRIC_SOURCE_ID: Option.some("src_1"),
					ELECTRIC_SECRET: Option.some(Redacted.make("sh_secret")),
				}),
			),
		),
	)

	it.effect("turns a transport failure into a typed unreachable error", () =>
		Effect.gen(function* () {
			const electric = yield* ElectricClient
			const error = yield* electric.fetchShape(shapeRequest("dashboards"), "org_live").pipe(
				Effect.provideService(FetchHttpClient.Fetch, () => {
					throw new Error("ECONNREFUSED")
				}),
				Effect.flip,
			)

			assert.strictEqual(error._tag, "@maple/electric-sync/ElectricUpstreamUnreachable")
			// The cause survives into the message — this is what the old mutable
			// `upstreamFailure` closure variable existed to smuggle out.
			assert.include(error.message, "ECONNREFUSED")
			assert.include(error.message, "dashboards")
		}).pipe(Effect.provide(clientLayer())),
	)

	it.effect("turns an upstream 5xx into a typed error carrying status, body and headers", () =>
		Effect.gen(function* () {
			const electric = yield* ElectricClient
			const error = yield* electric.fetchShape(shapeRequest("dashboards"), "org_live").pipe(
				withFetch([], () => new Response("electric exploded", { status: 503 })),
				Effect.flip,
			)

			assert.strictEqual(error._tag, "@maple/electric-sync/ElectricUpstreamError")
			if (error._tag !== "@maple/electric-sync/ElectricUpstreamError") throw new Error("unreachable")
			assert.strictEqual(error.status, 503)
			assert.strictEqual(error.body, "electric exploded")
			assert.include(error.message, "electric exploded")
		}).pipe(Effect.provide(clientLayer())),
	)

	it.effect("truncates a huge upstream body in the span message but not in the response", () =>
		Effect.gen(function* () {
			const electric = yield* ElectricClient
			const huge = "x".repeat(1000)
			const error = yield* electric.fetchShape(shapeRequest("dashboards"), "org_live").pipe(
				withFetch([], () => new Response(huge, { status: 500 })),
				Effect.flip,
			)

			if (error._tag !== "@maple/electric-sync/ElectricUpstreamError") throw new Error("unreachable")
			// A status description is not a place to put a whole payload…
			assert.isBelow(error.message.length, 400)
			// …but the client still gets what Electric actually said.
			assert.strictEqual(error.body, huge)
		}).pipe(Effect.provide(clientLayer())),
	)

	/** A `fetch` that hangs until the test releases it. */
	const pendingFetch = () => {
		let release: (response: Response) => void = () => {}
		const pending = new Promise<Response>((resolve) => {
			release = resolve
		})
		return { fetch: (() => pending) as typeof globalThis.fetch, release }
	}

	it.effect("fails a non-live request that exceeds the upstream timeout", () =>
		Effect.gen(function* () {
			const electric = yield* ElectricClient
			const upstream = pendingFetch()
			const fiber = yield* Effect.forkChild(
				electric
					.fetchShape(shapeRequest("dashboards", { query: "offset=-1" }), "org_live")
					.pipe(Effect.provideService(FetchHttpClient.Fetch, upstream.fetch), Effect.flip),
			)
			yield* TestClock.adjust(Duration.millis(0))

			yield* TestClock.adjust(Duration.seconds(31))
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error._tag, "@maple/electric-sync/ElectricUpstreamUnreachable")
			// The span must be able to say a timeout is what happened, not `undefined`.
			assert.include(error.message, "Timeout")
		}).pipe(Effect.provide(clientLayer())),
	)

	/**
	 * `live` requests long-poll: Electric holds the connection ~20s waiting for a
	 * change and then answers. A timeout that fired on them would sever every
	 * healthy poll and put the client into a permanent reconnect loop, so it must
	 * not apply — here the upstream answers well past the non-live ceiling and the
	 * request still succeeds.
	 */
	it.effect("does not time out a live long-poll", () =>
		Effect.gen(function* () {
			const electric = yield* ElectricClient
			const upstream = pendingFetch()
			const fiber = yield* Effect.forkChild(
				electric
					.fetchShape(shapeRequest("dashboards", { query: "live=true&offset=42_7" }), "org_live")
					.pipe(Effect.provideService(FetchHttpClient.Fetch, upstream.fetch)),
			)
			yield* TestClock.adjust(Duration.millis(0))

			yield* TestClock.adjust(Duration.seconds(31))
			upstream.release(Response.json([{ key: "row" }]))

			const response = yield* Fiber.join(fiber)
			assert.strictEqual(response.status, 200)
		}).pipe(Effect.provide(clientLayer())),
	)
})
