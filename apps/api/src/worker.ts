import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLive, WorkerEnvironmentLive } from "@maple/effect-cloudflare"
import { Context, FileSystem, Layer, Path } from "effect"
import { HttpRouter } from "effect/unstable/http"
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

// `disableLogger: true` skips Effect's default `HttpMiddleware.logger`. When it
// wraps the MCP route the RpcServer's response queue never closes, so the
// Promise from `toWebHandler` never resolves (Cloudflare 1101 in prod,
// miniflare "worker hung" locally). The upstream Effect McpServer test uses
// the same flag. Application logs still flow through the OTLP logger installed
// by `telemetry.layer`.
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
		{ disableLogger: true },
	)

// Single isolate-wide handler — `toWebHandler` builds its own ManagedRuntime
// once and keeps it for the lifetime of the isolate. Building it per-request
// would defeat the runtime's isolate-level reuse.
let cachedHandler: ReturnType<typeof buildHandler> | undefined
const getHandler = () => (cachedHandler ??= buildHandler())

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
	const response = await handler(request, Context.empty() as never)
	ctx.waitUntil(telemetry.flush(env))
	return response
}

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
		runWithSessionBindings({ ctx, kv: readMcpSessionsBinding(env) }, () => handle(request, env, ctx)),
}
