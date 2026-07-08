// The end-user id attached to the active session's metadata rows. Kept in a
// tiny module of its own so both the standalone row emitter and the lazily
// loaded replay engine read the same value, however late `identify()` is
// called.
let currentUserId: string | undefined

/**
 * Attach, replace, or clear the end-user id on the active session. Idempotent
 * and safe to call on every render — the authoritative session row is the
 * latest one posted, which reads this value at post time.
 */
export const identify = (userId?: string | null): void => {
	currentUserId = userId ? userId : undefined
}

/**
 * Drop the end-user id from the active session — the inverse of `identify()`.
 * Subsequent metadata rows and spans go back to anonymous (no `user.id`), so
 * call this on logout to stop attributing telemetry to the signed-out user.
 * The session itself continues; only the identity is cleared.
 */
export const clearIdentity = (): void => {
	currentUserId = undefined
}

export const getCurrentUserId = (): string | undefined => currentUserId
