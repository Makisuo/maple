import { createServer } from "node:net"

const RANGE_START = 40000
const RANGE_SIZE = 10000
const PROBE_WIDTH = 16

const fnv1a = (input: string): number => {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash
}

/** The port `key` maps to before probing; stable across machines. */
export const preferredPort = (key: string): number => RANGE_START + (fnv1a(key) % RANGE_SIZE)

/** Bind-probe `port` on loopback (`0` = any free one); resolves the bound port. */
const tryListen = (port: number): Promise<number | undefined> =>
	new Promise((resolve) => {
		const server = createServer()
		server.unref()
		server.on("error", () => resolve(undefined))
		server.listen({ host: "127.0.0.1", port }, () => {
			const address = server.address()
			const bound = address !== null && typeof address !== "string" ? address.port : undefined
			server.close(() => resolve(bound))
		})
	})

/** A free port for `key`: the preferred one, then a few steps forward, then any. */
export const choosePort = async (key: string): Promise<number> => {
	const preferred = preferredPort(key)
	for (let offset = 0; offset < PROBE_WIDTH; offset++) {
		const bound = await tryListen(preferred + offset)
		if (bound !== undefined) return bound
	}
	const random = await tryListen(0)
	if (random === undefined) throw new Error(`could not find a free port for ${key}`)
	return random
}
