const DEFAULT_CACHE_SECONDS = 15

export interface DirectRouteCachePolicy {
	/** Bump when response or key semantics change incompatibly. */
	readonly version: number
	readonly ttlSeconds: number
	readonly snapWindowSeconds: number
}

export type DirectRouteCachePolicyInput = number | DirectRouteCachePolicy

export function makeDirectRouteCachePolicy(
	options: {
		readonly ttlSeconds?: number
		readonly snapWindowSeconds?: number
		readonly version?: number
	} = {},
): DirectRouteCachePolicy {
	const ttlSeconds = Number.isFinite(options.ttlSeconds)
		? Math.max(1, Math.floor(options.ttlSeconds!))
		: DEFAULT_CACHE_SECONDS
	const requestedSnap = options.snapWindowSeconds ?? ttlSeconds
	const snapWindowSeconds = Number.isFinite(requestedSnap)
		? Math.min(3600, Math.max(1, Math.floor(requestedSnap)))
		: DEFAULT_CACHE_SECONDS
	const version = Number.isFinite(options.version) ? Math.max(1, Math.floor(options.version!)) : 1
	return { version, ttlSeconds, snapWindowSeconds }
}

export function resolveDirectRouteCachePolicy(
	input: DirectRouteCachePolicyInput = DEFAULT_CACHE_SECONDS,
): DirectRouteCachePolicy {
	return typeof input === "number"
		? makeDirectRouteCachePolicy({ ttlSeconds: input })
		: makeDirectRouteCachePolicy(input)
}
