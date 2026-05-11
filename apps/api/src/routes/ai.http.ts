import { createRuntimeServerClient } from "@electric-ax/agents-runtime"
import {
	decodeMapleChatEntityId,
	encodeMapleChatEntityId,
	MAPLE_CHAT_ENTITY_TYPE,
	mapleChatEntityUrl,
} from "@maple/ai"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Cause, Effect, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { AuthService, type AuthServiceShape } from "../services/AuthService"
import { Env, type EnvShape } from "../services/Env"

const OBSERVE_TOKEN_PARAM = "maple_observe_token"
const OBSERVE_TOKEN_TTL_MS = 30 * 60 * 1000

const PROXY_FORWARD_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"content-type",
	"if-none-match",
	"if-modified-since",
	"last-event-id",
	"range",
	"user-agent",
])

const json = (body: unknown, status = 200) =>
	HttpServerResponse.jsonUnsafe(body, { status, headers: { "Cache-Control": "no-store" } })

const errorJson = (message: string, status: number) => json({ error: message }, status)

const readJson = <T>(req: HttpServerRequest.HttpServerRequest) =>
	req.json.pipe(Effect.map((value) => value as T))

const makeRuntimeClient = (baseUrl: string) =>
	createRuntimeServerClient({
		baseUrl,
		fetch: globalThis.fetch.bind(globalThis),
	})

const getObserveTokenSecret = (env: EnvShape): string =>
	Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY)

const signObserveTokenPayload = (payload: string, secret: string): string =>
	createHmac("sha256", secret).update(payload).digest("base64url")

interface ObserveTokenIssued {
	readonly token: string
	readonly expiresAt: number
}

const createObserveToken = (env: EnvShape, orgId: string, sessionId: string): ObserveTokenIssued => {
	const expiresAt = Date.now() + OBSERVE_TOKEN_TTL_MS
	const payload = Buffer.from(JSON.stringify({ orgId, sessionId, exp: expiresAt })).toString(
		"base64url",
	)
	const token = `${payload}.${signObserveTokenPayload(payload, getObserveTokenSecret(env))}`
	return { token, expiresAt }
}

const verifyObserveToken = (
	env: EnvShape,
	token: string | null,
	expected: { readonly orgId: string; readonly sessionId: string },
): boolean => {
	if (!token) return false
	const [payload, signature] = token.split(".")
	if (!payload || !signature) return false
	const expectedSignature = signObserveTokenPayload(payload, getObserveTokenSecret(env))
	const signatureBuffer = Buffer.from(signature)
	const expectedBuffer = Buffer.from(expectedSignature)
	if (
		signatureBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(signatureBuffer, expectedBuffer)
	) {
		return false
	}

	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
			readonly orgId?: unknown
			readonly sessionId?: unknown
			readonly exp?: unknown
		}
		return (
			decoded.orgId === expected.orgId &&
			decoded.sessionId === expected.sessionId &&
			typeof decoded.exp === "number" &&
			decoded.exp > Date.now()
		)
	} catch {
		return false
	}
}

interface CreateSessionBody {
	readonly tabId?: string
	readonly title?: string
}

interface SendMessageBody {
	readonly text?: string
	readonly mode?: string
	readonly pageContext?: unknown
	readonly alertContext?: unknown
	readonly widgetFixContext?: unknown
	readonly dashboardContext?: unknown
	readonly approvalResponse?: {
		readonly approvalId?: string
		readonly approved?: boolean
	}
}

class RuntimeUnreachable extends Error {
	readonly _tag = "RuntimeUnreachable" as const
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "RuntimeUnreachable"
	}
}

const isNotFoundError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error)
	return /(not[\s_-]?found|404|unknown entity)/i.test(message)
}

const isAlreadyExistsError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error)
	return /(duplicate key|already exists|entities_pkey|conflict|\b409\b)/i.test(message)
}

// Build a JSON error response from any Cause — recoverable failures, defects,
// and interruptions. Guarantees we never send 5xx with an empty body: defects
// that would otherwise bypass Effect.catch and hit the framework's default
// 500-no-body handler are mapped here. The pretty cause is logged server-side
// so we can debug from telemetry while keeping the client payload tidy.
const errorResponseFromCause = (
	cause: Cause.Cause<unknown>,
	route: string,
): HttpServerResponse.HttpServerResponse => {
	const squashed = Cause.squash(cause)
	const originalError =
		squashed instanceof Error ? squashed : new Error(String(squashed ?? "unknown error"))
	const isRuntimeUnreachable = originalError instanceof RuntimeUnreachable
	const status = isRuntimeUnreachable || isTransientFetchError(originalError) ? 502 : 500
	const message = originalError.message || `Internal error (${originalError.name || "unknown"})`
	console.error(`[ai-gateway] ${route} failed (${status}):`, Cause.pretty(cause))
	return errorJson(message, status)
}

// undici's keep-alive pool will throw "fetch failed" / "Network connection lost"
// / ECONNRESET when the runtime container is bounced between requests but the
// API process holds onto stale sockets. These are transient — a single retry
// with a fresh connection almost always succeeds.
const isTransientFetchError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error)
	const causeMessage =
		error instanceof Error && error.cause instanceof Error ? error.cause.message : ""
	return /(network connection lost|fetch failed|econnreset|socket hang up|other side closed|terminated)/i.test(
		`${message} ${causeMessage}`,
	)
}

const retryOnTransient = async <T>(operation: () => Promise<T>): Promise<T> => {
	try {
		return await operation()
	} catch (error) {
		if (!isTransientFetchError(error)) throw error
		return operation()
	}
}

const ensureMapleChatEntity = async (input: {
	readonly runtimeUrl: string
	readonly orgId: string
	readonly userId: string
	readonly tabId: string
	readonly title?: string
}) => {
	const id = encodeMapleChatEntityId(input.orgId, input.tabId)
	const entityUrl = mapleChatEntityUrl(input.orgId, input.tabId)
	const client = makeRuntimeClient(input.runtimeUrl)

	try {
		await retryOnTransient(() => client.getEntityInfo(entityUrl))
		return { id, entityUrl }
	} catch (error) {
		if (isNotFoundError(error)) {
			// fall through to spawn
		} else if (isTransientFetchError(error)) {
			throw new RuntimeUnreachable(
				`Electric Agents runtime unreachable at ${input.runtimeUrl}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			)
		} else {
			throw error instanceof Error ? error : new Error(String(error))
		}
	}

	try {
		await retryOnTransient(() =>
			client.spawnEntity({
				type: MAPLE_CHAT_ENTITY_TYPE,
				id,
				args: {
					orgId: input.orgId,
					tabId: input.tabId,
					userId: input.userId,
					title: input.title,
				},
				tags: {
					org_id: input.orgId,
					tab_id: input.tabId,
					surface: "web_chat",
				},
			}),
		)
	} catch (error) {
		// A duplicate-key / "already exists" response means a prior spawn
		// half-committed the postgres row (e.g. its durable stream creation
		// crashed) or two requests raced. The entity logically exists from the
		// caller's point of view; treat it as idempotent success rather than
		// returning 502 and forcing the user to wipe volumes.
		if (isAlreadyExistsError(error)) {
			console.warn(
				`[maple-chat] entity ${id} already exists on spawn; treating as idempotent. ` +
					`Underlying error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return { id, entityUrl }
		}
		if (isTransientFetchError(error)) {
			throw new RuntimeUnreachable(
				`Failed to spawn Maple chat entity in Electric runtime at ${input.runtimeUrl}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			)
		}
		throw error instanceof Error ? error : new Error(String(error))
	}

	return { id, entityUrl }
}

const runtimeMapleChatSessionId = (pathname: string): string | null => {
	const prefix = `/api/ai/runtime/${MAPLE_CHAT_ENTITY_TYPE}/`
	if (!pathname.startsWith(prefix)) return null
	const [sessionId] = pathname.slice(prefix.length).split("/")
	return sessionId && sessionId.length > 0 ? sessionId : null
}

const authorizeRuntimeRequest = (
	req: HttpServerRequest.HttpServerRequest,
	env: EnvShape,
	auth: AuthServiceShape,
) =>
	Effect.gen(function* () {
		const incoming = new URL(req.url, "http://localhost")
		const sessionId = runtimeMapleChatSessionId(incoming.pathname)
		if (sessionId) {
			const decoded = decodeMapleChatEntityId(sessionId)
			if (!decoded) return yield* Effect.fail(new Error("Unknown chat session"))
			if (
				verifyObserveToken(env, incoming.searchParams.get(OBSERVE_TOKEN_PARAM), {
					orgId: decoded.orgId,
					sessionId,
				})
			) {
				return
			}

			const tenant = yield* auth.resolveTenant(req.headers as Record<string, string>)
			if (tenant.orgId !== decoded.orgId) {
				return yield* Effect.fail(new Error("Unknown chat session"))
			}
			return
		}

		yield* auth.resolveTenant(req.headers as Record<string, string>)
	})

const buildProxyHeaders = (incoming: Record<string, string>): Headers => {
	const headers = new Headers()
	for (const [name, value] of Object.entries(incoming)) {
		if (PROXY_FORWARD_HEADERS.has(name.toLowerCase())) headers.set(name, value)
	}
	return headers
}

const readRequestBody = async (
	req: HttpServerRequest.HttpServerRequest,
): Promise<ArrayBuffer | undefined> => {
	if (req.method === "GET" || req.method === "HEAD") return undefined
	const source = req.source as unknown
	if (source instanceof Request) return source.arrayBuffer()
	if (source instanceof ReadableStream) return new Response(source).arrayBuffer()
	if (source instanceof ArrayBuffer) return source
	return undefined
}

const proxyRuntimeRequest = (
	req: HttpServerRequest.HttpServerRequest,
	runtimeUrl: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
	Effect.tryPromise({
		try: async () => {
			const incoming = new URL(req.url, "http://localhost")
			const prefix = "/api/ai/runtime"
			const targetPath = incoming.pathname.startsWith(prefix)
				? incoming.pathname.slice(prefix.length) || "/"
				: incoming.pathname
			incoming.searchParams.delete(OBSERVE_TOKEN_PARAM)
			const target = new URL(targetPath + incoming.search, runtimeUrl)
			const headers = buildProxyHeaders(req.headers as Record<string, string>)
			const body = await readRequestBody(req)
			const response = await fetch(target, { method: req.method, headers, body })
			return HttpServerResponse.fromWeb(response)
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.succeed(errorResponseFromCause(cause, "proxyRuntimeRequest")),
		),
	)

export const AiGatewayRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
		const env = yield* Env

		yield* router.add("POST", "/api/ai/sessions", (req) =>
			Effect.gen(function* () {
				const tenant = yield* auth.resolveTenant(req.headers as Record<string, string>)
				const body = yield* readJson<CreateSessionBody>(req)
				const tabId = body.tabId?.trim()
				if (!tabId) return errorJson("tabId is required", 400)

				const session = yield* Effect.tryPromise({
					try: () =>
						ensureMapleChatEntity({
							runtimeUrl: env.ELECTRIC_AGENTS_URL,
							orgId: tenant.orgId,
							userId: tenant.userId,
							tabId,
							title: body.title,
						}),
					catch: (error) =>
						error instanceof RuntimeUnreachable
							? error
							: new Error(error instanceof Error ? error.message : String(error)),
				})

				const issued = createObserveToken(env, tenant.orgId, session.id)
				return json({
					id: session.id,
					entityUrl: session.entityUrl,
					observeToken: issued.token,
					observeTokenExpiresAt: issued.expiresAt,
				})
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(errorResponseFromCause(cause, "POST /api/ai/sessions")),
				),
			),
		)

		yield* router.add("POST", "/api/ai/sessions/:sessionId/observe-token", (req) =>
			Effect.gen(function* () {
				const tenant = yield* auth.resolveTenant(req.headers as Record<string, string>)
				const params = yield* HttpRouter.params
				const sessionId = params.sessionId
				if (!sessionId) return errorJson("sessionId is required", 400)
				const decoded = decodeMapleChatEntityId(sessionId)
				if (!decoded || decoded.orgId !== tenant.orgId) {
					return errorJson("Unknown chat session", 404)
				}
				const issued = createObserveToken(env, tenant.orgId, sessionId)
				return json({ observeToken: issued.token, observeTokenExpiresAt: issued.expiresAt })
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(
						errorResponseFromCause(cause, "POST /api/ai/sessions/:sessionId/observe-token"),
					),
				),
			),
		)

		yield* router.add("POST", "/api/ai/sessions/:sessionId/messages", (req) =>
			Effect.gen(function* () {
				const tenant = yield* auth.resolveTenant(req.headers as Record<string, string>)
				const params = yield* HttpRouter.params
				const sessionId = params.sessionId
				if (!sessionId) return errorJson("sessionId is required", 400)
				const decoded = decodeMapleChatEntityId(sessionId)
				if (!decoded || decoded.orgId !== tenant.orgId) {
					return errorJson("Unknown chat session", 404)
				}

				const body = yield* readJson<SendMessageBody>(req)
				const client = makeRuntimeClient(env.ELECTRIC_AGENTS_URL)
				const targetUrl = `/${MAPLE_CHAT_ENTITY_TYPE}/${sessionId}`

				if (body.approvalResponse) {
					const approvalId = body.approvalResponse.approvalId
					const approved = body.approvalResponse.approved
					if (!approvalId || typeof approved !== "boolean") {
						return errorJson("approvalResponse.approvalId and approved are required", 400)
					}
					yield* Effect.tryPromise({
						try: () =>
							retryOnTransient(() =>
								client.sendEntityMessage({
									targetUrl,
									from: `user:${tenant.userId}`,
									type: "approval_response",
									payload: { approvalId, approved },
								}),
							),
						catch: (error) => (error instanceof Error ? error : new Error(String(error))),
					})
					return json({ ok: true })
				}

				const text = body.text?.trim()
				if (!text) return errorJson("text is required", 400)
				yield* Effect.tryPromise({
					try: () =>
						retryOnTransient(() =>
							client.sendEntityMessage({
								targetUrl,
								from: `user:${tenant.userId}`,
								type: "user_message",
								payload: {
									text,
									mode: body.mode,
									pageContext: body.pageContext,
									alertContext: body.alertContext,
									widgetFixContext: body.widgetFixContext,
									dashboardContext: body.dashboardContext,
								},
							}),
						),
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				})
				return json({ ok: true })
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(
						errorResponseFromCause(cause, "POST /api/ai/sessions/:sessionId/messages"),
					),
				),
			),
		)

		const runtimeProxyHandler = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const authorized = yield* authorizeRuntimeRequest(req, env, auth).pipe(
					Effect.as(true),
					Effect.catchCause(() => Effect.succeed(false)),
				)
				if (!authorized) return errorJson("Unauthorized", 401)
				return yield* proxyRuntimeRequest(req, env.ELECTRIC_AGENTS_URL)
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(errorResponseFromCause(cause, "/api/ai/runtime/*")),
				),
			)

		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
			yield* router.add(method, "/api/ai/runtime/*", runtimeProxyHandler)
		}
	}),
)
