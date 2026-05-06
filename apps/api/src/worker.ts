import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLive, WorkerEnvironmentLive } from "@maple/effect-cloudflare"
import { Context, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app"
import { runWithSessionBindings, sessionStore } from "./mcp/lib/session-store"
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
// ANY middleware — even a pass-through — unsticks it. We pair the passthrough
// with `disableLogger: true` so Effect's default `HttpMiddleware.logger` does
// not double-log; application logs flow through the OTLP logger installed by
// `telemetry.layer`. Earlier attempt (commit 769032b0) dropped the passthrough
// and relied on `disableLogger: true` alone — that brings back the original
// hang in prod because Effect treats `disableLogger:true` + no middleware as
// "no middleware at all", which is the failing condition.
const passthroughMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) => httpApp

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
		{ middleware: passthroughMiddleware, disableLogger: true },
	)

// Single isolate-wide handler — `toWebHandler` builds its own ManagedRuntime
// once and keeps it for the lifetime of the isolate. Built eagerly at module
// load so a layer construction failure surfaces as a startup error in
// `wrangler tail` instead of silently hanging the first request and bricking
// the isolate (Cloudflare 1101).
const cachedHandler = buildHandler()
const getHandler = () => cachedHandler

// Time-box every handler call so a single hung request returns a useful 504
// instead of waiting for the Cloudflare runtime to kill it as 1101 with no
// stack. CF's hard limit is ~30s; we cut at 25s to leave headroom for the
// timeout response itself.
const HANDLER_TIMEOUT_MS = 25_000

const isMcpPost = (request: Request): boolean => {
	if (request.method !== "POST") return false
	try {
		return new URL(request.url).pathname === "/mcp"
	} catch {
		return false
	}
}

interface McpSessionsBinding {
	readonly get: (key: string, type: "json") => Promise<unknown>
	readonly put: (key: string, value: string, options?: { readonly expirationTtl?: number }) => Promise<void>
}

const readMcpSessionsBinding = (env: Record<string, unknown>): McpSessionsBinding | undefined => {
	const candidate = env.MCP_SESSIONS
	if (candidate && typeof candidate === "object" && "get" in candidate && "put" in candidate) {
		return candidate as McpSessionsBinding
	}
	return undefined
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
	})
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer)
	}) as Promise<T>
}

const handle = async (
	request: Request,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<Response> => {
	if (isMcpPost(request)) {
		const sid = request.headers.get("mcp-session-id")
		if (sid) await sessionStore.preload(sid)
	}
	const { handler } = getHandler()
	try {
		const response = await withTimeout(
			handler(request, Context.empty() as never),
			HANDLER_TIMEOUT_MS,
			"worker handler",
		)
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
		runWithSessionBindings({ ctx, kv: readMcpSessionsBinding(env) }, () => handle(request, env, ctx)),
}
