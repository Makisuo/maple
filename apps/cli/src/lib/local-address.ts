export const DEFAULT_LOCAL_HOST = "127.0.0.1"
export const DEFAULT_LOCAL_PORT = 4318

/** Bun expects bare IPv6 listener addresses, while users commonly copy the
 * bracketed form used in URLs. Accept either form at the CLI boundary. */
export const normalizeHost = (host: string): string => {
	const trimmed = host.trim()
	return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
}

export const resolveBindHost = (environmentValue: string | undefined): string =>
	normalizeHost(environmentValue || DEFAULT_LOCAL_HOST) || DEFAULT_LOCAL_HOST

/** Wildcard bind addresses are not connection targets. Use their matching
 * loopback address for same-machine clients and readiness probes. */
export const connectionHostForBindHost = (host: string): string => {
	const normalized = normalizeHost(host)
	return normalized === "0.0.0.0" ? "127.0.0.1" : normalized === "::" ? "::1" : normalized
}

/** Browser URL hostnames that resolve to the browser machine itself. */
export const isLoopbackHostname = (hostname: string): boolean => {
	const normalized = hostname.toLowerCase()
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]"
	)
}

export const resolveAdvertiseHost = (
	flagValue: string | undefined,
	environmentValue: string | undefined,
	bindHost: string,
): string => {
	const flagHost = normalizeHost(flagValue ?? "")
	const environmentHost = normalizeHost(environmentValue ?? "")
	return flagHost || environmentHost || connectionHostForBindHost(bindHost)
}

const urlHost = (host: string): string =>
	host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host

export const serverUrl = (host: string, port: number): string => `http://${urlHost(host)}:${port}`

export const serverProbeUrl = (host: string, port: number): string =>
	serverUrl(connectionHostForBindHost(host), port)

export const defaultLocalUrl = (environmentHost: string | undefined): string =>
	serverProbeUrl(resolveBindHost(environmentHost), DEFAULT_LOCAL_PORT)

/** Canonical URL hostname, including brackets for IPv6 to match URL.hostname. */
export const canonicalUrlHostname = (host: string): string => new URL(serverUrl(host, 80)).hostname

const parseHostedUiUrl = (baseUrl: string): URL => {
	let url: URL
	try {
		url = new URL(baseUrl)
	} catch {
		throw new Error(`invalid hosted UI URL ${JSON.stringify(baseUrl)}: expected an absolute HTTP(S) URL`)
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`invalid hosted UI URL ${JSON.stringify(baseUrl)}: expected an absolute HTTP(S) URL`)
	}
	return url
}

export const hostedDashboardUrl = (baseUrl: string, port: number): string => {
	const url = parseHostedUiUrl(baseUrl)
	url.searchParams.set("port", String(port))
	url.searchParams.set("maple-local-api", "loopback")
	return url.toString()
}

export const hostedUiOrigin = (baseUrl: string): string => parseHostedUiUrl(baseUrl).origin
