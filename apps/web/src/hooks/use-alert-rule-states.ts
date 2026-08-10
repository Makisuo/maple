import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import type { AlertRuleId } from "@maple/domain/http"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"

/**
 * Live per-group evaluation state (`alert_rule_states` rows: last status/value/
 * sample count/evaluated-at/error per `(ruleId, groupKey)`), synced via
 * Electric. Powers the overview status derivation and the rule diagnosis panel.
 */
export function useAlertRuleStates(ruleId?: AlertRuleId): ReadonlyArray<AlertRuleStateRow> {
	const orgKey = useActiveOrgId() ?? "pending"
	const generation = useCollectionsGeneration()
	const collection = useMemo(
		() => getOrgCollections(orgKey).alertRuleStates,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[orgKey, generation],
	)

	const { data: rows } = useLiveQuery((q) => q.from({ s: collection }), [collection])

	return useMemo(() => {
		const all = rows ?? []
		return ruleId != null ? all.filter((row) => row.rule_id === ruleId) : all
	}, [rows, ruleId])
}
