// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import type { MessageBatch, ScheduledController } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "./mcp/expected-failures"
import {
	layerFromEnvRecord,
	runScheduledEffect,
	WorkerConfigProviderLayer,
	WorkerEnvironment,
} from "@maple/effect-cloudflare"
import { WorkerEntrypoint } from "cloudflare:workers"
import { Cause, Context, Effect, Exit, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { HttpRouter, type HttpMiddleware } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { serverErrorSpanMiddleware } from "./http/server-error-span"
import { v2WorkerUnavailableResponse } from "./http/v2-worker-unavailable"
import { API_CORS_RESPONSE_HEADERS, apiCorsPreflightResponse } from "./http/api-cors"
import { persistSession, preloadSession, type SessionsBinding } from "./mcp/lib/session-store"
import { makeRecoverablePromiseMemo } from "./platform/recoverable-promise-memo"
import { classifyWorkerQueue } from "./queue-dispatch"

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
	HttpPlatform.HttpPlatform,
	HttpPlatform.make({
		platform: "web",
		compression: HttpPlatform.makeCompressionWeb({
			algorithms: ["gzip", "deflate"],
			transform: (algorithm) => HttpPlatform.compressionTransformWeb(algorithm),
		}),
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

// HttpRouter accepts an immutable request-local context. The worker does not
// inject per-request services here, so reuse the same empty value rather than
// rebuilding it on every invocation.
const HandlerContext = Context.empty() as never

// Construct telemetry once at module scope — `layer` is stable, `flush(env)`
// resolves env lazily on first call. Including `telemetry.layer` in the
// handler's layer composition is the critical bit: the Tracer reference must
// live in the same runtime as the routes that emit spans.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	dropSpanNames: ["McpServer/Notifications."],
	// Expected 4xx outcomes (validation, not-found, unauthorized, …) record as
	// Ok spans instead of errors — see @maple/domain/anticipated-errors.
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS, ...MCP_ANTICIPATED_ERROR_IDENTIFIERS],
})

/**
 * Install one Postgres connection for the whole of `program`.
 *
 * The scope module is imported dynamically for the same reason the route graph
 * is: keeping it off module scope protects the worker's fixed startup-CPU
 * budget.
 */
const scoped = async <A, E, R>(program: Effect.Effect<A, E, R>) => {
	const { withPgConnectionScope } = await import("@/platform/pg-connection-scope")
	return withPgConnectionScope(program)
}

// The service graph, HTTP graph, and database layer are imported DYNAMICALLY,
// not at module scope. The static import graph reachable from the HTTP graph eagerly builds
// hundreds of Effect Schema ASTs (`@maple/domain` + 47 MCP tool schemas) at
// module-evaluation time. Cloudflare runs only the top-level module scope
// during upload validation, so pulling that work in statically blew the fixed
// ~1s startup CPU budget (error 10021). Deferring it behind `import()` keeps
// the top level near-empty; the cost moves to the first request, which runs
// under the far larger per-request CPU budget.
const buildHandler = async () => {
	const [
		{ HttpServicesLive },
		{ AllRoutes, ApiAuthLive, ApiObservabilityLive },
		{ layerPg },
		{ pgConnectionMiddleware },
	] = await Promise.all([
		import("./runtime/service-graph"),
		import("./runtime/http-graph"),
		import("@/platform/DatabasePgLive"),
		import("@/platform/pg-connection-scope"),
	])
	// The worker's one per-request middleware stack. Ordering is load-bearing:
	// `serverErrorSpanMiddleware` must stay OUTERMOST (directly under
	// `HttpMiddleware.tracer`) so it converts a 5xx success into the failure the
	// tracer records — after `pgConnectionMiddleware`'s exit-agnostic `ensuring`
	// has already released the request's Postgres socket. It also keeps a
	// standing requirement satisfied: POST /mcp hangs indefinitely on Workers
	// when `toWebHandler` is given NO middleware (1101 in prod, miniflare
	// "worker hung" locally — suspected Effect RpcServer / HttpRouter
	// scope-propagation bug), so this slot must never go back to empty.
	const apiRequestMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) =>
		serverErrorSpanMiddleware(pgConnectionMiddleware(httpApp))
	return HttpRouter.toWebHandler(
		AllRoutes.pipe(
			Layer.provideMerge(HttpServicesLive),
			Layer.provideMerge(ApiAuthLive),
			Layer.provideMerge(ApiObservabilityLive),
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(WorkerEnvironment.layer),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
		// `disableLogger: true` stops Effect's default logger double-logging;
		// application logs flow through the OTLP logger from `telemetry.layer`.
		{ middleware: apiRequestMiddleware, disableLogger: true },
	)
}

// Single isolate-wide handler — `toWebHandler` builds its own ManagedRuntime
// lazily on first invocation and keeps it for the lifetime of the isolate.
// Memoized via the build promise so concurrent first requests share one build.
// A rejected build is cleared after those callers observe it, allowing a later
// request to recover instead of pinning the isolate to a rejected promise.
const handlerMemo = makeRecoverablePromiseMemo(buildHandler)

// RPC has no HttpApi request to construct the application services for it, so
// it gets a sibling isolate-wide ManagedRuntime. Its headless service graph
// stays behind a dynamic import, preserving the worker's startup-CPU budget.
const buildRpcRuntime = async (env: Record<string, unknown>) => {
	const [{ InvestigationServicesLive }, { layerPg }] = await Promise.all([
		import("./runtime/mcp-service-graph"),
		import("@/platform/DatabasePgLive"),
	])
	const runtime = ManagedRuntime.make(
		InvestigationServicesLive.pipe(
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(layerFromEnvRecord(env)),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	)
	try {
		// ManagedRuntime also acquires lazily and retains a failed build fiber.
		// Acquire before resolving the recoverable outer promise so a later RPC
		// can construct a fresh runtime after an initialization failure.
		await runtime.context()
		return runtime
	} catch (error) {
		await runtime.dispose()
		throw error
	}
}

const rpcRuntimeMemo = makeRecoverablePromiseMemo(buildRpcRuntime)

type InternalRpcMethod = "listMcpTools" | "callMcpTool" | "submitDiagnosis"

const ALCHEMY_RPC_ERROR_TAG = "~alchemy/rpc/error" as const

// Alchemy's schemaless RPC error envelope is deliberately tiny. Keeping this
// encoder local avoids pulling its full Worker bridge into an already large API
// bundle; alchemy's `toRpcAsync` on the caller side decodes this exact public
// wire shape.
const encodeRpcError = (error: unknown): unknown => {
	if (error == null || typeof error !== "object") return error
	const object = error as Record<string, unknown>
	if (typeof object._tag === "string") {
		const encoded = Object.fromEntries(Object.keys(object).map((key) => [key, object[key]]))
		if (error instanceof Error && !("message" in encoded)) encoded.message = error.message
		return encoded
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack }
	}
	return error
}

const runInternalRpc = async (
	method: InternalRpcMethod,
	input: unknown,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
) => {
	const [runtime, { callMcpToolRpc, listMcpToolsRpc, submitDiagnosisRpc }] = await Promise.all([
		rpcRuntimeMemo.get(env),
		import("./internal-rpc"),
	])
	let exit: Exit.Exit<unknown, unknown>
	// The RPC runtime is isolate-wide, so the scope goes around each call rather
	// than around the runtime — one socket per RPC invocation, released with it.
	switch (method) {
		case "listMcpTools":
			exit = await runtime.runPromiseExit(await scoped(listMcpToolsRpc))
			break
		case "callMcpTool":
			exit = await runtime.runPromiseExit(await scoped(callMcpToolRpc(input)))
			break
		case "submitDiagnosis":
			exit = await runtime.runPromiseExit(await scoped(submitDiagnosisRpc(input)))
			break
	}
	ctx.waitUntil(telemetry.flush(env))
	if (exit._tag === "Success") return exit.value
	const defect = exit.cause.reasons.find(Cause.isDieReason)
	if (defect) throw defect.defect
	const failure = exit.cause.reasons.find(Cause.isFailReason)
	if (failure) {
		return {
			_tag: ALCHEMY_RPC_ERROR_TAG,
			error: encodeRpcError(failure.error),
		}
	}
	throw new Error("RPC method failed with an unexpected cause")
}

const isMcpPost = (request: Request): boolean => {
	if (request.method !== "POST") return false
	try {
		return new URL(request.url).pathname === "/mcp"
	} catch {
		return false
	}
}

const isV2Request = (request: Request): boolean => {
	try {
		const pathname = new URL(request.url).pathname
		return pathname === "/v2" || pathname.startsWith("/v2/")
	} catch {
		return false
	}
}

/**
 * Liveness does not need the domain graph, service graph, authentication,
 * database scope, route codecs, or telemetry runtime. Keeping it
 * bootstrap-safe also lets a cold isolate report health when an unrelated
 * application binding is unavailable.
 */
const isHealthRequest = (request: Request): boolean => {
	if (request.method !== "GET") return false
	try {
		return new URL(request.url).pathname === "/health"
	} catch {
		return false
	}
}

const healthResponse = (): Response =>
	new Response("OK", {
		headers: { ...API_CORS_RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8" },
	})

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
	if (isHealthRequest(request)) return healthResponse()
	if (request.method === "OPTIONS") return apiCorsPreflightResponse()

	const isMcp = isMcpPost(request)
	const kv = isMcp ? readMcpSessionsBinding(env) : undefined
	const reqSid = isMcp ? request.headers.get("mcp-session-id") : null
	// Start the expensive cold handler build and the independent KV read before
	// buffering an MCP body. Warm requests resolve both promises immediately;
	// cold MCP requests hide module evaluation and KV latency behind body I/O.
	const pendingHandler = handlerMemo.get()
	const pendingSession = kv && reqSid ? preloadSession(kv, reqSid) : undefined

	// MCP diagnostics: buffer the body so we can peek the JSON-RPC method/id
	// before handing it off to Effect, then re-emit the request with the
	// buffered body so the inner handler still sees a readable stream.
	let forwardRequest = request
	let mcpFrame: McpFrame | null = null
	const startedAt = isMcp ? Date.now() : undefined
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

	try {
		const built = pendingSession
			? (await Promise.all([pendingHandler, pendingSession]))[0]
			: await pendingHandler
		let response: Response
		try {
			response = await built.handler(forwardRequest, HandlerContext)
		} catch (error) {
			// `toWebHandler` acquires lazily and pins a rejected inner build.
			// Evict only the exact wrapper used by this request so the next real
			// request can rebuild it; overlapping failures cannot clear a retry.
			if (handlerMemo.evict(pendingHandler)) await built.dispose()
			throw error
		}
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
		if (isMcp && mcpFrame && startedAt !== undefined) {
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
		const message = err instanceof Error ? err.message : String(err)
		Effect.runFork(
			Effect.logError("API worker handler failed").pipe(
				Effect.annotateLogs({
					error: message,
					method: request.method,
					url: request.url,
				}),
				// One-shot recovery fiber after the main handler runtime rejected.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(telemetry.layer),
			),
		)
		if (isMcp && mcpFrame && startedAt !== undefined) {
			console.error(
				`[mcp-err] method=${mcpFrame.method} id=${mcpFrame.id}` + ` dur=${Date.now() - startedAt}ms`,
			)
		}
		ctx.waitUntil(telemetry.flush(env))
		return isV2Request(request)
			? v2WorkerUnavailableResponse()
			: new Response("The API worker is temporarily unavailable.", { status: 504 })
	}
}

// Cloudflare requires Workflow classes to be exported from the worker entry.
// The class is a thin shell that dynamic-imports its heavy logic inside run(),
// so this static export keeps module-scope evaluation light (startup-CPU budget).
export { ClickHouseSchemaApplyWorkflow } from "./workflows/ClickHouseSchemaApplyWorkflow"
export { InvestigationFanoutWorkflow } from "./workflows/InvestigationFanoutWorkflow"
// The durable chat transcript. Safe to export at module scope despite the 10021 startup-CPU
// constraint: `ChatSession` imports only types from `@maple/domain/chat-session`, so it pulls
// none of the app service graph in with it.
export { ChatSession } from "./chat/ChatSession"

// VCS sync queue consumer. Dynamic-imported (same startup-CPU-budget discipline
// as the route graph above) to keep module-scope evaluation light.
const handleQueue = async (
	batch: MessageBatch<unknown>,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<void> => {
	const queueKind = classifyWorkerQueue(batch.queue, env)
	if (queueKind === "planetscale-webhook") {
		const {
			buildPlanetScaleWebhookLayer,
			processPlanetScaleWebhookBatch,
			flushPlanetScaleWebhookTelemetry,
		} = await import("./planetscale-webhook-runtime")
		try {
			await runScheduledEffect(
				buildPlanetScaleWebhookLayer(env),
				await scoped(processPlanetScaleWebhookBatch(batch)),
				ctx,
			)
		} finally {
			ctx.waitUntil(flushPlanetScaleWebhookTelemetry(env))
		}
		return
	}
	if (queueKind === "unknown") {
		throw new Error(`No queue consumer configured for "${batch.queue}"`)
	}

	const { buildVcsSyncLayer, processBatch, flushVcsTelemetry } = await import("./vcs-sync-runtime")
	try {
		await runScheduledEffect(buildVcsSyncLayer(env), await scoped(processBatch(batch)), ctx)
	} finally {
		ctx.waitUntil(flushVcsTelemetry(env))
	}
}

// Cron handler. Three schedules (see wrangler.jsonc / alchemy.run.ts
// `triggers.crons`), dispatched on `event.cron`:
//   "0 */12 * * *" — enqueue a periodic VCS sync per installation
//   "0 * * * *"    — apply scrape-check retention
//   "0 */6 * * *"  — Slack workspace reconciliation
// Retention is hourly rather than 12-hourly because a busy target can write
// ~75k check rows a day, so the 10k-row cap binds within a few hours.
const SCRAPE_RETENTION_CRON = "0 * * * *"
// Backstop for the Railway bot's app_uninstalled/tokens_revoked detection
// (apps/slack-agent → POST /internal/slack/workspaces/:teamId/revoke) —
// doesn't need to be tight, it only catches a forward call the bot never
// made (crash, network blip) or installs that predate that wiring.
const SLACK_RECONCILE_CRON = "0 */6 * * *"

const handleScheduled = async (
	event: ScheduledController,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<void> => {
	if (event.cron === SCRAPE_RETENTION_CRON) {
		const { buildScrapeRetentionLayer, flushVcsTelemetry } = await import("./vcs-sync-runtime")
		const { runScrapeCheckRetention } = await import("@/services/integrations/scrape-check-retention")
		const { runPlanetScaleEventRetention } =
			await import("@/services/integrations/planetscale-event-retention")
		try {
			// Both sweeps ride this one cron: each new cron string costs an entry in
			// wrangler.jsonc and alchemy.run.ts, and neither needs its own beat.
			// Sequential, not concurrent — they share one Postgres socket for the
			// whole tick, so running them concurrently would only queue on it.
			await runScheduledEffect(
				buildScrapeRetentionLayer(env),
				await scoped(Effect.andThen(runScrapeCheckRetention, runPlanetScaleEventRetention)),
				ctx,
				{ onInterrupt: "graceful" },
			)
		} finally {
			ctx.waitUntil(flushVcsTelemetry(env))
		}
		return
	}

	if (event.cron === SLACK_RECONCILE_CRON) {
		const { buildSlackReconcileLayer, runSlackReconciliation, flushSlackTelemetry } =
			await import("./slack-reconcile-runtime")
		try {
			await runScheduledEffect(
				buildSlackReconcileLayer(env),
				await scoped(runSlackReconciliation),
				ctx,
				{ onInterrupt: "graceful" },
			)
		} finally {
			ctx.waitUntil(flushSlackTelemetry(env))
		}
		return
	}

	const { buildVcsScheduledLayer, runScheduledSync, flushVcsTelemetry } = await import("./vcs-sync-runtime")
	try {
		// Graceful on interrupt: a teardown mid-cron is expected lifecycle, and the
		// schedule reruns — only the queue consumer above must keep rejecting so an
		// interrupted batch redelivers instead of acking.
		await runScheduledEffect(buildVcsScheduledLayer(env), await scoped(runScheduledSync), ctx, {
			onInterrupt: "graceful",
		})
	} finally {
		ctx.waitUntil(flushVcsTelemetry(env))
	}
}

/**
 * Class entrypoint keeps fetch/queue/cron intact while publishing Alchemy's
 * schemaless RPC methods over a Cloudflare service binding. RPC failures are
 * encoded with Alchemy's wire envelope so a plain Worker caller can recover tagged
 * Effect errors via `toRpcAsync`.
 */
export default class MapleApiWorker extends WorkerEntrypoint<Record<string, unknown>> {
	override fetch(request: Request): Promise<Response> {
		return handle(request, this.env, this.ctx)
	}

	override queue(batch: MessageBatch<unknown>): Promise<void> {
		return handleQueue(batch, this.env, this.ctx)
	}

	override scheduled(event: ScheduledController): Promise<void> {
		return handleScheduled(event, this.env, this.ctx)
	}

	listMcpTools() {
		return runInternalRpc("listMcpTools", undefined, this.env, this.ctx)
	}

	callMcpTool(input: unknown) {
		return runInternalRpc("callMcpTool", input, this.env, this.ctx)
	}

	submitDiagnosis(input: unknown) {
		return runInternalRpc("submitDiagnosis", input, this.env, this.ctx)
	}
}
