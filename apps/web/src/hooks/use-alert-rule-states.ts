import { useLiveQuery } from "@tanstack/react-db"
import { useMemo } from "react"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { ELECTRIC_SYNC_ENABLED } from "@/lib/collections/config"
import {
	getOrgCollections,
	useActiveOrgId,
	useCollectionsGeneration,
} from "@/lib/collections/org-collections"

const EMPTY_STATES: ReadonlyArray<AlertRuleStateRow> = []

/**
 * Live per-group evaluation state (`alert_rule_states` rows: last status/value/
 * sample count/evaluated-at/error per `(ruleId, groupKey)`), synced via
 * Electric. Powers the overview status derivation and the rule diagnosis panel.
 *
 * Non-Electric builds return `[]` — consumers must treat missing states as
 * "unknown" and degrade to the rule document's `lastEvaluationError` /
 * `lastEvaluatedAt` fields.
 */
export function useAlertRuleStates(ruleId?: string): ReadonlyArray<AlertRuleStateRow> {
	if (ELECTRIC_SYNC_ENABLED) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useAlertRuleStatesCollection(ruleId)
	}
	return EMPTY_STATES
}

function useAlertRuleStatesCollection(ruleId?: string): ReadonlyArray<AlertRuleStateRow> {
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

/** Group state rows per rule id, for overview-style consumers. */
export function statesByRuleId(
	states: ReadonlyArray<AlertRuleStateRow>,
): Map<string, AlertRuleStateRow[]> {
	const map = new Map<string, AlertRuleStateRow[]>()
	for (const state of states) {
		const list = map.get(state.rule_id)
		if (list) list.push(state)
		else map.set(state.rule_id, [state])
	}
	return map
}
