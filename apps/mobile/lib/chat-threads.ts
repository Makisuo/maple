// AsyncStorage-backed index of chat threads for the mobile Ask tab.
// Stores summaries + per-thread message history so users can revisit
// conversations offline.

import AsyncStorage from "@react-native-async-storage/async-storage"
import type { UIMessage } from "ai"
import type { AlertContext } from "./alert-context"

const THREADS_KEY = "maple.chat.threads.v1"
const messagesKey = (threadId: string) => `maple.chat.messages.v1.${threadId}`

export interface ThreadSummary {
	threadId: string
	title: string
	lastMessagePreview: string
	lastMessageAt: number
	alertContext?: AlertContext
}

type Listener = (threads: ThreadSummary[]) => void

let cache: ThreadSummary[] | null = null
const listeners = new Set<Listener>()

async function loadIndex(): Promise<ThreadSummary[]> {
	if (cache) return cache
	try {
		const raw = await AsyncStorage.getItem(THREADS_KEY)
		cache = raw ? (JSON.parse(raw) as ThreadSummary[]) : []
	} catch {
		cache = []
	}
	return cache
}

async function persistIndex(next: ThreadSummary[]): Promise<void> {
	cache = next
	await AsyncStorage.setItem(THREADS_KEY, JSON.stringify(next))
	for (const l of listeners) l(next)
}

export async function listThreads(): Promise<ThreadSummary[]> {
	const threads = await loadIndex()
	return [...threads].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
}

export function subscribeThreads(listener: Listener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export async function upsertThread(summary: ThreadSummary): Promise<void> {
	const threads = await loadIndex()
	const idx = threads.findIndex((t) => t.threadId === summary.threadId)
	const next = [...threads]
	if (idx >= 0) next[idx] = summary
	else next.push(summary)
	await persistIndex(next)
}

export async function getThread(threadId: string): Promise<ThreadSummary | undefined> {
	const threads = await loadIndex()
	return threads.find((t) => t.threadId === threadId)
}

export async function deleteThread(threadId: string): Promise<void> {
	const threads = await loadIndex()
	const next = threads.filter((t) => t.threadId !== threadId)
	await persistIndex(next)
	await AsyncStorage.removeItem(messagesKey(threadId))
}

export async function loadMessages(threadId: string): Promise<UIMessage[]> {
	try {
		const raw = await AsyncStorage.getItem(messagesKey(threadId))
		if (!raw) return []
		return JSON.parse(raw) as UIMessage[]
	} catch {
		return []
	}
}

export async function saveMessages(threadId: string, messages: UIMessage[]): Promise<void> {
	await AsyncStorage.setItem(messagesKey(threadId), JSON.stringify(messages))
}

export function previewFromMessage(message: UIMessage | undefined): string {
	if (!message) return ""
	for (const part of message.parts) {
		if (part.type === "text" && "text" in part && typeof part.text === "string") {
			return part.text.trim().slice(0, 80)
		}
	}
	return ""
}

export function titleFromFirstUserText(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, " ")
	return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed || "New conversation"
}
