// The end-user identity attached to the active session's metadata rows. Kept
// in a tiny module of its own so both the standalone row emitter and the lazily
// loaded replay engine read the same value, however late `identify()` is
// called.
import { type IdentifyInput, normalizeIdentity, type ResolvedIdentity } from "@maple/browser-session"

let currentIdentity: ResolvedIdentity | undefined

/**
 * Attach, replace, or clear the end-user identity on the active session.
 * Idempotent and safe to call on every render — the authoritative session row
 * is the latest one posted, which reads this value at post time.
 *
 * Accepts either a bare user id or the full identity:
 *
 * ```ts
 * identify("user_123")
 * identify({ id: "user_123", email: "a@b.com", groupId: "org_1", groupName: "Acme" })
 * ```
 *
 * Each call *replaces* the identity rather than merging into the previous one —
 * merging would leak a signed-out user's email into whoever signs in next on a
 * shared device.
 */
export const identify = (input?: IdentifyInput): void => {
	currentIdentity = normalizeIdentity(input)
}

/**
 * Drop the end-user identity from the active session — the inverse of
 * `identify()`. Subsequent metadata rows and spans go back to anonymous (no
 * `user.id`), so call this on logout to stop attributing telemetry to the
 * signed-out user. The session itself continues; only the identity is cleared.
 */
export const clearIdentity = (): void => {
	currentIdentity = undefined
}

/** The full identity, for the session metadata row. */
export const getCurrentIdentity = (): ResolvedIdentity | undefined => currentIdentity

/** Just the user id, for span attribution (`user.id`). */
export const getCurrentUserId = (): string | undefined => currentIdentity?.id
