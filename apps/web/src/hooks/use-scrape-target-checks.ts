import type { ScrapeTargetId } from "@maple/domain/http"
import type { V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { Atom, Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useIntervalRefresh } from "./use-interval-refresh"

const CHECKS_LIMIT = 20
const CHECKS_REFRESH_INTERVAL_MS = 10_000

export interface ScrapeTargetChecksResponse {
	readonly checks: ReadonlyArray<V2ScrapeTargetCheck>
}

export interface ScrapeTargetChecksHook {
	readonly result: Result.Result<ScrapeTargetChecksResponse, unknown>
	readonly refresh: () => void
}

// One cached query atom per target. Unlike the old Electric collection this
// fetches only the selected target's latest checks, so the settings list never
// fans out into one HTTP request per row.
const checksAtomFamily = Atom.family((targetId: ScrapeTargetId) =>
	MapleApiV2AtomClient.runtime.atom(
		MapleApiV2AtomClient.use((client) =>
			client.scrapeTargets.listChecks({
				params: { id: targetId },
				query: { limit: CHECKS_LIMIT },
			}),
		).pipe(Effect.map((response) => ({ checks: response.data }) satisfies ScrapeTargetChecksResponse)),
	),
)

/** Latest scheduled checks for the selected target, refreshed while visible. */
export function useScrapeTargetChecks(targetId: ScrapeTargetId): ScrapeTargetChecksHook {
	const atom = checksAtomFamily(targetId)
	const result = useAtomValue(atom)
	const refresh = useAtomRefresh(atom)

	useIntervalRefresh(refresh, { intervalMs: CHECKS_REFRESH_INTERVAL_MS, enabled: true })

	return { result, refresh }
}
