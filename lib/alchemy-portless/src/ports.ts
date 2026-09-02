import { createServer } from "node:net"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const RANGE_SIZE = 10000
const PROBE_WIDTH = 16

/** Probed routes and plan-time Worker ports live in disjoint ranges so a hash collision cannot pair them. */
export const PortRange = { route: 40000, worker: 50000 } as const

const fnv1a = (input: string): number => {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash
}

/** The port `key` maps to before probing; stable across machines. */
export const preferredPort = (key: string, base: number = PortRange.route): number =>
	base + (fnv1a(key) % RANGE_SIZE)

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

export class NoFreePortError extends Schema.TaggedError<NoFreePortError>()("Portless.NoFreePortError", {
	key: Schema.String,
	message: Schema.String,
}) {}

/** A free port for `key`: the preferred one, then a few steps forward, then any. */
export const choosePort = (key: string): Effect.Effect<number, NoFreePortError> =>
	Effect.gen(function* () {
		const preferred = preferredPort(key)
		for (let offset = 0; offset < PROBE_WIDTH; offset++) {
			const bound = yield* Effect.promise(() => tryListen(preferred + offset))
			if (bound !== undefined) return bound
		}
		const random = yield* Effect.promise(() => tryListen(0))
		if (random === undefined) {
			return yield* new NoFreePortError({ key, message: `could not find a free port for ${key}` })
		}
		return random
	})
