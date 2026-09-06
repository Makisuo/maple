import { assert, describe, it } from "@effect/vitest"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { requestTelemetryLayer, workerTelemetrySdk } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { ElectricSyncRouter } from "./routes/shape.http"
import {
	noTenantLayer,
	okUpstream,
	type RecordedRequest,
	recordingElectricClient,
	stubFetch,
} from "./test-support"

/**
 * One Worker event the way alchemy's bridge runs it — `makeRequestHandler` is
 * the bridge's own fetch path (its tracer, its `causeResponse`), the SDK
 * telemetry is built into the event's scope exactly as `WorkerTelemetry`
 * registers it, and the scope closes after the same macrotask yield the bridge
 * makes. What the SDK then POSTs is what production exports.
 */
const ExportedSpan = Schema.Struct({
	name: Schema.String,
	status: Schema.Struct({
		code: Schema.optionalKey(Schema.Finite),
		message: Schema.optionalKey(Schema.String),
	}),
	attributes: Schema.Array(
		Schema.Struct({ key: Schema.String, value: Schema.Record(Schema.String, Schema.Unknown) }),
	),
})
type ExportedSpan = typeof ExportedSpan.Type

const ExportedTraces = Schema.Struct({
	resourceSpans: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(ExportedSpan) })) }),
		),
	),
})
const decodeExportedTraces = Schema.decodeUnknownSync(ExportedTraces)

const exportedSpans = (recorded: ReadonlyArray<RecordedRequest>): Array<ExportedSpan> =>
	recorded
		.filter((request) => request.url.endsWith("/v1/traces"))
		.flatMap((request) => {
			const body = decodeExportedTraces(JSON.parse(request.body ?? "{}"))
			return (body.resourceSpans ?? []).flatMap((resource) =>
				resource.scopeSpans.flatMap((scope) => scope.spans),
			)
		})

const statusCodeOf = (span: ExportedSpan | undefined): number | undefined => {
	const value = span?.attributes.find((attribute) => attribute.key === "http.response.status_code")?.value
	return value === undefined ? undefined : Number(Object.values(value)[0])
}

const appLayer = (options: { readonly ensureConfigured?: Effect.Effect<void, never> } = {}) =>
	ElectricSyncRouter.pipe(
		Layer.provide(
			recordingElectricClient({
				calls: [],
				respond: () => Effect.succeed(okUpstream()),
				...(options.ensureConfigured ? { ensureConfigured: options.ensureConfigured } : undefined),
			}),
		),
		Layer.provide(noTenantLayer),
	)

const env = { MAPLE_INGEST_KEY: "maple_sk_test", MAPLE_ENDPOINT: "http://ingest.test" }

const event = (path: string, app: ReturnType<typeof appLayer> = appLayer()) =>
	Effect.gen(function* () {
		const recorded: Array<RecordedRequest> = []
		const realFetch = globalThis.fetch
		globalThis.fetch = stubFetch(recorded, () => new Response("{}", { status: 200 }))
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				globalThis.fetch = realFetch
			}),
		)

		const isolate = yield* Scope.make()
		const handler = yield* HttpRouter.toHttpEffect(app).pipe(Scope.provide(isolate))
		const request = yield* Scope.make()
		const services = yield* Layer.buildWithScope(
			requestTelemetryLayer(workerTelemetrySdk({ serviceName: "electric-sync" })).pipe(
				Layer.provide(Layer.succeed(WorkerEnvironment, env)),
			),
			request,
		)
		const fetchEvent: Effect.Effect<Response, unknown, Scope.Scope> | undefined =
			Cloudflare.Workers.makeRequestHandler(handler)({
				kind: "Cloudflare.Workers.WorkerEvent",
				type: "fetch",
				input: new Request(`http://sync.maple.test${path}`),
			})
		assert.isDefined(fetchEvent)
		const response = yield* fetchEvent!.pipe(Effect.provide(services), Scope.provide(request))
		const flushedBeforeClose = recorded.length
		yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
		yield* Scope.close(request, Exit.void)
		yield* Scope.close(isolate, Exit.void)
		const spans = exportedSpans(recorded)
		return {
			status: response.status,
			flushedBeforeClose,
			server: spans.filter((span) => span.name === "http.server GET"),
		}
	}).pipe(Effect.scoped)

describe("electric-sync through alchemy's Worker bridge", () => {
	it.effect("an unmatched route answers 404, recorded as an Ok server span", () =>
		Effect.gen(function* () {
			const { status, flushedBeforeClose, server } = yield* event("/nope")
			assert.strictEqual(status, 404)
			assert.strictEqual(flushedBeforeClose, 0)
			assert.strictEqual(server.length, 1)
			assert.notStrictEqual(server[0]?.status.code, 2 /* Error */)
			assert.strictEqual(statusCodeOf(server[0]), 404)
		}),
	)

	it.effect("an expected rejection answers 400, recorded as an Ok server span", () =>
		Effect.gen(function* () {
			const { status, server } = yield* event("/api/sync/shape?shape=users&offset=-1")
			assert.strictEqual(status, 400)
			assert.strictEqual(server.length, 1)
			assert.notStrictEqual(server[0]?.status.code, 2 /* Error */)
			assert.strictEqual(statusCodeOf(server[0]), 400)
		}),
	)

	it.effect("a defect answers 500, recorded as an Error server span", () =>
		Effect.gen(function* () {
			const { status, server } = yield* event(
				"/api/sync/shape?shape=alert_rules&offset=-1",
				appLayer({ ensureConfigured: Effect.die(new Error("boom")) }),
			)
			assert.strictEqual(status, 500)
			assert.strictEqual(server.length, 1)
			assert.strictEqual(server[0]?.status.code, 2 /* Error */)
			assert.strictEqual(statusCodeOf(server[0]), 500)
		}),
	)
})
