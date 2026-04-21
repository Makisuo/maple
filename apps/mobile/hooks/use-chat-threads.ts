import { useEffect, useState } from "react"
import { listThreads, subscribeThreads, type ThreadSummary } from "../lib/chat-threads"

export function useChatThreads() {
	const [threads, setThreads] = useState<ThreadSummary[]>([])
	const [loaded, setLoaded] = useState(false)

	useEffect(() => {
		let cancelled = false
		void listThreads().then((list) => {
			if (cancelled) return
			setThreads(list)
			setLoaded(true)
		})
		const unsub = subscribeThreads((next) => {
			const sorted = [...next].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
			setThreads(sorted)
		})
		return () => {
			cancelled = true
			unsub()
		}
	}, [])

	return { threads, loaded }
}
