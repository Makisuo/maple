import {
	createEntityStreamDB,
	createRuntimeServerClient,
	type EntityStreamDB,
	type EntityTimelineSection,
	type RuntimeEntityInfo,
} from "@electric-ax/agents-runtime"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"

const OBSERVE_TOKEN_PARAM = "maple_observe_token"

export interface MapleChatSession {
	readonly id: string
	readonly entityUrl: string
	readonly observeToken: string
	readonly observeTokenExpiresAt: number
}

export interface MapleChatMessagePayload {
	readonly text: string
	readonly mode?: string
	readonly pageContext?: unknown
	readonly alertContext?: unknown
	readonly widgetFixContext?: unknown
	readonly dashboardContext?: unknown
}

export interface MapleChatObservation {
	readonly db: EntityStreamDB
	readonly close: () => void
}

const mapleAiFetch: typeof globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers)
	const authHeaders = await getMapleAuthHeaders()
	for (const [name, value] of Object.entries(authHeaders)) {
		if (!headers.has(name)) headers.set(name, value)
	}
	return globalThis.fetch(input, { ...init, headers })
}

const readJson = async <T>(response: Response): Promise<T> => {
	if (response.ok) return (await response.json()) as T
	let message = `Request failed with ${response.status}`
	try {
		const body = (await response.json()) as { error?: string }
		if (body.error) message = body.error
	} catch {
		// Keep the status-based fallback.
	}
	throw new Error(message)
}

export const ensureMapleChatSession = async (input: {
	readonly tabId: string
	readonly title?: string
}): Promise<MapleChatSession> => {
	const response = await mapleAiFetch(`${apiBaseUrl}/api/ai/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	})
	return readJson<MapleChatSession>(response)
}

export const sendMapleChatMessage = async (
	sessionId: string,
	payload: MapleChatMessagePayload,
): Promise<void> => {
	const response = await mapleAiFetch(`${apiBaseUrl}/api/ai/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	})
	await readJson<{ ok: true }>(response)
}

export const sendMapleApprovalResponse = async (
	sessionId: string,
	approvalId: string,
	approved: boolean,
): Promise<void> => {
	const response = await mapleAiFetch(`${apiBaseUrl}/api/ai/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ approvalResponse: { approvalId, approved } }),
	})
	await readJson<{ ok: true }>(response)
}

const refreshObserveToken = async (
	sessionId: string,
): Promise<Pick<MapleChatSession, "observeToken" | "observeTokenExpiresAt">> => {
	const response = await mapleAiFetch(
		`${apiBaseUrl}/api/ai/sessions/${sessionId}/observe-token`,
		{ method: "POST", headers: { "Content-Type": "application/json" } },
	)
	return readJson<Pick<MapleChatSession, "observeToken" | "observeTokenExpiresAt">>(response)
}

const buildStreamUrl = (streamPath: string, observeToken: string): string => {
	const base = apiBaseUrl.replace(/\/$/, "")
	const path = streamPath.startsWith("/") ? streamPath : `/${streamPath}`
	const url = new URL(`${base}/api/ai/runtime${path}`)
	url.searchParams.set(OBSERVE_TOKEN_PARAM, observeToken)
	return url.toString()
}

export const observeMapleChatSession = async (
	session: MapleChatSession,
): Promise<MapleChatObservation> => {
	const client = createRuntimeServerClient({
		baseUrl: `${apiBaseUrl.replace(/\/$/, "")}/api/ai/runtime`,
		fetch: mapleAiFetch,
	})
	const info: RuntimeEntityInfo = await client.getEntityInfo(session.entityUrl)

	let currentToken = session.observeToken
	let currentExpiresAt = session.observeTokenExpiresAt
	const db = createEntityStreamDB(buildStreamUrl(info.streamPath, currentToken))
	await db.preload()
	if (!("collections" in db)) {
		throw new Error("Expected Electric entity stream")
	}

	// Schedule a refresh ~5 minutes before expiry so the durable stream stays
	// authenticated across long chat sessions. Re-creating the stream would drop
	// state, so we only refresh the token — the existing EventSource holds the
	// query param it was opened with, but reconnects will pick up the new token
	// via this closure once we wire it through preload-on-reconnect.
	const scheduleRefresh = (): ReturnType<typeof setTimeout> => {
		const lead = 5 * 60 * 1000
		const delay = Math.max(currentExpiresAt - Date.now() - lead, 30_000)
		return setTimeout(async () => {
			try {
				const refreshed = await refreshObserveToken(session.id)
				currentToken = refreshed.observeToken
				currentExpiresAt = refreshed.observeTokenExpiresAt
			} catch (error) {
				console.warn("[maple-chat] observe-token refresh failed:", error)
			} finally {
				timer = scheduleRefresh()
			}
		}, delay)
	}

	let timer: ReturnType<typeof setTimeout> = scheduleRefresh()

	return {
		db: db as EntityStreamDB,
		close: () => clearTimeout(timer),
	}
}

export type { EntityStreamDB, EntityTimelineSection }
