/**
 * Detect "this table is missing on the org's cluster" so a caller can read a
 * raw-source equivalent (or degrade) instead of 502ing.
 *
 * Rollup and newer tables (`product_events` since migration 0016, the
 * `service_operations_*` rollups) ship in `requiredForIngest: false`
 * migrations, which reach a BYO-ClickHouse cluster only when an org admin
 * clicks Apply schema — nothing reconciles that, so the window where an org
 * lacks one is unbounded, per-org, and invisible from here. The only correct
 * response is to notice at query time.
 *
 * Matches the classified `WarehouseConfigError` (ClickHouse `UNKNOWN_TABLE`,
 * or the Tinybird gateway's "Resource '<name>' not found", which the query
 * engine classifies the same way) whose message names the table.
 */
const isMissingTable =
	(table: RegExp) =>
	(error: unknown): boolean => {
		if (typeof error !== "object" || error === null) return false
		const candidate = error as {
			readonly _tag?: unknown
			readonly clickhouseType?: unknown
			readonly message?: unknown
		}
		return (
			candidate._tag === "@maple/http/errors/WarehouseConfigError" &&
			(candidate.clickhouseType === "UNKNOWN_TABLE" ||
				(typeof candidate.message === "string" && table.test(candidate.message)))
		)
	}

/**
 * Only page-view queries may degrade on this one — raw `session_events` holds
 * the same browser rows. Funnels have no raw counterpart (server and mobile
 * rows exist only in `product_events`) and must surface the error.
 */
export const isMissingProductEvents = isMissingTable(/product_events/i)

export const isMissingServiceOperationsRollup = isMissingTable(/service_operations_(?:minutely|hourly)/i)

/** Agent Sessions detection reads this `requiredForIngest: false` projection;
 *  the callers degrade to an empty page rather than 502ing an org whose admin
 *  has not applied migration 0023 yet. */
export const isMissingAiTraceIndex = isMissingTable(/ai_trace_index/i)
