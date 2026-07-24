import { AlertRuleId, IsoDateTimeString, type AlertCheckDocument } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Atom, Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { v2CheckToDocument } from "@/lib/alerts/form-utils"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

const asAlertRuleId = Schema.decodeSync(AlertRuleId)

const PAGE_LIMIT = 100

export interface AlertRuleChecksResponse {
	readonly checks: ReadonlyArray<AlertCheckDocument>
	readonly hasMore: boolean
	readonly nextCursor: string | null
	readonly summary: {
		readonly bucketSeconds: number
		readonly topGroupKeys: ReadonlyArray<string>
		readonly totals: {
			readonly total: number
			readonly breached: number
			readonly healthy: number
			readonly skipped: number
			readonly error: number
			readonly transitions: number
		}
		readonly points: ReadonlyArray<{
			readonly bucket: string
			readonly groupKey: string
			readonly totalCount: number
			readonly breachedCount: number
			readonly healthyCount: number
			readonly skippedCount: number
			readonly errorCount: number
			readonly transitionCount: number
			readonly observedValue: number | null
			readonly threshold: number
		}>
	}
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
			const [response, summary] = yield* Effect.all(
				[
					client.alertRules.checks({
						params: { id: ruleId },
						query: {
							since,
							until,
							limit: PAGE_LIMIT,
						},
					}),
					client.alertRules.checksSummary({
						params: { id: ruleId },
						query: { since, until },
					}),
				],
				{ concurrency: "unbounded" },
			)
			return {
				checks: response.data.map(v2CheckToDocument),
				hasMore: response.has_more,
				nextCursor: response.next_cursor,
				summary: {
					bucketSeconds: summary.bucket_seconds,
					topGroupKeys: summary.top_group_keys,
					totals: summary.totals,
					points: summary.points.map((point) => ({
						bucket: point.bucket,
						groupKey: point.group_key,
						totalCount: point.total_count,
						breachedCount: point.breached_count,
						healthyCount: point.healthy_count,
						skippedCount: point.skipped_count,
						errorCount: point.error_count,
						transitionCount: point.transition_count,
						observedValue: point.observed_value,
						threshold: point.threshold,
					})),
				},
			} satisfies AlertRuleChecksResponse
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
