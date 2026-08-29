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
}

// Actor types and outcomes never contain "|", and the cursor is the trailing
// segment, so splitting on the first two separators stays unambiguous even for
// exotic cursors.
const family = Atom.family((key: string) => {
	const firstSeparator = key.indexOf("|")
	const secondSeparator = key.indexOf("|", firstSeparator + 1)
	const actorRaw = key.slice(0, firstSeparator)
	const outcomeRaw = key.slice(firstSeparator + 1, secondSeparator)
	const cursor = key.slice(secondSeparator + 1)
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
				},
			})
		}),
	)
})

/** One page of the org's audit log, keyed by cursor + actor-type/outcome filters. */
export const auditLogPageAtom = (input: AuditLogPageInput) =>
	family(`${input.actorType ?? ""}|${input.outcome ?? ""}|${input.cursor ?? ""}`)
