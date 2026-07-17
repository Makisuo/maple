export const DEFAULT_LOCAL_HOST = "127.0.0.1"
export const DEFAULT_LOCAL_PORT = 4318

export const resolveBindHost = (environmentValue: string | undefined): string =>
	environmentValue?.trim() || DEFAULT_LOCAL_HOST

/** Wildcard bind addresses are not connection targets. Use their matching
 * loopback address for same-machine clients and readiness probes. */
export const connectionHostForBindHost = (host: string): string =>
	host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host

export const resolveAdvertiseHost = (
	flagValue: string | undefined,
	environmentValue: string | undefined,
	bindHost: string,
): string => flagValue?.trim() || environmentValue?.trim() || connectionHostForBindHost(bindHost)

const urlHost = (host: string): string =>
	host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host

export const serverUrl = (host: string, port: number): string => `http://${urlHost(host)}:${port}`

export const serverProbeUrl = (host: string, port: number): string =>
	serverUrl(connectionHostForBindHost(host), port)

export const defaultLocalUrl = (environmentHost: string | undefined): string =>
	serverProbeUrl(resolveBindHost(environmentHost), DEFAULT_LOCAL_PORT)

/** Canonical URL hostname, including brackets for IPv6 to match URL.hostname. */
export const canonicalUrlHostname = (host: string): string => new URL(serverUrl(host, 80)).hostname

export const hostedDashboardUrl = (baseUrl: string, port: number): string => {
	const url = new URL(baseUrl)
	url.searchParams.set("port", String(port))
	url.searchParams.set("maple-local-api", "loopback")
	return url.toString()
}

export const hostedUiOrigin = (baseUrl: string): string => new URL(baseUrl).origin
