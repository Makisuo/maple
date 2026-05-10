import {
	createAgentsClient,
	entity,
	type EntityStreamDB,
	type EntityTimelineSection,
} from "@electric-ax/agents-runtime"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"

export interface MapleChatSession {
	readonly id: string
	readonly entityUrl: string
}

export interface MapleChatMessagePayload {
	readonly text: string
	readonly mode?: string
	readonly pageContext?: unknown
	readonly alertContext?: unknown
	readonly widgetFixContext?: unknown
	readonly dashboardContext?: unknown
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

export const observeMapleChatSession = async (entityUrl: string): Promise<EntityStreamDB> => {
	const client = createAgentsClient({
		baseUrl: `${apiBaseUrl}/api/ai/runtime`,
		fetch: mapleAiFetch,
	})
	const db = await client.observe(entity(entityUrl))
	if (!("collections" in db)) {
		throw new Error("Expected Electric entity stream")
	}
	return db as EntityStreamDB
}

export type { EntityStreamDB, EntityTimelineSection }
