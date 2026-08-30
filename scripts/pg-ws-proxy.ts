/**
 * Host-side Postgres bridge for celld.
 *
 * celld cannot TCP-dial `localhost:5499`, and workerd postgres.js SCRAM against
 * real Postgres fails. This process:
 *   - GET /v1?address=host:port (and /v2) — Neon-compatible WebSocket byte pipe
 *     (`@neondatabase/serverless` / `neondatabase/wsproxy`)
 *   - POST /sql — drizzle-orm/pg-proxy sidecar (tests / fallback only)
 *   - WebSocket on other paths — raw byte tunnel to the configured target (tests)
 *
 * Usage:
 *   bun scripts/pg-ws-proxy.ts
 *   bun scripts/pg-ws-proxy.ts --listen 127.0.0.1:5498 --target 127.0.0.1:5499
 */
import postgres from "../packages/db/node_modules/postgres/src/index.js"

export interface PgWsProxyOptions {
	readonly listenHost?: string
	readonly listenPort?: number
	readonly targetHost?: string
	readonly targetPort?: number
	readonly connectionString?: string
}

export interface PgWsProxyHandle {
	readonly url: string
	readonly listenHost: string
	readonly listenPort: number
	readonly stop: () => void
}

type Tunnel = {
	socket?: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S : never
	pending: Uint8Array[]
	closed: boolean
	targetHost: string
	targetPort: number
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

const parseAddressParam = (raw: string): { host: string; port: number } | undefined => {
	const trimmed = raw.trim()
	const colon = trimmed.lastIndexOf(":")
	if (colon <= 0) return undefined
	const host = trimmed.slice(0, colon)
	const port = Number(trimmed.slice(colon + 1))
	if (host.length === 0 || !Number.isFinite(port) || port <= 0) return undefined
	return { host, port }
}

const extraAllowedHosts = (): ReadonlySet<string> => {
	const raw = process.env.MAPLE_PG_WS_ALLOW ?? ""
	return new Set(
		raw
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0),
	)
}

const isAllowedProxyAddress = (host: string, configuredHost: string): boolean => {
	const normalized = host.replace(/^\[|\]$/g, "")
	if (LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(normalized)) return true
	if (host === configuredHost || normalized === configuredHost) return true
	const extra = extraAllowedHosts()
	return extra.has(host) || extra.has(normalized)
}

const toBytes = (message: string | ArrayBuffer | Uint8Array): Uint8Array => {
	if (typeof message === "string") return new TextEncoder().encode(message)
	if (message instanceof Uint8Array) return message
	return new Uint8Array(message)
}

const parseHostPort = (raw: string | undefined, fallbackHost: string, fallbackPort: number) => {
	if (raw === undefined || raw.trim().length === 0) {
		return { host: fallbackHost, port: fallbackPort }
	}
	const trimmed = raw.trim()
	const colon = trimmed.lastIndexOf(":")
	if (colon <= 0) {
		const port = Number(trimmed)
		if (!Number.isFinite(port)) throw new Error(`invalid host:port ${raw}`)
		return { host: fallbackHost, port }
	}
	const host = trimmed.slice(0, colon)
	const port = Number(trimmed.slice(colon + 1))
	if (host.length === 0 || !Number.isFinite(port) || port <= 0) {
		throw new Error(`invalid host:port ${raw}`)
	}
	return { host, port }
}

export const startPgWsProxy = async (options: PgWsProxyOptions = {}): Promise<PgWsProxyHandle> => {
	const listenHost = options.listenHost ?? "127.0.0.1"
	const listenPort = options.listenPort ?? 5498
	const targetHost = options.targetHost ?? "127.0.0.1"
	const targetPort = options.targetPort ?? 5499
	const connectionString =
		options.connectionString ??
		process.env.MAPLE_PG_URL ??
		`postgres://maple:maple@${targetHost}:${targetPort}/maple`
	const sql = postgres(connectionString, { max: 5, fetch_types: false, prepare: false })

	const server = Bun.serve<Tunnel>({
		hostname: listenHost,
		port: listenPort,
		async fetch(request, srv) {
			const url = new URL(request.url)
			if (request.method === "POST" && url.pathname === "/sql") {
				try {
					const body = (await request.json()) as {
						readonly sql?: string
						readonly params?: unknown[]
						readonly method?: string
					}
					if (typeof body.sql !== "string" || body.sql.length === 0) {
						return Response.json({ error: "sql is required" }, { status: 400 })
					}
					const params = Array.isArray(body.params) ? body.params : []
					const query = sql.unsafe(body.sql, params as never[])
					const rows = body.method === "all" ? await query.values() : await query
					return Response.json({ rows })
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : "postgres proxy query failed"
					return Response.json({ error: message }, { status: 500 })
				}
			}
			let destHost = targetHost
			let destPort = targetPort
			if (url.pathname === "/v1" || url.pathname === "/v2") {
				const address = url.searchParams.get("address")
				if (address !== null && address.length > 0) {
					const parsed = parseAddressParam(address)
					if (parsed === undefined) {
						return new Response("invalid address", { status: 400 })
					}
					if (!isAllowedProxyAddress(parsed.host, targetHost)) {
						return new Response("address not allowed", { status: 403 })
					}
					destHost = parsed.host
					destPort = parsed.port
				}
			}
			if (
				srv.upgrade(request, {
					data: { pending: [], closed: false, targetHost: destHost, targetPort: destPort },
				})
			) {
				return undefined
			}
			return new Response("Expected WebSocket or POST /sql", { status: 426 })
		},
		websocket: {
			async open(ws) {
				try {
					const socket = await Bun.connect({
						hostname: ws.data.targetHost,
						port: ws.data.targetPort,
						socket: {
							data(_sock, data) {
								if (ws.data.closed) return
								ws.send(data)
							},
							error(_sock, error) {
								if (ws.data.closed) return
								ws.close(1011, error.message)
							},
							close() {
								if (ws.data.closed) return
								ws.close(1000)
							},
						},
					})
					if (ws.data.closed) {
						socket.end()
						return
					}
					ws.data.socket = socket
					for (const chunk of ws.data.pending) socket.write(chunk)
					ws.data.pending = []
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : "tcp connect failed"
					ws.close(1011, message)
				}
			},
			message(ws, message) {
				const bytes = toBytes(message)
				const socket = ws.data.socket
				if (socket === undefined) {
					ws.data.pending.push(bytes)
					return
				}
				socket.write(bytes)
			},
			close(ws) {
				ws.data.closed = true
				ws.data.socket?.end()
			},
		},
	})

	return {
		url: `ws://${listenHost}:${server.port}`,
		listenHost,
		listenPort: server.port,
		stop: () => {
			server.stop(true)
			void sql.end({ timeout: 1 }).catch(() => undefined)
		},
	}
}

const parseArgs = (argv: string[]): PgWsProxyOptions => {
	const options: { listen?: string; target?: string } = {}
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const next = argv[index + 1]
		if (arg === "--listen" && next) {
			options.listen = next
			index += 1
		} else if (arg === "--target" && next) {
			options.target = next
			index += 1
		}
	}
	const listen = parseHostPort(options.listen ?? process.env.MAPLE_PG_WS_PROXY_LISTEN, "127.0.0.1", 5498)
	const target = parseHostPort(options.target ?? process.env.MAPLE_PG_PROXY_TARGET, "127.0.0.1", 5499)
	return {
		listenHost: listen.host,
		listenPort: listen.port,
		targetHost: target.host,
		targetPort: target.port,
	}
}

if (import.meta.main) {
	const proxy = await startPgWsProxy(parseArgs(process.argv.slice(2)))
	console.log(`pg-ws-proxy listening on ${proxy.url} → postgres`)
}
