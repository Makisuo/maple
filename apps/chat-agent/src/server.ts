import http from "node:http"
import {
	createEntityRegistry,
	createRuntimeHandler,
	createRuntimeServerClient,
} from "@electric-ax/agents-runtime"
import { ASSISTANT_TYPE, registerAssistantAgent } from "./agents/assistant.js"
import {
	entityIdForTab,
	orgIdFromEntityId,
	verifyRequest,
	type AuthEnv,
} from "./auth.js"

const AGENTS_URL = process.env.AGENTS_URL ?? "http://localhost:4440"
const PORT = Number(process.env.PORT ?? 4700)
const SERVE_URL = process.env.SERVE_URL ?? `http://localhost:${PORT}`

const authEnv: AuthEnv = {
	MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE,
	MAPLE_ROOT_PASSWORD: process.env.MAPLE_ROOT_PASSWORD,
	CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
	CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
	CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
}

const registry = createEntityRegistry()
registerAssistantAgent(registry)

const runtime = createRuntimeHandler({
	baseUrl: AGENTS_URL,
	serveEndpoint: `${SERVE_URL}/webhook`,
	registry,
})

const runtimeClient = createRuntimeServerClient({ baseUrl: AGENTS_URL })

// Single-flight per entityId: the bundled durable-streams server still
// returns 500 when two PUTs for the same entity URL race, and React
// StrictMode double-mounts the chat panel in dev. Coalesce concurrent
// spawns so the agents-server only sees one PUT in flight per entity.
const inflightSpawns = new Map<string, Promise<{ entityUrl: string; chatroomId: string }>>()

async function ensureAssistantEntity(
	entityId: string,
	args: { orgId: string; tabId: string },
): Promise<{ entityUrl: string; chatroomId: string }> {
	const existing = inflightSpawns.get(entityId)
	if (existing) return existing
	const chatroomId = entityId // one chatroom per (orgId, tabId) tuple
	const promise = (async () => {
		const info = await runtimeClient.spawnEntity({
			type: ASSISTANT_TYPE,
			id: entityId,
			args: { orgId: args.orgId, tabId: args.tabId, chatroomId },
			tags: { org_id: args.orgId },
			// agents-runtime skips the handler on first wake if there's no
			// inbound input. A placeholder initialMessage forces the entity
			// to enter the handler once so `mkdb` runs and the wake-on-change
			// subscription registers.
			initialMessage: "ready",
		})
		return { entityUrl: info.entityUrl, chatroomId }
	})()
	inflightSpawns.set(entityId, promise)
	try {
		return await promise
	} finally {
		inflightSpawns.delete(entityId)
	}
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, x-maple-auth",
	"Access-Control-Max-Age": "86400",
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	})
	res.end(JSON.stringify(body))
}

async function readJsonBody<T = unknown>(req: http.IncomingMessage): Promise<T> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	if (chunks.length === 0) return {} as T
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
}

function toFetchRequest(req: http.IncomingMessage): Request {
	const host = req.headers.host ?? `localhost:${PORT}`
	const url = `http://${host}${req.url ?? "/"}`
	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v)
		} else {
			headers.set(key, value)
		}
	}
	return new Request(url, {
		method: req.method,
		headers,
	})
}

interface SendMessageBody {
	text?: string
}

async function authenticate(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<{ orgId: string; userId: string } | null> {
	const fetchReq = toFetchRequest(req)
	const verified = await verifyRequest(fetchReq, authEnv)
	if (!verified) {
		writeJson(res, 401, { error: "Authentication required" })
		return null
	}
	return verified
}

async function handleInit(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	tabId: string,
): Promise<void> {
	const verified = await authenticate(req, res)
	if (!verified) return
	const entityId = entityIdForTab(verified.orgId, tabId)
	try {
		const info = await ensureAssistantEntity(entityId, {
			orgId: verified.orgId,
			tabId,
		})
		writeJson(res, 200, {
			entityUrl: info.entityUrl,
			chatroomId: info.chatroomId,
			agentsUrl: AGENTS_URL,
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error("[chat-agent] init failed:", message)
		writeJson(res, 500, { error: message })
	}
}

// Post a user message directly into the chatroom's shared-state stream. The
// agent wakes via the `wake: { on: 'change', collections: ['shared:message'] }`
// subscription it registered in `assistant.ts`.
async function postUserMessageToSharedState(
	chatroomId: string,
	userName: string,
	text: string,
): Promise<void> {
	await runtimeClient.ensureSharedStateStream(chatroomId)
	const streamPath = runtimeClient.getSharedStateStreamPath(chatroomId)
	const msgKey = crypto.randomUUID()
	const event = {
		type: "shared:message",
		key: msgKey,
		headers: { operation: "insert" },
		value: {
			key: msgKey,
			role: "user",
			sender: "user",
			senderName: userName,
			text,
			timestamp: Date.now(),
		},
	}
	const res = await fetch(`${AGENTS_URL}${streamPath}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`shared-state POST failed (${res.status}): ${body}`)
	}
}

async function handleSendMessage(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	tabId: string,
): Promise<void> {
	const verified = await authenticate(req, res)
	if (!verified) return

	let body: SendMessageBody
	try {
		body = await readJsonBody<SendMessageBody>(req)
	} catch {
		writeJson(res, 400, { error: "Invalid JSON body" })
		return
	}

	const text = body.text?.trim()
	if (!text) {
		writeJson(res, 400, { error: "text is required" })
		return
	}

	const entityId = entityIdForTab(verified.orgId, tabId)

	try {
		const info = await ensureAssistantEntity(entityId, {
			orgId: verified.orgId,
			tabId,
		})
		await postUserMessageToSharedState(info.chatroomId, "You", text)
		writeJson(res, 202, {
			entityUrl: info.entityUrl,
			chatroomId: info.chatroomId,
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error("[chat-agent] send failed:", message)
		writeJson(res, 500, { error: message })
	}
}

const SEND_MESSAGE_PATH = /^\/api\/chat\/([^/]+)\/message$/
const INIT_PATH = /^\/api\/chat\/([^/]+)\/init$/

// The agents-server's `publicUrl` must be a loopback URL to pass its own
// webhook allowlist (see `isLocalDevHost` in @durable-streams/server). The
// wake notifications we receive therefore embed a `callback` URL like
// `http://localhost:4437/_electric/callback-forward/...` that the
// agents-server can reach internally but our host-side runtime cannot.
// Rewrite the body so the runtime fetches the host-mapped port.
//
// TODO(upstream): drop this once `ELECTRIC_AGENTS_BASE_URL` can be set to
// a non-loopback URL — tracked as upstream bug #5 in
// `docs/electric-agents-upstream-issues.md`.
const INTERNAL_BASE_URL =
	process.env.AGENTS_INTERNAL_BASE_URL ?? "http://localhost:4437"

async function handleWebhookWithCallbackRewrite(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const raw = Buffer.concat(chunks).toString("utf8")
	const rewritten = raw.split(INTERNAL_BASE_URL).join(AGENTS_URL)

	const host = req.headers.host ?? `localhost:${PORT}`
	const url = `http://${host}${req.url ?? "/webhook"}`
	const headers = new Headers()
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const v of value) headers.append(name, v)
		} else {
			headers.set(name, value)
		}
	}
	headers.delete("content-length")
	const bodyBytes = new Uint8Array(Buffer.from(rewritten, "utf8"))
	const fetchReq = new Request(url, {
		method: req.method ?? "POST",
		headers,
		body: bodyBytes.byteLength > 0 ? bodyBytes : undefined,
	})

	const response = await runtime.handleWebhookRequest(fetchReq)

	// undici's Response() throws on status 204 — the agents-server proxy
	// relays our reply through one. Rewrite to 200.
	// TODO(upstream): drop once agents-runtime ships the fix.
	const status = response.status === 204 ? 200 : response.status
	const respHeaders: Record<string, string> = {}
	response.headers.forEach((value, key) => {
		respHeaders[key] = value
	})
	res.writeHead(status, respHeaders)
	const ctype = response.headers.get("content-type") ?? ""
	if (ctype.startsWith("application/json") || ctype.startsWith("text/")) {
		res.end(await response.text())
	} else {
		const buf = await response.arrayBuffer()
		res.end(Buffer.from(buf))
	}
}

const server = http.createServer(async (req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS)
		res.end()
		return
	}

	const url = req.url ?? "/"

	if (req.method === "POST" && url === "/webhook") {
		await handleWebhookWithCallbackRewrite(req, res)
		return
	}

	if (req.method === "GET" && url === "/api/health") {
		writeJson(res, 200, {
			status: "ok",
			types: runtime.typeNames,
			agentsUrl: AGENTS_URL,
		})
		return
	}

	if (req.method === "GET" && url === "/api/config") {
		writeJson(res, 200, { agentsUrl: AGENTS_URL })
		return
	}

	const initMatch = url.match(INIT_PATH)
	if (initMatch && req.method === "POST") {
		const tabId = decodeURIComponent(initMatch[1]!)
		await handleInit(req, res, tabId)
		return
	}

	const sendMatch = url.match(SEND_MESSAGE_PATH)
	if (sendMatch && req.method === "POST") {
		const tabId = decodeURIComponent(sendMatch[1]!)
		await handleSendMessage(req, res, tabId)
		return
	}

	writeJson(res, 404, { error: "Not Found" })
})

// Preflight: catch the common dev-onboarding miss where the user forgot to
// start the agents-server stack. We don't fail-fast — registerTypes will
// retry on demand — but we surface a clear hint.
async function preflightAgentsServer(): Promise<void> {
	try {
		const res = await fetch(`${AGENTS_URL}/health`, {
			signal: AbortSignal.timeout(2000),
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		console.log(`[chat-agent] agents-server reachable at ${AGENTS_URL}`)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.warn(
			`[chat-agent] agents-server not reachable at ${AGENTS_URL} (${message}).\n` +
				`            Run \`bun electric:up\` from the repo root, then retry.`,
		)
	}
}

server.listen(PORT, async () => {
	await preflightAgentsServer()
	try {
		await runtime.registerTypes()
		console.log(
			`[chat-agent] listening on :${PORT} (agents-server: ${AGENTS_URL}, types: ${runtime.typeNames.join(", ")})`,
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error(
			`[chat-agent] registerTypes failed — is the agents-server running at ${AGENTS_URL}? (${message})`,
		)
	}
})

// Re-export so consumers of the entity id convention can derive an orgId.
export { entityIdForTab, orgIdFromEntityId }
