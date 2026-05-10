import { createRuntimeServerClient } from "@electric-ax/agents-runtime"
import {
	decodeMapleChatEntityId,
	encodeMapleChatEntityId,
	MAPLE_CHAT_ENTITY_TYPE,
	mapleChatEntityUrl,
} from "@maple/ai"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { AuthService } from "../services/AuthService"
import { Env } from "../services/Env"

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
		await client.getEntityInfo(entityUrl)
	} catch {
		await client.spawnEntity({
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
		})
	}

	return { id, entityUrl }
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
			const target = new URL(targetPath + incoming.search, runtimeUrl)
			const headers = new Headers(req.headers as Record<string, string>)
			headers.delete("host")
			const response = await fetch(target, {
				method: req.method,
				headers,
			})
			return HttpServerResponse.fromWeb(response)
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(Effect.catch((error) => Effect.succeed(errorJson(error.message, 502))))

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
					catch: (error) => error,
				})
				return json(session)
			}),
		)

		yield* router.add("POST", "/api/ai/sessions/:sessionId/messages", (req) =>
			Effect.gen(function* () {
				const tenant = yield* auth.resolveTenant(req.headers as Record<string, string>)
				const params = yield* HttpRouter.params
				const sessionId = params.sessionId
				if (!sessionId) return errorJson("sessionId is required", 400)
				const decoded = decodeMapleChatEntityId(sessionId)
				if (!decoded || decoded.orgId !== tenant.orgId) return errorJson("Unknown chat session", 404)

				const body = yield* readJson<SendMessageBody>(req)
				const client = makeRuntimeClient(env.ELECTRIC_AGENTS_URL)
				if (body.approvalResponse) {
					const approvalId = body.approvalResponse.approvalId
					const approved = body.approvalResponse.approved
					if (!approvalId || typeof approved !== "boolean") {
						return errorJson("approvalResponse.approvalId and approved are required", 400)
					}
					yield* Effect.tryPromise({
						try: () =>
							client.sendEntityMessage({
								targetUrl: `/${MAPLE_CHAT_ENTITY_TYPE}/${sessionId}`,
								type: "approval_response",
								payload: { approvalId, approved },
							}),
						catch: (error) => error,
					})
					return json({ ok: true })
				}

				const text = body.text?.trim()
				if (!text) return errorJson("text is required", 400)
				yield* Effect.tryPromise({
					try: () =>
						client.sendEntityMessage({
							targetUrl: `/${MAPLE_CHAT_ENTITY_TYPE}/${sessionId}`,
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
					catch: (error) => error,
				})
				return json({ ok: true })
			}),
		)

		yield* router.add("GET", "/api/ai/runtime/*", (req) =>
			Effect.gen(function* () {
				yield* auth.resolveTenant(req.headers as Record<string, string>)
				return yield* proxyRuntimeRequest(req, env.ELECTRIC_AGENTS_URL)
			}),
		)
	}),
)
