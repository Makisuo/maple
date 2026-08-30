/**
 * A Node-like duplex over the WebSocket API, for postgres.js `socket`.
 *
 * celld's workerd build of postgres.js honors `options.socket` and skips
 * `cloudflare:sockets` (an inert stub). The factory must return an already-open
 * duplex: postgres.js then writes the startup message immediately.
 *
 * This module is the Workers-side half of `scripts/pg-ws-proxy.ts`. It uses the
 * WebSocket API only — not `node:net`.
 */
import { Buffer } from "node:buffer"

type SocketListener = (...args: unknown[]) => void

const toBytes = (data: unknown): Uint8Array => {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
	}
	if (typeof data === "string") {
		// Celld may deliver binary frames as JS strings (one code unit per byte).
		const out = new Uint8Array(data.length)
		for (let i = 0; i < data.length; i += 1) out[i] = data.charCodeAt(i) & 0xff
		return out
	}
	return new Uint8Array()
}

const toSendable = (chunk: Uint8Array | string): ArrayBuffer | string => {
	if (typeof chunk === "string") return chunk
	const copy = new Uint8Array(chunk.byteLength)
	copy.set(chunk)
	return copy.buffer
}

export class MaplePgWsDuplex {
	readyState = "open"
	readonly #ws: WebSocket
	readonly #listeners = new Map<string, Set<SocketListener>>()

	constructor(ws: WebSocket) {
		this.#ws = ws
		const onMessage = (event: MessageEvent | { readonly data: unknown }) => {
			const payload = event.data
			if (typeof Blob !== "undefined" && payload instanceof Blob) {
				void payload.arrayBuffer().then((buffer) => {
					const buf = Buffer.from(buffer)
					this.#emit("data", buf)
				})
				return
			}
			const buf = Buffer.from(toBytes(payload))
			this.#emit("data", buf)
		}
		const onError = () => this.#emit("error", new Error("postgres websocket error"))
		const onClose = () => {
			this.readyState = "closed"
			this.#emit("close")
		}
		ws.addEventListener("message", onMessage)
		ws.addEventListener("error", onError)
		ws.addEventListener("close", onClose)
		ws.onmessage = onMessage
		ws.onerror = onError
		ws.onclose = onClose
	}

	on(event: string, listener: SocketListener): this {
		let bucket = this.#listeners.get(event)
		if (bucket === undefined) {
			bucket = new Set()
			this.#listeners.set(event, bucket)
		}
		bucket.add(listener)
		return this
	}

	once(event: string, listener: SocketListener): this {
		const wrapped: SocketListener = (...args) => {
			this.removeListener(event, wrapped)
			listener(...args)
		}
		return this.on(event, wrapped)
	}

	removeListener(event: string, listener: SocketListener): this {
		this.#listeners.get(event)?.delete(listener)
		return this
	}

	removeAllListeners(event?: string): this {
		if (event === undefined) this.#listeners.clear()
		else this.#listeners.delete(event)
		return this
	}

	write(
		chunk: Uint8Array | string,
		encodingOrCb?: string | ((error?: Error) => void),
		cb?: (error?: Error) => void,
	): boolean {
		const onDone = typeof encodingOrCb === "function" ? encodingOrCb : cb
		try {
			if (this.readyState !== "open" || this.#ws.readyState !== WebSocket.OPEN) {
				const error = new Error("postgres websocket is not open")
				onDone?.(error)
				this.#emit("error", error)
				return false
			}
			this.#ws.send(toSendable(typeof chunk === "string" ? chunk : new Uint8Array(chunk)))
			onDone?.()
			queueMicrotask(() => this.#emit("drain"))
			return true
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error("postgres websocket write failed")
			onDone?.(error)
			this.#emit("error", error)
			return false
		}
	}

	end(chunk?: Uint8Array | string): this {
		if (chunk !== undefined) this.write(chunk)
		this.destroy()
		return this
	}

	destroy(): void {
		if (this.readyState === "closed") return
		this.readyState = "closed"
		try {
			this.#ws.close()
		} catch {
			// already closing
		}
	}

	setNoDelay(_noDelay?: boolean): this {
		return this
	}

	setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
		return this
	}

	setTimeout(_timeout?: number): this {
		return this
	}

	#emit(event: string, ...args: unknown[]): void {
		const bucket = this.#listeners.get(event)
		if (bucket === undefined) return
		for (const listener of [...bucket]) listener(...args)
	}
}

const OPEN_TIMEOUT_MS = 5_000

const withTimeout = <T>(promise: Promise<T>, url: string): Promise<T> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`postgres websocket open timed out: ${url}`)),
			OPEN_TIMEOUT_MS,
		)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})

const waitUntilOpen = (ws: WebSocket, url: string): Promise<WebSocket> => {
	if (ws.readyState === WebSocket.OPEN) return Promise.resolve(ws)
	if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
		return Promise.reject(new Error(`failed to open postgres websocket: ${url}`))
	}
	return new Promise((resolve, reject) => {
		const onOpen = () => {
			cleanup()
			resolve(ws)
		}
		const onError = () => {
			cleanup()
			reject(new Error(`failed to open postgres websocket: ${url}`))
		}
		const cleanup = () => {
			ws.removeEventListener("open", onOpen)
			ws.removeEventListener("error", onError)
		}
		ws.addEventListener("open", onOpen)
		ws.addEventListener("error", onError)
	})
}

const httpUpgradeUrl = (wsUrl: string): string => {
	if (wsUrl.startsWith("wss://")) return `https://${wsUrl.slice("wss://".length)}`
	if (wsUrl.startsWith("ws://")) return `http://${wsUrl.slice("ws://".length)}`
	return wsUrl
}

const acceptWorkerSocket = (ws: WebSocket): WebSocket => {
	const accept = (ws as WebSocket & { accept?: () => void }).accept
	if (typeof accept === "function") accept.call(ws)
	if ("binaryType" in ws) ws.binaryType = "arraybuffer"
	return ws
}

const connectViaConstructor = (url: string): Promise<WebSocket> => {
	const ws = new WebSocket(url)
	if ("binaryType" in ws) ws.binaryType = "arraybuffer"
	return waitUntilOpen(ws, url)
}

const connectViaFetchUpgrade = async (wsUrl: string): Promise<WebSocket> => {
	const response = await fetch(httpUpgradeUrl(wsUrl), { headers: { Upgrade: "websocket" } })
	const candidate = (response as Response & { webSocket?: WebSocket | null }).webSocket
	if (!candidate) {
		throw new Error(`postgres websocket upgrade returned no socket: ${wsUrl}`)
	}
	return acceptWorkerSocket(candidate)
}

/**
 * Open `wsProxyUrl` and present a postgres.js-compatible duplex.
 *
 * workerd outbound is `fetch(http://…)` + `Upgrade: websocket` (never
 * `fetch(ws://…)`, which hangs). `new WebSocket()` is the fallback for Node
 * tests. Each attempt is bounded so a stall cannot eat postgres.js's
 * connect_timeout (that timer starts only after this factory returns).
 */
export const openMaplePgWebSocket = async (wsProxyUrl: string): Promise<MaplePgWsDuplex> => {
	const ws = await connectWebSocket(wsProxyUrl)
	return new MaplePgWsDuplex(ws)
}

const connectWebSocket = async (url: string): Promise<WebSocket> => {
	try {
		return await withTimeout(connectViaConstructor(url), url)
	} catch {
		return await withTimeout(connectViaFetchUpgrade(url), url)
	}
}
