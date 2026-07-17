import { AlertRuleId, IsoDateTimeString, type AlertCheckDocument } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Atom, Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { v2CheckToDocument } from "@/lib/alerts/form-utils"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

const asAlertRuleId = Schema.decodeSync(AlertRuleId)

/**
 * v2 lists are cursor-paginated at 100 items per page, while a rule-detail time
 * window regularly holds hundreds of checks (a 24h window at 5-minute windows is
 * 288+ before grouping). Follow `next_cursor` until the window is exhausted,
 * capped at the old v1 single-response ceiling (2000 checks = 20 pages).
 */
const MAX_CHECK_PAGES = 20
const PAGE_LIMIT = 100

export interface AlertRuleChecksResponse {
	readonly checks: ReadonlyArray<AlertCheckDocument>
}

// Keyed by `ruleId|since|until` — a range change selects a fresh atom, matching
// the old per-range reactivity keys. Built on the mounted v2 runtime so the
// fetch spans export through the Maple OTLP tracer like every other client call.
const checksAtomFamily = Atom.family((key: string) => {
	const [ruleIdRaw = "", sinceRaw = "", untilRaw = ""] = key.split("|")
	const ruleId = asAlertRuleId(ruleIdRaw)
	const since = IsoDateTimeString.make(sinceRaw)
	const until = IsoDateTimeString.make(untilRaw)
	return MapleApiV2AtomClient.runtime.atom(
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			const checks: AlertCheckDocument[] = []
			let cursor: string | undefined
			for (let page = 0; page < MAX_CHECK_PAGES; page++) {
				const response = yield* client.alertRules.checks({
					params: { id: ruleId },
					query: {
						since,
						until,
						limit: PAGE_LIMIT,
						...(cursor !== undefined ? { cursor } : {}),
					},
				})
				for (const check of response.data) checks.push(v2CheckToDocument(check))
				if (!response.has_more || response.next_cursor === null) break
				cursor = response.next_cursor
			}
			return { checks } satisfies AlertRuleChecksResponse
		}),
	)
})

export interface AlertRuleChecksHook {
	readonly result: Result.Result<AlertRuleChecksResponse, unknown>
	readonly refresh: () => void
}

export function useAlertRuleChecks(
	ruleId: AlertRuleId,
	since: IsoDateTimeString,
	until: IsoDateTimeString,
): AlertRuleChecksHook {
	const atom = checksAtomFamily(`${ruleId}|${since}|${until}`)
	const result = useAtomValue(atom)
	const refresh = useAtomRefresh(atom)
	return { result, refresh }
}
