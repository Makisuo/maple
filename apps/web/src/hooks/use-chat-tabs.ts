import { useState, useCallback, useEffect, useRef } from "react"

const STORAGE_KEY_PREFIX = "maple-chat-tabs:"
const DEFAULT_TAB_ID = "default"

const storageKey = (orgId: string) => `${STORAGE_KEY_PREFIX}${orgId}`

export interface ChatTab {
	id: string
	title: string
	createdAt: number
	updatedAt: number
}

interface ChatTabsState {
	tabs: ChatTab[]
	activeTabId: string
}

function defaultState(): ChatTabsState {
	const now = Date.now()
	return {
		tabs: [{ id: DEFAULT_TAB_ID, title: "New Chat", createdAt: now, updatedAt: now }],
		activeTabId: DEFAULT_TAB_ID,
	}
}

function migrateTab(tab: ChatTab & { updatedAt?: number }): ChatTab {
	return {
		id: tab.id,
		title: tab.title,
		createdAt: tab.createdAt,
		updatedAt: tab.updatedAt ?? tab.createdAt,
	}
}

function loadState(orgId: string): ChatTabsState {
	try {
		const raw = localStorage.getItem(storageKey(orgId))
		if (raw) {
			const parsed = JSON.parse(raw) as ChatTabsState
			if (parsed.tabs?.length > 0 && parsed.activeTabId) {
				return { ...parsed, tabs: parsed.tabs.map(migrateTab) }
			}
		}
	} catch {
		// ignore
	}
	return defaultState()
}

function saveState(orgId: string, state: ChatTabsState) {
	try {
		localStorage.setItem(storageKey(orgId), JSON.stringify(state))
	} catch {
		// ignore
	}
}

export function useChatTabs(orgId: string, initialTabId?: string) {
	const [state, setState] = useState<ChatTabsState>(() => {
		const s = loadState(orgId)
		if (initialTabId && s.tabs.some((t) => t.id === initialTabId)) {
			return { ...s, activeTabId: initialTabId }
		}
		return s
	})

	const lastOrgIdRef = useRef(orgId)
	useEffect(() => {
		if (lastOrgIdRef.current === orgId) return
		lastOrgIdRef.current = orgId
		const next = loadState(orgId)
		setState(next)
	}, [orgId])

	const createTab = useCallback(() => {
		const now = Date.now()
		const newTab: ChatTab = {
			id: crypto.randomUUID(),
			title: "New Chat",
			createdAt: now,
			updatedAt: now,
		}
		setState((prev) => {
			const next = { tabs: [...prev.tabs, newTab], activeTabId: newTab.id }
			saveState(orgId, next)
			return next
		})
		return newTab.id
	}, [orgId])

	const closeTab = useCallback(
		(id: string) => {
			setState((prev) => {
				if (prev.tabs.length <= 1) return prev
				const idx = prev.tabs.findIndex((t) => t.id === id)
				if (idx === -1) return prev
				const newTabs = prev.tabs.filter((t) => t.id !== id)
				let newActiveId = prev.activeTabId
				if (prev.activeTabId === id) {
					const newIdx = Math.min(idx, newTabs.length - 1)
					newActiveId = newTabs[newIdx]!.id
				}
				const next = { tabs: newTabs, activeTabId: newActiveId }
				saveState(orgId, next)
				return next
			})
		},
		[orgId],
	)

	const setActiveTab = useCallback(
		(id: string) => {
			setState((prev) => {
				if (prev.activeTabId === id) return prev
				const next = {
					...prev,
					activeTabId: id,
					tabs: prev.tabs.map((t) => (t.id === id ? { ...t, updatedAt: Date.now() } : t)),
				}
				saveState(orgId, next)
				return next
			})
		},
		[orgId],
	)

	const renameTab = useCallback(
		(id: string, title: string) => {
			setState((prev) => {
				const now = Date.now()
				const next = {
					...prev,
					tabs: prev.tabs.map((t) => (t.id === id ? { ...t, title, updatedAt: now } : t)),
				}
				saveState(orgId, next)
				return next
			})
		},
		[orgId],
	)

	const ensureTab = useCallback(
		(id: string, title: string) => {
			setState((prev) => {
				const existing = prev.tabs.find((t) => t.id === id)
				const now = Date.now()
				if (existing) {
					if (prev.activeTabId === id) return prev
					const next = {
						...prev,
						activeTabId: id,
						tabs: prev.tabs.map((t) => (t.id === id ? { ...t, updatedAt: now } : t)),
					}
					saveState(orgId, next)
					return next
				}
				const newTab: ChatTab = { id, title, createdAt: now, updatedAt: now }
				const next = { tabs: [...prev.tabs, newTab], activeTabId: id }
				saveState(orgId, next)
				return next
			})
			return id
		},
		[orgId],
	)

	return {
		tabs: state.tabs,
		activeTabId: state.activeTabId,
		createTab,
		closeTab,
		setActiveTab,
		renameTab,
		ensureTab,
	}
}
