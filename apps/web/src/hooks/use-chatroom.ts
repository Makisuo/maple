/**
 * Subscribe to the assistant entity's stream via `@electric-ax/agents-runtime`.
 * Returns the EntityStreamDB so callers can pass it to `useChat(db)` for a
 * fully-materialized streaming timeline (user messages + agent responses
 * + tool calls, accumulating in real time as text_deltas land).
 */
import { useEffect, useState } from "react"
import { createAgentsClient, entity } from "@electric-ax/agents-runtime"
import type { EntityStreamDB } from "@electric-ax/agents-runtime"
import { agentsUrl } from "@/lib/electric-agents-client"

async function retry<T>(
	fn: () => Promise<T>,
	attempts = 10,
	delay = 500,
): Promise<T> {
	let lastErr: unknown
	for (let i = 0; i < attempts; i += 1) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (i === attempts - 1) break
			await new Promise((r) => setTimeout(r, delay))
		}
	}
	throw lastErr ?? new Error("retry exhausted")
}

export function useChatroom(entityUrl: string | null): {
	db: EntityStreamDB | null
	error: string | null
} {
	const [db, setDb] = useState<EntityStreamDB | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!entityUrl) {
			setDb(null)
			setError(null)
			return
		}
		let cancelled = false
		let close: () => void = () => {}
		;(async () => {
			try {
				const client = createAgentsClient({ baseUrl: agentsUrl })
				const handle = await retry(() => client.observe(entity(entityUrl)))
				if (cancelled) {
					;(handle as unknown as { close?: () => void }).close?.()
					return
				}
				close = () => {
					;(handle as unknown as { close?: () => void }).close?.()
				}
				setDb(handle as unknown as EntityStreamDB)
				setError(null)
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : String(err))
			}
		})()
		return () => {
			cancelled = true
			close()
		}
	}, [entityUrl])

	return { db, error }
}
