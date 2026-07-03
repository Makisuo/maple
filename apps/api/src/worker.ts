import type { MessageBatch, ScheduledController } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_TAGS } from "@maple/domain/anticipated-errors"
import { runScheduledEffect, WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Context, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { persistSession, preloadSession, type SessionsBinding } from "./mcp/lib/session-store"

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
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	dropSpanNames: ["McpServer/Notifications."],
	// Expected 4xx outcomes (validation, not-found, unauthorized, …) record as
	// Ok spans instead of errors — see @maple/domain/anticipated-errors.
	anticipatedErrorTags: [...ANTICIPATED_ERROR_TAGS],
})

// `HttpMiddleware.tracer` ends the root server span on a deferred macrotask
// (`scheduleTask(span.end, 0)`), but `telemetry.flush` drains synchronously.
// Flushing immediately after the response loses the server span — its macrotask
// hasn't fired yet. Isolated requests (e.g. a GitHub webhook) freeze the isolate
// before a subsequent request rescues it, so the trace is silently dropped.
// Yield one macrotask first so `span.end` runs before we drain.
const flushTelemetry = async (env: Record<string, unknown>): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
	await telemetry.flush(env)
}

// POST /mcp hangs indefinitely on Cloudflare Workers when `toWebHandler` is
// called with no middleware (1101 in prod, miniflare "worker hung" locally).
// Suspected Effect RpcServer / HttpRouter scope-propagation bug. Providing
// ANY middleware — even a pass-through — unsticks it. Paired with
// `disableLogger: true` so Effect's default `HttpMiddleware.logger` does not
// double-log; application logs flow through the OTLP logger installed by
// `telemetry.layer`.
const passThroughMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) => httpApp

// The route graph (`./app`) and the D1 layer are imported DYNAMICALLY, not at
// module scope. The static import graph reachable from `./app` eagerly builds
// hundreds of Effect Schema ASTs (`@maple/domain` + 47 MCP tool schemas) at
// module-evaluation time. Cloudflare runs only the top-level module scope
// during upload validation, so pulling that work in statically blew the fixed
// ~1s startup CPU budget (error 10021). Deferring it behind `import()` keeps
// the top level near-empty; the cost moves to the first request, which runs
// under the far larger per-request CPU budget.
const buildHandler = async () => {
	const { AllRoutes, ApiAuthLive, InternalServiceAuthLive, ApiObservabilityLive, MainLive } =
		await import("./app")
	const { DatabasePgLive } = await import("./lib/DatabasePgLive")
	return HttpRouter.toWebHandler(
		AllRoutes.pipe(
			Layer.provideMerge(MainLive),
			Layer.provideMerge(ApiAuthLive),
			Layer.provideMerge(InternalServiceAuthLive),
			Layer.provideMerge(ApiObservabilityLive),
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(DatabasePgLive),
			Layer.provideMerge(WorkerEnvironment.layer),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
		{ middleware: passThroughMiddleware, disableLogger: true },
	)
}

// Single isolate-wide handler — `toWebHandler` builds its own ManagedRuntime
// lazily on first invocation and keeps it for the lifetime of the isolate.
// Memoized via the build promise so concurrent first requests share one build;
// a construction failure surfaces as a 504 in `handle` rather than bricking the
// isolate.
let handlerPromise: ReturnType<typeof buildHandler> | undefined
const getHandler = () => (handlerPromise ??= buildHandler())

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
		const id = first?.id === undefined || first?.id === null ? "-" : String(first.id)
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

	const { handler } = await getHandler()
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
		ctx.waitUntil(flushTelemetry(env))
		return response
	} catch (err) {
		console.error("[worker] handler failed:", err)
		if (isMcp && mcpFrame) {
			console.error(
				`[mcp-err] method=${mcpFrame.method} id=${mcpFrame.id}` + ` dur=${Date.now() - startedAt}ms`,
			)
		}
		ctx.waitUntil(flushTelemetry(env))
		const message = err instanceof Error ? err.message : String(err)
		return new Response(`worker handler error: ${message}`, { status: 504 })
	}
}

// Cloudflare requires Workflow classes to be exported from the worker entry.
// The class is a thin shell that dynamic-imports its heavy logic inside run(),
// so this static export keeps module-scope evaluation light (startup-CPU budget).
export { ClickHouseSchemaApplyWorkflow } from "./workflows/ClickHouseSchemaApplyWorkflow"
export { AiTriageWorkflow } from "./workflows/AiTriageWorkflow"

// VCS sync queue consumer. Dynamic-imported (same startup-CPU-budget discipline
// as the route graph above) to keep module-scope evaluation light.
const handleQueue = async (
	batch: MessageBatch<unknown>,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<void> => {
	const { buildVcsSyncLayer, processBatch, flushVcsTelemetry } = await import("./vcs-sync-runtime")
	try {
		await runScheduledEffect(buildVcsSyncLayer(env), processBatch(batch), ctx)
	} finally {
		ctx.waitUntil(flushVcsTelemetry(env))
	}
}

// Cron expressions (must match `crons` in alchemy.run.ts). Dispatched on
// `event.cron` since the worker now registers more than one schedule.
const BILLING_RECONCILE_CRON = "0 6 * * *"

// Daily billing-suspension reconcile: promote overdue-≥3d-and-never-paid orgs to
// suspended, clear orgs that have paid.
const handleBillingReconcile = async (
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<void> => {
	const { buildBillingSuspensionLayer, runBillingSuspensionReconcile, flushBillingTelemetry } =
		await import("./billing-suspension-runtime")
	try {
		await runScheduledEffect(buildBillingSuspensionLayer(env), runBillingSuspensionReconcile, ctx)
	} finally {
		ctx.waitUntil(flushBillingTelemetry(env))
	}
}

// Periodic VCS sync (every 12h): enqueue a refresh per installation.
const handleVcsScheduledSync = async (
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<void> => {
	const { buildVcsScheduledLayer, runScheduledSync, flushVcsTelemetry } = await import("./vcs-sync-runtime")
	try {
		await runScheduledEffect(buildVcsScheduledLayer(env), runScheduledSync, ctx)
	} finally {
		ctx.waitUntil(flushVcsTelemetry(env))
	}
}

// Cron handler — route by the firing schedule. The billing reconcile is matched
// explicitly; every other expression (i.e. the 12h VCS sync) falls through.
const handleScheduled = async (
	cron: string,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<void> => {
	if (cron === BILLING_RECONCILE_CRON) {
		await handleBillingReconcile(env, ctx)
		return
	}
	await handleVcsScheduledSync(env, ctx)
}

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
		handle(request, env, ctx),
	queue: (batch: MessageBatch<unknown>, env: Record<string, unknown>, ctx: ExecutionContext) =>
		handleQueue(batch, env, ctx),
	scheduled: (event: ScheduledController, env: Record<string, unknown>, ctx: ExecutionContext) =>
		handleScheduled(event.cron, env, ctx),
}
