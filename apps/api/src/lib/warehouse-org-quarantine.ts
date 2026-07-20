import type { EdgeCacheServiceShape } from "@maple/query-engine/caching"
import { Cause, Effect, Option } from "effect"

/**
 * Per-org quarantine for the cross-org alerting ticks (errors / anomalies /
 * digests). An org whose warehouse rejects queries with an auth/config-class
 * error (e.g. a Tinybird token whose workspace no longer exists) fails
 * identically on every tick — retrying each 1–5 min only burns quota and floods
 * the error dashboards. When a tick's per-org failure carries such an error,
 * the org is parked in the edge cache and skipped until the TTL expires, which
 * doubles as the automatic retry once the org's config is repaired.
 *
 * Scoped to warehouse-connectivity errors only: transient upstream failures
 * (`WarehouseUpstreamError`) and genuine query bugs keep retrying every tick.
 */

const QUARANTINE_BUCKET = "warehouse-org-quarantine"
const QUARANTINE_TTL_S = 6 * 60 * 60

type EdgeCache = EdgeCacheServiceShape

/**
 * Errors that indicate the org's warehouse is unusable until an operator fixes
 * its configuration — not until the next retry.
 */
const QUARANTINE_ERROR_TAGS: ReadonlySet<string> = new Set([
	"@maple/http/errors/WarehouseAuthError",
	"@maple/http/errors/WarehouseConfigError",
])

const hasQuarantineTag = (value: unknown, depth = 0): boolean => {
	if (depth > 8 || typeof value !== "object" || value === null) return false
	const candidate = value as { readonly _tag?: unknown; readonly cause?: unknown }
	if (typeof candidate._tag === "string" && QUARANTINE_ERROR_TAGS.has(candidate._tag)) return true
	// Services wrap warehouse failures in their own tagged errors (e.g.
	// AnomalyPersistenceError) with the original error as `cause` — walk it.
	return hasQuarantineTag(candidate.cause, depth + 1)
}

/** Does this cause (or anything wrapped inside it) carry an auth/config-class warehouse error? */
export const causeHasWarehouseConfigClassError = <E>(cause: Cause.Cause<E>): boolean =>
	cause.reasons.some((reason) =>
		Cause.isFailReason(reason)
			? hasQuarantineTag(reason.error)
			: Cause.isDieReason(reason) && hasQuarantineTag(reason.defect),
	)

/** Best-effort check — a cache failure never blocks the tick, it just disables the skip. */
export const isOrgWarehouseQuarantined = (edgeCache: EdgeCache, orgId: string) =>
	edgeCache
		.rawGet<number>(QUARANTINE_BUCKET, orgId)
		.pipe(
			Effect.map(Option.isSome),
			Effect.orElseSucceed(() => false),
		)

/** Park the org for `QUARANTINE_TTL_S`. Best-effort; failures are ignored. */
export const quarantineOrgWarehouse = (edgeCache: EdgeCache, orgId: string, nowMs: number) =>
	edgeCache.rawPut(QUARANTINE_BUCKET, orgId, nowMs, QUARANTINE_TTL_S).pipe(Effect.ignore)

/**
 * Shared per-org failure seam for the alerting ticks: when the failure is
 * config-class, quarantine the org and log at Info (expected, parked); anything
 * else is logged at Error as before. Returns whether the org was quarantined.
 */
export const quarantineOnConfigClassCause = <E>(
	edgeCache: EdgeCache,
	orgId: string,
	cause: Cause.Cause<E>,
	nowMs: number,
) =>
	causeHasWarehouseConfigClassError(cause)
		? quarantineOrgWarehouse(edgeCache, orgId, nowMs).pipe(Effect.as(true))
		: Effect.succeed(false)
