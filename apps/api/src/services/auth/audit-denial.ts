import { Clock, Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import type { AuditLogServiceApi } from "@/services/audit/AuditLogService"

/** Suppress duplicate denial rows for the same key/reason within this window. */
export const AUDIT_DENIAL_COALESCE_WINDOW_MS = 60_000

/** Bound on distinct in-flight denial signatures kept per isolate. */
const MAX_TRACKED_DENIALS = 10_000

/**
 * Isolate-local coalescing cache: last-recorded time per denial signature.
 * Tradeoff: Workers isolates multiply and recycle, so suppression is
 * best-effort — each isolate still records the first denial it sees, which is
 * the forensic signal; only the repeat volume is shed, with no network hop.
 */
const recentDenials = new Map<string, number>()

/** Test-only: clear the isolate-local coalescing state between cases. */
export const resetAuditDenialCoalescing = (): void => {
	recentDenials.clear()
}

/**
 * True when this signature has not been recorded within the window; marks it
 * recorded. The timestamp is not refreshed on suppression, so a sustained loop
 * still lands one row per window rather than going silent forever.
 */
const shouldRecordDenial = (signature: string, now: number): boolean => {
	const last = recentDenials.get(signature)
	if (last !== undefined && now - last < AUDIT_DENIAL_COALESCE_WINDOW_MS) return false
	// Delete-then-set keeps insertion order ≈ recency, so the bound evicts the stalest signature.
	recentDenials.delete(signature)
	if (recentDenials.size >= MAX_TRACKED_DENIALS) {
		const oldest = recentDenials.keys().next()
		if (!oldest.done) recentDenials.delete(oldest.value)
	}
	recentDenials.set(signature, now)
	return true
}

export interface ApiDenialInput {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly apiKeyId: ApiKeyId
	readonly denialReason: string
}

const requestPath = (url: string): string => {
	const queryStart = url.indexOf("?")
	return queryStart === -1 ? url : url.slice(0, queryStart)
}

/**
 * Record a denied public-API request with full forensics (method+path plus the
 * `cf-ray`/`cf-connecting-ip`/`cf-ipcountry` headers), coalescing duplicates:
 * the same (org, key, method+path, reason) is written at most once per window
 * so a client looping mis-scoped requests cannot amplify into unbounded queue
 * messages, rows, and warn logs. Never fails — same contract as `record`.
 */
export const recordApiDenial = (
	audit: AuditLogServiceApi,
	request: HttpServerRequest.HttpServerRequest,
	input: ApiDenialInput,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const path = requestPath(request.url)
		const signature = `${input.orgId}|${input.apiKeyId}|${request.method} ${path}|${input.denialReason}`
		if (!shouldRecordDenial(signature, now)) return
		yield* audit.record({
			orgId: input.orgId,
			actor: {
				type: "api_key",
				userId: input.userId,
				apiKeyId: input.apiKeyId,
			},
			source: "api",
			action: "api.request",
			outcome: "denied",
			denialReason: input.denialReason,
			metadata: { method: request.method, path },
			...(request.headers["cf-ray"] !== undefined
				? { requestId: request.headers["cf-ray"] }
				: undefined),
			...(request.headers["cf-connecting-ip"] !== undefined
				? { originIp: request.headers["cf-connecting-ip"] }
				: undefined),
			...(request.headers["cf-ipcountry"] !== undefined
				? { originCountry: request.headers["cf-ipcountry"] }
				: undefined),
		})
	})
