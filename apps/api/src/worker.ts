import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLive, WorkerEnvironmentLive } from "@maple/effect-cloudflare"
import { Context, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
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
// ANY middleware — even a pass-through — unsticks it. Paired with
// `disableLogger: true` so Effect's default `HttpMiddleware.logger` does not
// double-log; application logs flow through the OTLP logger installed by
// `telemetry.layer`.
const passThroughMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) => httpApp

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
		{ middleware: passThroughMiddleware, disableLogger: true },
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

type McpFrame = { method: string; id: string }

// Peek the JSON-RPC body without consuming the request stream. Returns the
// first frame's method and id (string-coerced; "-" if absent). Tolerates batch
// payloads and malformed JSON — diagnostics only, never throws.
const peekMcpFrame = (body: string): McpFrame => {
	try {
		const parsed = JSON.parse(body)
		const first = Array.isArray(parsed) ? parsed[0] : parsed
		const method = typeof first?.method === "string" ? first.method : "-"
		const id =
			first?.id === undefined || first?.id === null ? "-" : String(first.id)
		return { method, id }
	} catch {
		return { method: "-", id: "-" }
	}
}

// The handler should never throw under normal operation — Effect surfaces
// errors as HTTP responses. If it does (layer construction failure, fatal
// runtime error), we surface it as a 504 outside Effect.
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

	// MCP diagnostics: buffer the body so we can peek the JSON-RPC method/id
	// before handing it off to Effect, then re-emit the request with the
	// buffered body so the inner handler still sees a readable stream.
	let forwardRequest = request
	let mcpFrame: McpFrame | null = null
	const startedAt = Date.now()
	if (isMcp) {
		const bodyText = await request.text()
		mcpFrame = peekMcpFrame(bodyText)
		forwardRequest = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: bodyText,
		})
		console.log(
			`[mcp-in] method=${mcpFrame.method} id=${mcpFrame.id}` +
				` sid=${reqSid ?? "-"} body_len=${bodyText.length}`,
		)
	}

	if (kv && reqSid) await preloadSession(kv, reqSid)

	const { handler } = getHandler()
	try {
		const response = await handler(forwardRequest, Context.empty() as never)
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
		if (isMcp && mcpFrame) {
			console.log(
				`[mcp-out] method=${mcpFrame.method} id=${mcpFrame.id}` +
					` status=${response.status} dur=${Date.now() - startedAt}ms` +
					` body_len=${response.headers.get("content-length") ?? "-"}` +
					` resp_sid=${response.headers.get("mcp-session-id") ?? "-"}`,
			)
		}
		ctx.waitUntil(telemetry.flush(env))
		return response
	} catch (err) {
		console.error("[worker] handler failed:", err)
		if (isMcp && mcpFrame) {
			console.error(
				`[mcp-err] method=${mcpFrame.method} id=${mcpFrame.id}` +
					` dur=${Date.now() - startedAt}ms`,
			)
		}
		ctx.waitUntil(telemetry.flush(env))
		const message = err instanceof Error ? err.message : String(err)
		return new Response(`worker handler error: ${message}`, { status: 504 })
	}
}

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
		handle(request, env, ctx),
}
