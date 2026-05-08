import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLive, WorkerEnvironmentLive } from "@maple/effect-cloudflare"
import { Context, Duration, Effect, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app"
import { persistSession, preloadSession, type SessionsBinding } from "./mcp/lib/session-store"
import { DatabaseD1Live } from "./services/DatabaseD1Live"

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
	HttpPlatform.HttpPlatform,
	HttpPlatform.make({
		fileResponse: (_path, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
		fileWebResponse: (_file, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
	}),
).pipe(Layer.provideMerge(WorkerFileSystemLive), Layer.provideMerge(Etag.layer))

const WorkerPlatformLive = Layer.mergeAll(
	Path.layer,
	Etag.layer,
	WorkerFileSystemLive,
	WorkerHttpPlatformLive,
)

// Construct telemetry once at module scope — `layer` is stable, `flush(env)`
// resolves env lazily on first call. Including `telemetry.layer` in the
// handler's layer composition is the critical bit: the Tracer reference must
// live in the same runtime as the routes that emit spans.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	dropSpanNames: ["McpServer/Notifications."],
})

// POST /mcp hangs indefinitely on Cloudflare Workers when `toWebHandler` is
// called with no middleware (1101 in prod, miniflare "worker hung" locally).
// Suspected Effect RpcServer / HttpRouter scope-propagation bug. Providing
// ANY middleware — even a pass-through — unsticks it. We pair this with
// `disableLogger: true` so Effect's default `HttpMiddleware.logger` does
// not double-log; application logs flow through the OTLP logger installed by
// `telemetry.layer`.
//
// The middleware also enforces a per-request timeout. This MUST live inside
// the Effect runtime (not as an outer `Promise.race`) because that's the only
// way the timeout interrupts the inner fiber. Interruption runs `withSpan`
// finalizers in reverse, which calls `end()` on every open span and pushes
// it into the export buffer. An outer `Promise.race` rejects without
// interrupting — finalizers never run, spans never end, and the failed
// request becomes invisible in traces.
//
// 22s leaves margin under CF's 30s wall-clock cap for the post-response
// `telemetry.flush(env)` to drain the buffer to OTLP.
const REQUEST_TIMEOUT = Duration.seconds(22)

const requestTimeoutMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) =>
	Effect.timeoutOrElse(httpApp, {
		duration: REQUEST_TIMEOUT,
		orElse: () =>
			Effect.gen(function* () {
				const req = yield* HttpServerRequest.HttpServerRequest
				const url = (() => {
					try {
						return new URL(req.url).pathname
					} catch {
						return req.url
					}
				})()
				console.warn(
					`[timeout] ${req.method} ${url} hit ${Duration.toMillis(REQUEST_TIMEOUT)}ms cap` +
						` auth=${req.headers.authorization ? "yes" : "no"}` +
						` mcp-session=${req.headers["mcp-session-id"] ?? "-"}`,
				)
				return HttpServerResponse.text(
					`request timed out after ${Duration.toMillis(REQUEST_TIMEOUT)}ms`,
					{ status: 504 },
				)
			}),
	})

const buildHandler = () =>
	HttpRouter.toWebHandler(
		AllRoutes.pipe(
			Layer.provideMerge(MainLive),
			Layer.provideMerge(ApiAuthLive),
			Layer.provideMerge(ApiObservabilityLive),
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(DatabaseD1Live),
			Layer.provideMerge(WorkerEnvironmentLive),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLive),
		),
		{ middleware: requestTimeoutMiddleware, disableLogger: true },
	)

// Single isolate-wide handler — `toWebHandler` builds its own ManagedRuntime
// once and keeps it for the lifetime of the isolate. Built eagerly at module
// load so a layer construction failure surfaces as a startup error in
// `wrangler tail` instead of silently hanging the first request and bricking
// the isolate (Cloudflare 1101).
const cachedHandler = buildHandler()
const getHandler = () => cachedHandler

const isMcpPost = (request: Request): boolean => {
	if (request.method !== "POST") return false
	try {
		return new URL(request.url).pathname === "/mcp"
	} catch {
		return false
	}
}

const readMcpSessionsBinding = (env: Record<string, unknown>): SessionsBinding | undefined => {
	const candidate = env.MCP_SESSIONS
	if (candidate && typeof candidate === "object" && "get" in candidate && "put" in candidate) {
		return candidate as SessionsBinding
	}
	return undefined
}

// Per-request timeout lives in `requestTimeoutMiddleware` above so that
// finalizers run on interrupt and traces export. If the handler still throws
// (layer construction failure, fatal runtime error), we surface it as a 504
// outside Effect — these are rare and not the trace-export hot path.
//
// MCP session persistence runs OUTSIDE the Effect runtime on purpose. Effect's
// fiber scheduler doesn't reliably propagate AsyncLocalStorage through every
// generator resumption / scope finalizer / forked fiber, so reading a binding
// via ALS from inside an `override set()` on the clientSessions Map silently
// no-ops in some paths — sessions stay in-memory only and the next isolate 404s.
// Driving the KV preload+put from this outer async context means the bindings
// come from `env` directly — no AsyncLocalStorage required.
const handle = async (
	request: Request,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<Response> => {
	const kv = readMcpSessionsBinding(env)
	const isMcp = isMcpPost(request)
	const reqSid = isMcp ? request.headers.get("mcp-session-id") : null

	if (kv && reqSid) await preloadSession(kv, reqSid)

	const { handler } = getHandler()
	try {
		const response = await handler(request, Context.empty() as never)
		if (kv && isMcp) {
			const resSid = response.headers.get("mcp-session-id")
			// Only persist when the server issued a new session — i.e. on
			// `initialize`, where the response sid differs from the request sid
			// (or the request had none). Subsequent requests echo the same sid;
			// re-putting on every call would burn KV write quota for no reason.
			if (resSid && resSid !== reqSid) {
				const put = persistSession(kv, resSid)
				if (put) ctx.waitUntil(put)
			}
		}
		ctx.waitUntil(telemetry.flush(env))
		return response
	} catch (err) {
		console.error("[worker] handler failed:", err)
		ctx.waitUntil(telemetry.flush(env))
		const message = err instanceof Error ? err.message : String(err)
		return new Response(`worker handler error: ${message}`, { status: 504 })
	}
}

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
		handle(request, env, ctx),
}
