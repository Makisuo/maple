export const MAPLE_CHAT_ENTITY_TYPE = "maple_chat"

export const encodeMapleChatEntityId = (orgId: string, tabId: string): string => {
	const raw = `${orgId}:${tabId}`
	const bytes = new TextEncoder().encode(raw)
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export const decodeMapleChatEntityId = (id: string): { orgId: string; tabId: string } | null => {
	try {
		const padded = id
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(id.length / 4) * 4, "=")
		const binary = atob(padded)
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
		const decoded = new TextDecoder().decode(bytes)
		const separator = decoded.indexOf(":")
		if (separator <= 0) return null
		return {
			orgId: decoded.slice(0, separator),
			tabId: decoded.slice(separator + 1),
		}
	} catch {
		return null
	}
}

export const mapleChatEntityUrl = (orgId: string, tabId: string): string =>
	`/${MAPLE_CHAT_ENTITY_TYPE}/${encodeMapleChatEntityId(orgId, tabId)}`
