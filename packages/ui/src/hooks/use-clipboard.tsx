import * as React from "react"

export interface ClipboardAPI {
	copy: (text: string) => Promise<void>
}

const ClipboardContext = React.createContext<ClipboardAPI | null>(null)

/**
 * Hook to access the platform clipboard.
 * Falls back to navigator.clipboard.writeText on web.
 * On React Native, provide a ClipboardProvider wrapping expo-clipboard.
 */
export function useClipboard(): ClipboardAPI {
	const ctx = React.use(ClipboardContext)
	if (ctx) return ctx

	// Default web implementation
	return defaultWebClipboard
}

const defaultWebClipboard: ClipboardAPI = {
	copy: (text: string) => navigator.clipboard.writeText(text),
}

export function ClipboardProvider({
	children,
	clipboard,
}: {
	children: React.ReactNode
	clipboard: ClipboardAPI
}) {
	return <ClipboardContext value={clipboard}>{children}</ClipboardContext>
}
