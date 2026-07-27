import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry"
import { instrument, observe } from "@flue/runtime"
import { flue } from "@flue/runtime/routing"
import { SpanKind } from "@opentelemetry/api"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { instanceIdFromAgentPath, verifyInternalServiceToken, verifyRequest } from "./lib/auth.ts"
import type { ChatFlueEnv } from "./lib/env.ts"
import { orgIdFromInstanceId } from "./lib/org.ts"
import {
	CHAT_FLUE_SERVICE_NAME,
	emitTelemetryLog,
	rootContextFromRequest,
	setupTelemetry,
} from "./lib/telemetry.ts"
import { enterSpan } from "./lib/tracing.ts"
import { appEnv } from "./lib/app-env.ts"
import { telemetryEnv } from "./lib/telemetry-env.ts"

// ---------------------------------------------------------------------------
// Telemetry bridge
// ---------------------------------------------------------------------------
// `observe` is isolate-local, and this module's top-level body runs in every
// isolate the Flue-generated entry loads — the worker AND the chat-agent /
// triage Durable Objects — so the OTel observer is registered wherever the
// model/tool/run events actually fire. When MAPLE_INGEST_KEY is set we ALSO ship
// Flue events as OpenTelemetry spans to Maple's ingest (the Flue OTel adapter →
// `maple-chat-flue` service, GenAI `chat` spans, `flue.tool`/`flue.operation`,
// etc.). Independently of that, structured error + per-turn outcome logging is
// registered UNCONDITIONALLY (below): those lines reach Workers Observability logs
// (→ Maple) and are the primary signal for the "chat did nothing" failure mode,
// regardless of whether the OTel export is on.
const env = await telemetryEnv()
const telemetry = setupTelemetry({
	ingestKey: env.MAPLE_INGEST_KEY,
	endpoint: env.MAPLE_ENDPOINT,
	environment: env.MAPLE_ENVIRONMENT,
	serviceVersion: env.MAPLE_SERVICE_VERSION,
	commitSha: env.COMMIT_SHA,
})

// Structured error + per-turn outcome logging — registered for EVERY isolate,
// telemetry on or off. `run_end` breadcrumbs pair with the `chat.turn` span to spot
// empty / instant "did nothing" turns and to compare model behaviour over time;
// error/tool-failure lines surface failures that the OTel spans were silently
// dropping (they don't flush reliably from DO isolates).
observe((event) => {
	if (event.type === "log" && event.level === "error") {
		emitTelemetryLog("error", "flue.log", {
			message: event.message,
			...(event.attributes ? { "flue.attributes": JSON.stringify(event.attributes) } : {}),
		})
		return
	}
	if (event.type === "run_end") {
		const errored = "isError" in event ? Boolean(event.isError) : false
		emitTelemetryLog(errored ? "error" : "info", "flue.run_end", {
			"flue.run.errored": errored,
		})
		return
	}
	if ("isError" in event && event.isError) {
		const label = "toolName" in event ? `tool ${event.toolName}` : event.type
		const detail = "error" in event ? event.error : undefined
		emitTelemetryLog("error", "flue.operation_failed", {
			"flue.operation": label,
			"error.message": detail === undefined ? "" : String(detail),
		})
	}
})

if (telemetry) {
	// Flue observations → OpenTelemetry GenAI spans. Content (prompts, model I/O,
	// tool args/results, detailed errors) is disabled by default — intentional for
	// an AI chat; a redacting `content` policy is a future opt-in.
	instrument(
		createOpenTelemetryInstrumentation({
			tracer: telemetry.getTracer(CHAT_FLUE_SERVICE_NAME),
			// Nest chat spans under the caller's (web/mobile) distributed trace
			// when it propagates `traceparent`; standalone otherwise.
			resolveRootContext: (_observation, ctx) => rootContextFromRequest(ctx.req),
		}),
	)

	// workerd flush. `BatchSpanProcessor`'s timer is unreliable across isolate
	// suspension, and Durable-Object isolates have no `ctx.waitUntil`, so force a
	// flush at Flue's own terminal boundaries. (Worker-isolate HTTP spans are
	// drained from the Hono response middleware below.)
	observe((event) => {
		if (event.type === "run_end" || event.type === "idle" || event.type === "agent_end") {
			void telemetry.forceFlush()
		}
	})
}

// ---------------------------------------------------------------------------
// HTTP application
// ---------------------------------------------------------------------------
const app = new Hono<{ Bindings: ChatFlueEnv }>()

// CORS. The web/mobile clients call this worker cross-origin (e.g.
// app.maple.dev → chat.maple.dev / *.workers.dev), so every response needs CORS
// headers. Registered FIRST so the OPTIONS preflight is answered here, before
// the `/agents/*` auth middleware — preflight requests carry no Authorization
// header and would otherwise be rejected with 401.
//
// Requests are non-credentialed (bearer token in a header, no cookies), so `*`
// origin is valid. `allowHeaders` is omitted on purpose: Hono then reflects the
// preflight's `Access-Control-Request-Headers`, covering `Authorization` plus
// whatever the Durable-Streams transport sends. The exposed `Stream-*` response
// headers are what `@flue/sdk`'s transport reads for offset/cursor bookkeeping —
// without exposing them the browser hides them and live tailing breaks.
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "OPTIONS"],
		exposeHeaders: [
			"Stream-Next-Offset",
			"Stream-Offset",
			"Stream-Cursor",
			"Stream-Seq",
			"Stream-Ttl",
			"Stream-Expires-At",
			"Stream-Closed",
			"Stream-Up-To-Date",
			"Stream-Api",
			"Stream-Forked-From",
			"Stream-Fork-Offset",
			"Stream-Response-State",
			"Stream-Response-Methods",
			"Stream-Db",
			"Stream-Level",
			"Stream-Sse-Data-Encoding",
		],
		maxAge: 86400,
	}),
)

// Drain worker-isolate spans before the isolate parks. `executionCtx` is absent
// under unit tests (`app.fetch(req, env)` with no third arg) — guard it; those
// spans flush at Flue's run/idle boundaries instead.
if (telemetry) {
	app.use("*", async (c, next) => {
		await next()
		try {
			c.executionCtx.waitUntil(telemetry.forceFlush())
		} catch {
			// No ExecutionContext available (tests) — nothing to schedule.
		}
	})
}

app.use("*", async (c, next) => {
	const request = c.req.raw
	const pathname = new URL(request.url).pathname
	if (request.method === "OPTIONS" || pathname === "/health") {
		await next()
		return
	}

	await enterSpan(
		"http.request",
		async (span) => {
			const url = new URL(request.url)
			const route = pathname.startsWith("/agents/")
				? "/agents/:agent/:instance"
				: pathname.startsWith("/workflows/")
					? "/workflows/:workflow"
					: pathname
			span.setAttribute("http.request.method", request.method)
			span.setAttribute("http.route", route)
			span.setAttribute("server.address", url.hostname)
			await next()
			span.setAttribute("http.response.status_code", c.res.status)
			if (c.res.status >= 500) {
				span.setError("HttpServerError", `HTTP ${c.res.status}`)
			}
		},
		{
			kind: SpanKind.SERVER,
			parentContext: rootContextFromRequest(request),
		},
	)
})

app.get("/health", (c) => c.json({ ok: true }))

// AuthN + per-instance authZ for direct agent access. The web client passes a
// Clerk/self-hosted session token (Authorization header, or `?token=` for the
// GET event stream, which can't set headers). The org it resolves to must own
// the addressed `"<orgId>:<tabId>"` instance — so a caller can never reach
// another org's conversation.
app.use("/agents/*", async (c, next) => {
	// Deny-by-default: every /agents/* request must carry a resolvable
	// "<orgId>:<tabId>" instance whose org matches the caller. The agent
	// transports are `/agents/<name>/<id>`; a path without an instance id is
	// rejected rather than allowed through on AuthN alone.
	const instanceId = instanceIdFromAgentPath(new URL(c.req.url).pathname)
	if (!instanceId) return c.json({ error: "Missing agent instance id" }, 400)
	const namedOrgId = orgIdFromInstanceId(instanceId)
	if (!namedOrgId) {
		return c.json({ error: "Organization does not match the addressed agent" }, 403)
	}

	// Server-to-server seeding (apps/api opening an investigation on incident-open,
	// no user present) authenticates with the internal-service token instead of a
	// user session. The token is fully trusted — same model as `/workflows/*` — so
	// the authorized org is taken from the instance id it addresses. This bypass
	// runs BEFORE the user-session check so token callers aren't rejected for
	// lacking a session.
	if (verifyInternalServiceToken(c.req.raw, appEnv(c))) {
		await next()
		return
	}

	// User session: the resolved org must own the addressed instance, so a caller
	// can never reach another org's conversation.
	const verified = await verifyRequest(c.req.raw, appEnv(c))
	if (!verified) return c.json({ error: "Authentication required" }, 401)
	if (namedOrgId !== verified.orgId) {
		return c.json({ error: "Organization does not match the addressed agent" }, 403)
	}

	await next()
})

// Internal-service guard for headless workflow invocations (apps/api → chat-flue,
// e.g. the triage workflow over the CHAT_FLUE service binding). Unlike /agents/*
// (which carry a user session token), /workflows/* is server-to-server, so it
// requires the internal-service token. Without this guard the route — which can
// run an org-scoped investigation for any org in the payload — is unauthenticated.
app.use("/workflows/*", async (c, next) => {
	if (!verifyInternalServiceToken(c.req.raw, appEnv(c))) {
		return c.json({ error: "Authentication required" }, 401)
	}
	await next()
})

// Everything else (agent prompt/stream routes, workflow invocations, run reads,
// OpenAPI) is served by Flue's generated application.
app.route("/", flue())

export default app
