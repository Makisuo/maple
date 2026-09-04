/**
 * Maple's own durable chat transport, replacing Flue's `/agents/maple-chat/:id` surface.
 *
 *   GET  /api/chat/sessions/:sessionId/history          materialized transcript + resume cursor
 *   POST /api/chat/sessions/:sessionId/messages         submit a prompt, start the turn
 *   GET  /api/chat/sessions/:sessionId/events?cursor=N  resumable SSE tail
 *   POST /api/chat/sessions/:sessionId/abort            stop the running turn
 *
 * These are a raw `HttpRouter` rather than `HttpApi` endpoints because the event stream is SSE:
 * `HttpApi` models request/response pairs with a decoded success type, and there is no honest way
 * to describe an open-ended `text/event-stream` in that shape. The cost of dropping out of
 * `HttpApi` is that status mapping is hand-rolled, so every failure below names its own status —
 * including auth, which is why `resolveSession` catches the tenant-resolution errors explicitly
 * instead of letting them escape the raw router as a 500.
 *
 * **Tenancy.** The org is recovered from the session id (`"<orgId>:<tabId>"`) and matched against
 * the caller's resolved tenant. It is never taken from a body or header, so a client cannot address
 * another org's conversation by asking nicely — the same deny-by-default rule Flue's
 * `instanceIdFromAgentPath` guard enforced, kept at the one place that now matters.
 *
 * **Lifetime.** No handler here runs a turn. `beginTurn` starts it inside the Durable Object, which
 * owns its own lifetime; a turn forked off this request would be cancelled the moment the 202 was
 * written.
 */
import {
	ChatHistoryResponse,
	ChatSendRequest,
	ChatSendResponse,
	encodeChatTurnTenant,
	orgIdFromChatSessionId,
	type ChatTurnTenantEncoded,
} from "@maple/domain/chat-session"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { chatSessionStub, type ChatSessionStub } from "@/chat/session"
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

/**
 * A Durable Object call that did not complete.
 *
 * DO stubs reject on overload, on eviction mid-call, and when a request exceeds its limits.
 * `Effect.promise` would promote those to defects — a 500 with no domain error, and, in the turn
 * path, a defect escaping into a recovery handler that fails the same way.
 */
class ChatSessionUnavailableError extends Schema.TaggedError<ChatSessionUnavailableError>()(
	"@maple/api/chat/ChatSessionUnavailableError",
	{ operation: Schema.String },
) {
	override get message(): string {
		return `Chat session ${this.operation} is temporarily unavailable`
	}
}

const sessionCall = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: () => new ChatSessionUnavailableError({ operation }),
	})

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
 * The caller's identity, encoded for the Durable Object hop.
 *
 * Durable Object RPC serializes with structured clone, which refuses class instances — so what
 * crosses has to be a plain object, not a schema instance. Encoding here (rather than handing over
 * the branded values directly) also means the DO receives exactly the declared wire shape.
 */
const toChatTurnTenant = (tenant: TenantContext): ChatTurnTenantEncoded =>
	encodeChatTurnTenant({
		orgId: tenant.orgId,
		userId: tenant.userId,
		roles: tenant.roles,
		authMode: tenant.authMode,
		...(!(tenant.actorId === undefined) ? { actorId: tenant.actorId } : undefined),
	})

interface ResolvedSession {
	readonly sessionId: string
	readonly tenant: TenantContext
	readonly stub: ChatSessionStub
	readonly url: URL
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

	// Unauthenticated and bad-credential requests are 401, not the 500 an uncaught `McpAuth*Error`
	// would produce out of a raw router. `Effect.option` rather than `catchTags` because the
	// resolver's whole error channel *is* the two auth failures.
	const tenant: Option.Option<TenantContext> = yield* Effect.option(resolveHttpMcpTenant)
	if (Option.isNone(tenant)) {
		return { ok: false, failure: problem("Authentication required", 401) } as const
	}

	if (tenant.value.orgId !== sessionOrgId) {
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

	const session: ResolvedSession = { sessionId, tenant: tenant.value, stub, url }
	return { ok: true, session } as const
})

const cursorParam = (url: URL): number => {
	const raw = Number(url.searchParams.get("cursor") ?? "0")
	return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
}

export const ChatSessionsRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		yield* router.add("GET", "/api/chat/sessions/:sessionId/history", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure
				const { stub } = resolved.session
				const result = yield* sessionCall("history", () =>
					Promise.all([stub.history(), stub.cursor(), stub.running()]),
				).pipe(Effect.option)
				if (Option.isNone(result)) return problem("The chat session is unavailable", 503)
				const [messages, cursor, running] = result.value
				return json(
					encodeHistory(new ChatHistoryResponse({ messages: [...messages], cursor, running })),
				)
			}),
		)

		yield* router.add("POST", "/api/chat/sessions/:sessionId/messages", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure
				const { sessionId, tenant, stub } = resolved.session

				const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
				const parsed = yield* decodeSendRequest(body).pipe(Effect.option)
				if (parsed._tag === "None" || parsed.value.text.trim() === "") {
					return problem("A non-empty `text` is required", 400)
				}

				const messageId = crypto.randomUUID()
				// `beginTurn` claims the slot, records the user message AND starts the turn, all
				// inside the Durable Object. This request answers in milliseconds and deliberately
				// does not run the turn: anything forked off it here would be cancelled as soon as
				// the response was written.
				const claimed = yield* sessionCall("beginTurn", () =>
					stub.beginTurn({
						sessionId,
						messageId,
						text: parsed.value.text,
						tenant: toChatTurnTenant(tenant),
					}),
				).pipe(Effect.option)

				if (Option.isNone(claimed)) return problem("The chat session is unavailable", 503)
				if (claimed.value === undefined) {
					return problem("A turn is already running for this conversation", 409)
				}

				return json(
					encodeSend(new ChatSendResponse({ cursor: claimed.value.cursor, messageId })),
					202,
				)
			}),
		)

		yield* router.add("GET", "/api/chat/sessions/:sessionId/events", (request) =>
			Effect.gen(function* () {
				const resolved = yield* resolveSession(request)
				if (!resolved.ok) return resolved.failure
				const { stub, url } = resolved.session
				const start = cursorParam(url)

				// Replay-then-tail as one stream, framed and pushed by the Durable Object itself.
				//
				// This route used to re-enter `stub.tail(cursor)` per batch, which put a
				// Worker→Durable Object round trip in front of every *visible* update in the
				// browser. `subscribe` is one RPC for the whole connection: the DO holds the write
				// end and enqueues frames as events land, so the RTT is paid at connect and the
				// cadence in the browser is the model's, not the network's.
				//
				// The DO closes the stream on `turn-end` or after its idle window. Both are
				// *reconnect* points, not the end of the conversation — the client resumes from the
				// cursor it built out of the `id:` fields.
				const body = yield* sessionCall("subscribe", () => stub.subscribe(start)).pipe(Effect.option)
				if (Option.isNone(body)) return problem("The chat session is unavailable", 503)

				const events = Stream.fromReadableStream({
					evaluate: () => body.value,
					onError: (cause) => cause,
				}).pipe(
					// A DO failure mid-stream ends the response cleanly; the client resumes from its
					// cursor, so a dropped subscription costs a reconnect, not the conversation.
					Stream.catch(() => Stream.empty),
				)

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
				// No message id from the caller: the Durable Object knows which message holds the
				// turn, and a caller-supplied one named a message that never existed — so the
				// `turn-end` it recorded matched nothing and no client ever cleared its streaming
				// state.
				const aborted = yield* sessionCall("abort", () => resolved.session.stub.abort()).pipe(
					Effect.option,
				)
				if (Option.isNone(aborted)) return problem("The chat session is unavailable", 503)
				return HttpServerResponse.empty({ status: 204 })
			}),
		)
	}),
)
