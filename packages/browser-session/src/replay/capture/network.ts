import { activeTraceId } from "../events"
import { type Emit, safeEmit } from "./shared"

/**
 * Capture fetch + XHR requests as session events, tagged with the active trace
 * id so each request links to its backend trace. `ignoreUrl` skips Maple's own
 * ingest endpoints (otherwise capturing the session-events POST would loop).
 */
export function installNetworkCapture(emit: Emit, ignoreUrl: (url: string) => boolean): () => void {
	const origFetch = typeof window !== "undefined" ? window.fetch : undefined

	if (origFetch) {
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = requestUrl(input)
			const method = requestMethod(input, init)
			const traceId = activeTraceId()
			const start = performance.now()
			try {
				const res = await origFetch(input, init)
				record(url, method, res.status, start, traceId)
				return res
			} catch (error) {
				record(url, method, 0, start, traceId, String(error))
				throw error
			}
		}
	}

	const record = (
		url: string,
		method: string,
		status: number,
		start: number,
		traceId: string | undefined,
		error?: string,
	): void => {
		if (ignoreUrl(url)) return
		safeEmit(emit, {
			type: "network",
			net: { method, url, status, durationMs: Math.round(performance.now() - start) },
			traceId,
			...(error ? { attrs: { error } } : {}),
		})
	}

	// XMLHttpRequest — patch open (to capture method/url) + send (to time + observe).
	const XHR = typeof window !== "undefined" ? window.XMLHttpRequest : undefined
	const origOpen = XHR?.prototype.open
	const origSend = XHR?.prototype.send
	if (XHR && origOpen && origSend) {
		XHR.prototype.open = function (
			this: XMLHttpRequest,
			method: string,
			url: string | URL,
			...rest: unknown[]
		) {
			;(this as XhrMeta).__mapleMethod = String(method).toUpperCase()
			;(this as XhrMeta).__mapleUrl = typeof url === "string" ? url : url.href
			return origOpen.apply(this, [method, url, ...rest] as never)
		}
		XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
			const meta = this as XhrMeta
			const start = performance.now()
			const traceId = activeTraceId()
			this.addEventListener("loadend", () => {
				record(meta.__mapleUrl ?? "", meta.__mapleMethod ?? "GET", this.status, start, traceId)
			})
			return origSend.apply(this, args as never)
		}
	}

	return () => {
		if (origFetch) window.fetch = origFetch
		if (XHR && origOpen) XHR.prototype.open = origOpen
		if (XHR && origSend) XHR.prototype.send = origSend
	}
}

interface XhrMeta extends XMLHttpRequest {
	__mapleMethod?: string
	__mapleUrl?: string
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	const m = init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined)
	return (m ?? "GET").toUpperCase()
}
