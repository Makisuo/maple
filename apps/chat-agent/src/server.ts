import http from "node:http"
import {
	createEntityRegistry,
	createRuntimeHandler,
} from "@electric-ax/agents-runtime"
import { ASSISTANT_TYPE, registerAssistantAgent } from "./agents/assistant.js"
import {
	entityIdForTab,
	orgIdFromEntityId,
	verifyRequest,
	type AuthEnv,
} from "./auth.js"

const AGENTS_URL = process.env.AGENTS_URL ?? "http://localhost:4437"
const PORT = Number(process.env.PORT ?? 4700)
const SERVE_URL = process.env.SERVE_URL ?? `http://localhost:${PORT}`
// Webhook URL the agents-server should call when an entity wakes. Must be a
// loopback URL (localhost/127.0.0.x) to pass the agents-server's webhook
// allowlist — even when the server runs inside Docker. The container
// rewrites it back to a host-reachable address via
// ELECTRIC_AGENTS_REWRITE_LOOPBACK_WEBHOOKS_TO.
const WEBHOOK_URL =
	process.env.WEBHOOK_URL ?? `http://localhost:${PORT}/webhook`

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

// NOTE: We talk to the agents-server REST API directly rather than going
// through the runtime's bundled `createRuntimeServerClient`. The published
// @electric-ax/agents-runtime@0.1.3 ships a bundle where that client's
// spawn/send/get paths drop the required `/_electric/entities` prefix; the
// fix is on HEAD but unreleased. Swap to the helper once a newer version
// ships.

interface SpawnedEntityInfo {
	url: string
	type: string
	status: string
	streams: { main: string; error: string }
}

// Single-flight per entityId: the bundled durable-streams server returns
// 500 (and rolls back the postgres insert) when two PUTs for the same
// entity URL race — and React StrictMode double-mounts the chat panel in
// dev, firing two simultaneous /init calls for every new tab. Coalesce
// concurrent spawns at this process so the agents-server only sees one
// PUT in flight per entity at a time.
const inflightSpawns = new Map<string, Promise<SpawnedEntityInfo>>()

async function spawnAssistantEntity(
	entityId: string,
	args: { orgId: string; tabId: string },
): Promise<SpawnedEntityInfo> {
	const existing = inflightSpawns.get(entityId)
	if (existing) return existing
	const promise = doSpawnAssistantEntity(entityId, args)
	inflightSpawns.set(entityId, promise)
	try {
		return await promise
	} finally {
		inflightSpawns.delete(entityId)
	}
}

async function doSpawnAssistantEntity(
	entityId: string,
	args: { orgId: string; tabId: string },
): Promise<SpawnedEntityInfo> {
	const url = `${AGENTS_URL}/_electric/entities/${ASSISTANT_TYPE}/${encodeURIComponent(entityId)}`
	const res = await fetch(url, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ args, tags: { org_id: args.orgId } }),
	})
	if (res.ok) {
		return (await res.json()) as SpawnedEntityInfo
	}
	// Two failure modes both recover via GET:
	//  - 409 DUPLICATE_URL: entity already exists from an earlier spawn
	//  - 500 INTERNAL_SERVER_ERROR: false negative from the bundled durable-
	//    streams server's `streamMetaToStream` race (it commits the entity
	//    row + stream to disk, then throws on the immediate-read map step).
	//    The stream is actually usable; GET returns the full info.
	if (res.status === 409 || res.status === 500) {
		const getRes = await fetch(url, { method: "GET" })
		if (getRes.ok) {
			return (await getRes.json()) as SpawnedEntityInfo
		}
		const getBody = await getRes.text().catch(() => "")
		throw new Error(
			`spawn ${entityId} failed (${res.status}); recovery GET also failed (${getRes.status}): ${getBody}`,
		)
	}
	const body = await res.text().catch(() => "")
	throw new Error(`spawn ${entityId} failed (${res.status}): ${body}`)
}

async function sendUserMessage(
	entityUrl: string,
	payload: { text: string },
	from: string,
): Promise<void> {
	const url = `${AGENTS_URL}/_electric/entities${entityUrl}/send`
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ payload, from, type: "user_message" }),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`send to ${entityUrl} failed (${res.status}): ${body}`)
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
		const info = await spawnAssistantEntity(entityId, {
			orgId: verified.orgId,
			tabId,
		})
		writeJson(res, 200, {
			entityUrl: info.url,
			streamUrl: `${AGENTS_URL}${info.streams.main}`,
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error("[chat-agent] init failed:", message)
		writeJson(res, 500, { error: message })
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
		const info = await spawnAssistantEntity(entityId, {
			orgId: verified.orgId,
			tabId,
		})
		await sendUserMessage(info.url, { text }, `user:${verified.userId}`)
		writeJson(res, 202, { entityUrl: info.url })
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error("[chat-agent] send failed:", message)
		writeJson(res, 500, { error: message })
	}
}

const SEND_MESSAGE_PATH = /^\/api\/chat\/([^/]+)\/message$/
const INIT_PATH = /^\/api\/chat\/([^/]+)\/init$/

// The agents-server's `publicUrl` must be loopback for in-container webhook
// validation, so the wake notification it sends us embeds a `callback` URL
// like `http://localhost:4437/...` that's unreachable from the host. Rewrite
// the body so the runtime's `fetch(callback, ...)` hits the host-mapped port.
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

	// Build a proper fetch Request ourselves and call handleWebhookRequest
	// directly. The bundled runtime's `onEnter` → `toFetchRequest` does
	// `new Request(url, { body: Buffer.from(...) })`, which Node 24's undici
	// rejects with "Cannot read properties of undefined (reading
	// 'Symbol(kState)')" because Buffer isn't an accepted BodyInit there.
	// Passing a Uint8Array works around the upstream bug.
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

	// Force 204 → 200 because the agents-server's subscription proxy
	// upstream re-wraps our reply via `new Response(body, { status })`
	// which throws on 204.
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

async function registerWebhookSubscription(): Promise<void> {
	// Workaround for @electric-ax/agents-runtime@0.1.3: the bundled
	// registerTypes() PUTs to `${baseUrl}/${type}/**?subscription=...` with
	// `{ webhook: "url" }` — but the agents-server's subscription proxy
	// only handles PUT /v1/stream-meta/subscriptions/{id} with body
	// `{ type: "webhook", webhook: { url }, pattern }`. The bundled call
	// hits `proxyPassThrough` instead and silently no-ops, leaving no row
	// in `subscription_webhooks` and no wake delivery. Re-issue the PUT
	// with the correct shape so the agents-server registers our webhook.
	const subId = `${ASSISTANT_TYPE}-handler`
	const subUrl = `${AGENTS_URL}/v1/stream-meta/subscriptions/${encodeURIComponent(subId)}`
	const res = await fetch(subUrl, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			type: "webhook",
			webhook: { url: WEBHOOK_URL },
			pattern: `${ASSISTANT_TYPE}/**`,
		}),
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(
			`subscription PUT failed (${res.status}): ${body || res.statusText}`,
		)
	}
}

server.listen(PORT, async () => {
	try {
		await runtime.registerTypes()
		// In agents-server >=0.4.0 each spawned entity gets its own auto-
		// subscription (visible in the spawn response's `dispatch_policy`).
		// Skipping the explicit type-wide subscription avoids double wake
		// delivery on every message (which races for the wake claim token
		// and 401s mid-stream).
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
