import { createServer } from "node:net"
import { describe, expect, it } from "bun:test"
import { startPgWsProxy } from "./pg-ws-proxy"

const listenTcpEcho = async (): Promise<{ port: number; close: () => void }> => {
	const server = createServer((socket) => {
		socket.on("data", (chunk) => socket.write(chunk))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (address === null || typeof address === "string") {
		throw new Error("tcp echo did not bind a port")
	}
	return { port: address.port, close: () => server.close() }
}

describe("pg-ws-proxy", () => {
	it("executes SQL over POST /sql through host postgres.js", async () => {
		const proxy = await startPgWsProxy({
			listenHost: "127.0.0.1",
			listenPort: 0,
			connectionString: "postgres://maple:maple@127.0.0.1:5499/maple",
		})
		try {
			const response = await fetch(`http://127.0.0.1:${proxy.listenPort}/sql`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sql: "select 1::int as x", params: [], method: "execute" }),
			})
			const payload = (await response.json()) as { rows: Array<{ x: number }> }
			expect(response.ok).toBe(true)
			expect(payload.rows[0]?.x).toBe(1)
		} finally {
			proxy.stop()
		}
	})

	it("upgrades /v1?address= to a raw byte pipe at the requested TCP target", async () => {
		const echo = await listenTcpEcho()
		const proxy = await startPgWsProxy({
			listenHost: "127.0.0.1",
			listenPort: 0,
			targetHost: "127.0.0.1",
			targetPort: 1,
		})
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${proxy.listenPort}/v1?address=127.0.0.1:${echo.port}`)
			ws.binaryType = "arraybuffer"
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true })
				ws.addEventListener("error", () => reject(new Error("websocket failed to open")), {
					once: true,
				})
			})

			const payload = new Uint8Array([9, 8, 7, 6])
			const reply = new Promise<Uint8Array>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no echo")), 2_000)
				ws.addEventListener(
					"message",
					(event) => {
						clearTimeout(timer)
						resolve(new Uint8Array(event.data as ArrayBuffer))
					},
					{ once: true },
				)
			})
			ws.send(payload)
			expect(Array.from(await reply)).toEqual(Array.from(payload))
			ws.close()
		} finally {
			proxy.stop()
			echo.close()
		}
	})

	it("rejects a /v1 address that is not loopback or the configured target", async () => {
		const proxy = await startPgWsProxy({
			listenHost: "127.0.0.1",
			listenPort: 0,
			targetHost: "127.0.0.1",
			targetPort: 5499,
		})
		try {
			const response = await fetch(`http://127.0.0.1:${proxy.listenPort}/v1?address=example.com:5432`, {
				headers: { Upgrade: "websocket" },
			})
			expect(response.status).toBe(403)
		} finally {
			proxy.stop()
		}
	})

	it("copies binary frames between a websocket client and TCP postgres", async () => {
		const echo = await listenTcpEcho()
		const proxy = await startPgWsProxy({
			listenHost: "127.0.0.1",
			listenPort: 0,
			targetHost: "127.0.0.1",
			targetPort: echo.port,
		})
		try {
			const ws = new WebSocket(proxy.url)
			ws.binaryType = "arraybuffer"
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true })
				ws.addEventListener("error", () => reject(new Error("websocket failed to open")), {
					once: true,
				})
			})

			const payload = new Uint8Array([0, 3, 0, 0, 81])
			const reply = new Promise<Uint8Array>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no echo")), 2_000)
				ws.addEventListener(
					"message",
					(event) => {
						clearTimeout(timer)
						resolve(new Uint8Array(event.data as ArrayBuffer))
					},
					{ once: true },
				)
			})
			ws.send(payload)
			expect(Array.from(await reply)).toEqual(Array.from(payload))
			ws.close()
		} finally {
			proxy.stop()
			echo.close()
		}
	})
})
