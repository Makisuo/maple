import { timingSafeEqual } from "node:crypto"

/**
 * Timing-safe check of an `Authorization: Bearer <token>` header against the
 * shared internal token (`SD_INTERNAL_TOKEN`). Used by the internal scraper
 * endpoints; never configured ⇒ always unauthorized.
 */
export const isValidInternalBearer = (
	authorizationHeader: string | undefined,
	internalToken: string | undefined,
): boolean => {
	if (!internalToken) return false
	const provided = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice(7).trim() : ""
	return (
		provided.length === internalToken.length &&
		timingSafeEqual(Buffer.from(provided), Buffer.from(internalToken))
	)
}
