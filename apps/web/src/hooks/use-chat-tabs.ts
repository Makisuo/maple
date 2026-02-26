import { useState, useCallback, useEffect } from "react"

const STORAGE_KEY = "maple-chat-tabs"
const DEFAULT_TAB_ID = "default"

export interface ChatTab {
  id: string
  title: string
  createdAt: number
}

interface ChatTabsState {
  tabs: ChatTab[]
  activeTabId: string
}

function loadState(): ChatTabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ChatTabsState
      if (parsed.tabs?.length > 0 && parsed.activeTabId) return parsed
    }
  } catch {
    // ignore
  }
  return {
    tabs: [{ id: DEFAULT_TAB_ID, title: "New Chat", createdAt: Date.now() }],
    activeTabId: DEFAULT_TAB_ID,
  }
}

function saveState(state: ChatTabsState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

export function useChatTabs(initialTabId?: string) {
  const [state, setState] = useState<ChatTabsState>(() => {
    const s = loadState()
    if (initialTabId && s.tabs.some((t) => t.id === initialTabId)) {
      return { ...s, activeTabId: initialTabId }
    }
    return s
  })

  useEffect(() => {
    saveState(state)
  }, [state])

  const createTab = useCallback(() => {
    const newTab: ChatTab = {
      id: crypto.randomUUID(),
      title: "New Chat",
      createdAt: Date.now(),
    }
    setState((prev) => ({
      tabs: [...prev.tabs, newTab],
      activeTabId: newTab.id,
    }))
    return newTab.id
  }, [])

  const closeTab = useCallback((id: string) => {
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
      return { tabs: newTabs, activeTabId: newActiveId }
    })
  }, [])

  const setActiveTab = useCallback((id: string) => {
    setState((prev) => (prev.activeTabId === id ? prev : { ...prev, activeTabId: id }))
  }, [])

  const renameTab = useCallback((id: string, title: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    }))
  }, [])

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    createTab,
    closeTab,
    setActiveTab,
    renameTab,
  }
}
