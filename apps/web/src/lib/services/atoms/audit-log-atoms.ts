import type { AuditActorType, AuditOutcome } from "@maple/domain/http"
import { Effect } from "effect"
import { Atom } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

export const AUDIT_LOG_PAGE_LIMIT = 50

const ACTOR_TYPES: ReadonlyArray<AuditActorType> = ["user", "api_key", "agent", "system"]
const OUTCOMES: ReadonlyArray<AuditOutcome> = ["allowed", "denied"]

export interface AuditLogPageInput {
	readonly cursor?: string
	readonly actorType?: AuditActorType
	readonly outcome?: AuditOutcome
	/**
	 * Upper bound on `occurred_at`, pinned by the caller when it takes the first
	 * page. Pagination here is offset-based over a newest-first, append-only
	 * table, so an entry written mid-scroll shifts every later row down by one:
	 * without a frozen ceiling the next page repeats a row and skips another.
	 */
	readonly until?: string
}

// Actor types and outcomes never contain "|", nor does an ISO timestamp, and the
// cursor is the trailing segment — so splitting on the first three separators
// stays unambiguous even for exotic cursors.
const family = Atom.family((key: string) => {
	const [actorRaw = "", outcomeRaw = "", until = ""] = key.split("|", 3)
	const cursor = key.slice(actorRaw.length + outcomeRaw.length + until.length + 3)
	const actorType = ACTOR_TYPES.find((type) => type === actorRaw)
	const outcome = OUTCOMES.find((value) => value === outcomeRaw)

	return MapleApiV2AtomClient.runtime.atom(
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.auditLog.list({
				query: {
					limit: AUDIT_LOG_PAGE_LIMIT,
					...(cursor !== "" ? { cursor } : undefined),
					...(actorType !== undefined ? { actor_type: actorType } : undefined),
					...(outcome !== undefined ? { outcome } : undefined),
					...(until !== "" ? { until } : undefined),
				},
			})
		}),
	)
})

/** One page of the org's audit log, keyed by cursor + filters + the pinned ceiling. */
export const auditLogPageAtom = (input: AuditLogPageInput) =>
	family(`${input.actorType ?? ""}|${input.outcome ?? ""}|${input.until ?? ""}|${input.cursor ?? ""}`)
