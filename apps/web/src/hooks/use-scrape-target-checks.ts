import { ScrapeTargetChecksListResponse, type ScrapeTargetId } from "@maple/domain/http"
import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import { rowToScrapeTargetCheckDocument } from "@/lib/collections/scrape-targets"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"
import { Result } from "@/lib/effect-atom"

type ListError = { readonly message: string }

export interface ScrapeTargetChecksHook {
	readonly result: Result.Result<ScrapeTargetChecksListResponse, ListError>
	readonly refresh: () => void
}

const noop = () => {}

/**
 * Live `scrape_target_checks` for one target, synced via Electric. Mirrors the
 * server's `listChecks` (newest-first, capped at `limit`) but stays current
 * without polling — replaces `MapleApiAtomClient.query("scrapeTargets",
 * "listChecks", …)`. The collection holds every check for the org; we filter to
 * the target client-side (bounded to 24h / 10k-per-target by server pruning),
 * exactly like `useAlertRuleStates` filters by rule id.
 */
export function useScrapeTargetChecks(targetId: ScrapeTargetId, limit: number): ScrapeTargetChecksHook {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const collection = useMemo(
		() => getOrgCollections(orgKey).scrapeTargetChecks,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)

	const { data: rows, isLoading } = useLiveQuery((q) => q.from({ c: collection }), [collection])

	const result = useMemo<Result.Result<ScrapeTargetChecksListResponse, ListError>>(() => {
		if (isLoading && (rows?.length ?? 0) === 0) return Result.initial(true)
		const checks = (rows ?? [])
			.filter((row) => row.target_id === targetId)
			// ISO timestamps order lexicographically; newest first, matching the server.
			.sort((a, b) => (a.checked_at < b.checked_at ? 1 : a.checked_at > b.checked_at ? -1 : 0))
			.slice(0, limit)
			.map(rowToScrapeTargetCheckDocument)
		return Result.success(new ScrapeTargetChecksListResponse({ checks }))
	}, [rows, isLoading, targetId, limit])

	return { result, refresh: noop }
}
