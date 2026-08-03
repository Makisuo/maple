/**
 * Maple's own durable chat transport, replacing Flue's `/agents/maple-chat/:id` surface.
 *
 *   GET  /api/chat/sessions/:sessionId/history          materialized transcript + resume cursor
 *   POST /api/chat/sessions/:sessionId/messages         submit a prompt, run the turn
 *   GET  /api/chat/sessions/:sessionId/events?cursor=N  resumable SSE tail
 *   POST /api/chat/sessions/:sessionId/abort            stop the running turn
 *
 * These are a raw `HttpRouter` rather than `HttpApi` endpoints because the event stream is SSE:
 * `HttpApi` models request/response pairs with a decoded success type, and there is no honest way
 * to describe an open-ended `text/event-stream` in that shape.
 *
 * **Tenancy.** The org is recovered from the session id (`"<orgId>:<tabId>"`) and matched against
 * the caller's resolved tenant. It is never taken from a body or header, so a client cannot address
 * another org's conversation by asking nicely — the same deny-by-default rule Flue's
 * `instanceIdFromAgentPath` guard enforced, kept at the one place that now matters.
 */
import {
	ChatHistoryResponse,
	ChatSendRequest,
	ChatSendResponse,
	orgIdFromChatSessionId,
	type ChatEvent,
} from "@maple/domain/chat-session"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { chatSessionStub, runChatSessionTurn } from "@/chat/session"
import { InvestigationService } from "@/services/errors/InvestigationService"
import type { TenantContext } from "@/services/auth/tenant-context"
import { resolveHttpMcpTenant } from "@/mcp/lib/query-warehouse"

const json = (body: unknown, status = 200) =>
	HttpServerResponse.text(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	})

const problem = (message: string, status: number) => json({ message }, status)

const encodeHistory = Schema.encodeUnknownSync(ChatHistoryResponse)
const encodeSend = Schema.encodeUnknownSync(ChatSendResponse)
const decodeSendRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatSendRequest))

/** `/api/chat/sessions/<encoded id>/<action>` — the id may itself contain `:` and `/`-unsafe bytes. */
const sessionIdFromPath = (pathname: string): string | undefined => {
	const match = /^\/api\/chat\/sessions\/([^/]+)\/[a-z]+$/.exec(pathname)
	if (!match?.[1]) return undefined
	try {
		return decodeURIComponent(match[1])
	} catch {
		return undefined
	}
}

/**
 * Resolve the session, authorising the caller against the org encoded in its id.
 * Returns an error response instead of the stub when anything does not line up.
 */
const resolveSession = Effect.fn("chat.resolveSession")(function* (
	request: HttpServerRequest.HttpServerRequest,
) {
	const url = new URL(request.url, "http://internal")
	const sessionId = sessionIdFromPath(url.pathname)
	if (!sessionId) return { ok: false, failure: problem("Malformed chat session id", 400) } as const

	const sessionOrgId = orgIdFromChatSessionId(sessionId)
	if (!sessionOrgId) return { ok: false, failure: problem("Malformed chat session id", 400) } as const

	const tenant: TenantContext = yield* resolveHttpMcpTenant
	if (tenant.orgId !== sessionOrgId) {
		// Deliberately 404, not 403: confirming that another org's conversation exists is itself
		// a leak.
		return { ok: false, failure: problem("Chat session not found", 404) } as const
	}

	const env = yield* WorkerEnvironment
	const stub = chatSessionStub(env, sessionId)
	if (!stub) {
		return {
			ok: false,
			failure: problem("Chat sessions are not configured on this deployment", 503),
		} as const
	}

	return { ok: true, sessionId, tenant, env, stub, url } as const
})

const cursorParam = (url: URL): number => {
	const raw = Number(url.searchParams.get("cursor") ?? "0")
	return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
}

/**
 * One SSE frame per event. `id:` carries the seq so a client that drops mid-stream resumes from
 * exactly where it stopped rather than re-reading the whole log.
 */
const frame = (event: ChatEvent): string => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`

export const ChatSessionsRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		yield* router.add("GET", "/api/chat/sessions/:sessionId/history", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure
				const [messages, cursor, running] = yield* Effect.promise(() =>
					Promise.all([resolved.stub.history(), resolved.stub.cursor(), resolved.stub.running()]),
				)
				return json(
					encodeHistory(new ChatHistoryResponse({ messages: [...messages], cursor, running })),
				)
			}),
		)

		yield* router.add("POST", "/api/chat/sessions/:sessionId/messages", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure

				const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
				const parsed = yield* decodeSendRequest(body).pipe(Effect.option)
				if (parsed._tag === "None" || parsed.value.text.trim() === "") {
					return problem("A non-empty `text` is required", 400)
				}

				const messageId = crypto.randomUUID()
				const claimed = yield* Effect.promise(() =>
					resolved.stub.beginTurn(messageId, parsed.value.text),
				)
				if (!claimed) return problem("A turn is already running for this conversation", 409)

				// The turn is a background fiber: the POST answers as soon as the user's message is
				// durable, and the client picks the assistant's output up from the event stream. That
				// split is what makes the transport resumable — the response to this request is not
				// the turn, so losing it loses nothing.
				// `forkDetach`, not a scoped fork: the turn must outlive this request. v4 has no
				// `forkDaemon`; `forkDetach` is the detached-lifetime equivalent.
				// `InvestigationService` is resolved here rather than inside the turn so the turn
				// module stays free of the service graph — see the note on `SubmitDiagnosis`.
				const investigations = yield* InvestigationService
				yield* Effect.forkDetach(
					runChatSessionTurn({
						sessionId: resolved.sessionId,
						tenant: resolved.tenant,
						env: resolved.env,
						stub: resolved.stub,
						messageId,
						submitDiagnosis: investigations.submitDiagnosis,
					}),
				)

				return json(encodeSend(new ChatSendResponse({ cursor: claimed.cursor, messageId })), 202)
			}),
		)

		yield* router.add("GET", "/api/chat/sessions/:sessionId/events", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure
				const start = cursorParam(resolved.url)
				const stub = resolved.stub

				// Replay-then-tail as one stream. `paginateEffect` keeps the cursor in the stream's
				// own state, so there is no shared mutable position between the replay and the tail.
				const events = Stream.paginate(start, (cursor: number) =>
					Effect.promise(() => stub.tail(cursor)).pipe(
						Effect.map((batch) => {
							const last = batch[batch.length - 1]
							// A turn-end is the last frame of a turn: stop so the client reconnects
							// deliberately for the next one rather than holding an idle connection
							// open against the Worker's request budget. An empty batch means the tail
							// timed out or the conversation is settled — also stop.
							const ended =
								last === undefined || batch.some((event) => event.type === "turn-end")
							return [
								batch as ReadonlyArray<ChatEvent>,
								ended ? Option.none<number>() : Option.some(last.seq),
							] as const
						}),
					),
				).pipe(Stream.map(frame), Stream.encodeText)

				return HttpServerResponse.stream(events, {
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache, no-transform",
						// Some proxies buffer SSE without this; a buffered chat stream looks hung.
						"x-accel-buffering": "no",
					},
				})
			}),
		)

		yield* router.add("POST", "/api/chat/sessions/:sessionId/abort", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure
				yield* Effect.promise(() => resolved.stub.abort(crypto.randomUUID()))
				return HttpServerResponse.empty({ status: 204 })
			}),
		)
	}),
)
