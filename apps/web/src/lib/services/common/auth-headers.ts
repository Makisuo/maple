export type MapleAuthHeaders = Readonly<Record<string, string>>

type MapleAuthHeadersProvider = () => Promise<MapleAuthHeaders> | MapleAuthHeaders

let authHeaders: MapleAuthHeaders = {}
let authHeadersProvider: MapleAuthHeadersProvider | undefined

export const getMapleAuthHeaders = async (): Promise<MapleAuthHeaders> => {
	const providedHeaders = authHeadersProvider ? await authHeadersProvider() : {}
	return {
		...providedHeaders,
		...authHeaders,
	}
}

export const setMapleAuthHeaders = (headers: Record<string, string>) => {
	authHeaders = { ...headers }
}

export const clearMapleAuthHeaders = () => {
	authHeaders = {}
}

export const setMapleAuthHeadersProvider = (provider?: MapleAuthHeadersProvider) => {
	authHeadersProvider = provider
}
