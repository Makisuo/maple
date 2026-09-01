import { createServer } from "node:net"

/** Where preferred ports land: high enough to miss every conventional dev port. */
const RANGE_START = 40000
const RANGE_SIZE = 10000
/** How far past the preferred port to probe before giving up on stickiness. */
const PROBE_WIDTH = 16

const fnv1a = (input: string): number => {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash
}

/** The port `key` maps to before any probing: stable for the same key on every machine. */
export const preferredPort = (key: string): number => RANGE_START + (fnv1a(key) % RANGE_SIZE)

/** Bind-probe `port` on loopback; `0` asks the OS for any free one. Resolves the bound port. */
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

/**
 * A free loopback port for `key`, sticky across runs: the same key prefers the
 * same port, walks forward a few steps if that one is taken (a second worktree
 * running the same app), and only then falls back to an OS-chosen port.
 */
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
