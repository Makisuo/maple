// The end-user id attached to the active session's metadata rows. Kept in a
// tiny module of its own so both the standalone row emitter and the lazily
// loaded replay engine read the same value, however late `identify()` is
// called.
let currentUserId: string | undefined

/**
 * Attach (or replace) the end-user id on the active session. Idempotent and
 * safe to call on every render — the authoritative session row is the latest
 * one posted, which reads this value at post time.
 */
export const identify = (userId: string): void => {
	if (!userId) return
	currentUserId = userId
}

export const getCurrentUserId = (): string | undefined => currentUserId
