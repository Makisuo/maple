import * as Cloudflare from "@maple-dev/effect-sdk/cloudflare"
import {
	WorkerConfigProviderLive,
	WorkerEnvironmentLive,
	withRequestRuntime,
} from "@maple/effect-cloudflare"
import { FileSystem, Layer, Path } from "effect"
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

// POST /mcp hangs indefinitely when `toWebHandler` is called with no `middleware`
// option (Cloudflare 1101 worker timeout in prod, miniflare "worker hung" locally).
// Providing ANY middleware — even a pass-through — unsticks it. Suspected Effect
// RpcServer / HttpRouter scope-propagation bug when only the default logger is
// installed. Remove this once upstream fixes it.
const passthroughMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) => httpApp

const buildHandler = (_env: Record<string, unknown>) =>
	HttpRouter.toWebHandler(
		AllRoutes.pipe(
			Layer.provideMerge(MainLive),
			Layer.provideMerge(ApiAuthLive),
			Layer.provideMerge(ApiObservabilityLive),
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(DatabaseD1Live),
			Layer.provideMerge(WorkerEnvironmentLive),
			Layer.provideMerge(WorkerConfigProviderLive),
		),
		{ middleware: passthroughMiddleware },
	)

const handlerCache = new WeakMap<object, ReturnType<typeof buildHandler>>()

const getHandler = (env: Record<string, unknown>) => {
	const key = env as object
	const existing = handlerCache.get(key)
	if (existing) return existing
	const built = buildHandler(env)
	handlerCache.set(key, built)
	return built
}

// `Cloudflare.make` builds a custom flushable OTLP tracer + Effect logger
// (no upstream background fiber — explicit flush only). Cached once per
// isolate so the in-isolate buffer coalesces concurrent requests into one
// POST per signal. `withRequestRuntime` schedules `telemetry.flush` inside
// `ctx.waitUntil` after the response is sent.
let cachedTelemetry: Cloudflare.CloudflareTelemetry | undefined
const getTelemetry = (env: Record<string, unknown>): Cloudflare.CloudflareTelemetry => {
	if (!cachedTelemetry) cachedTelemetry = Cloudflare.make(env, { serviceName: "maple-api" })
	return cachedTelemetry
}

const makeRequestTelemetryLayer = (env: Record<string, unknown>) => getTelemetry(env).layer

const isMcpPost = (request: Request): boolean => {
	if (request.method !== "POST") return false
	try {
		return new URL(request.url).pathname === "/mcp"
	} catch {
		return false
	}
}

const inner = withRequestRuntime(
	makeRequestTelemetryLayer,
	async (request, services, env) => {
		if (isMcpPost(request)) {
			const sid = request.headers.get("mcp-session-id")
			if (sid) await sessionStore.preload(sid)
		}
		const { handler } = getHandler(env)
		return handler(request, services as any)
	},
	{ flushables: (env) => [getTelemetry(env)] },
)

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

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
		runWithSessionBindings({ ctx, kv: readMcpSessionsBinding(env) }, () => inner(request, env, ctx)),
}
