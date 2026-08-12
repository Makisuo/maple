/**
 * Per-investigation collections, and why they are not part of `OrgCollections`.
 *
 * Every other synced collection is org-wide and there is exactly one live set at
 * a time, because the app shows one org at a time. These two are scoped to a
 * single investigation — an org accumulates investigations forever and a browser
 * renders one, so an org-wide shape would stream the whole history to read one
 * page. That makes their lifecycle navigation-shaped rather than session-shaped:
 * a new set per investigation opened, torn down once nothing reads it.
 *
 * The registry is keyed on `(orgId, generation, investigationId)` so it composes
 * with the org set's two invalidations — an org switch and a self-heal generation
 * bump both mint fresh streams here too.
 */
import { cleanupCollectionWhenIdle, getCollectionsGeneration } from "./org-collections"
import {
	createInvestigationCollection,
	createInvestigationLensRunsCollection,
	type InvestigationCollection,
	type InvestigationLensRunsCollection,
} from "./investigations"

export type InvestigationCollections = {
	readonly key: string
	readonly investigation: InvestigationCollection
	readonly lensRuns: InvestigationLensRunsCollection
}

/**
 * At most one investigation is on screen, so a single-entry cache is the whole
 * requirement — and it is also what bounds the shape handles a session can open.
 * Navigating between runs tears the previous pair down as it drains.
 */
let current: InvestigationCollections | null = null

const keyOf = (orgId: string, investigationId: string): string =>
	`${orgId}:${getCollectionsGeneration()}:${investigationId}`

export const getInvestigationCollections = (
	orgId: string,
	investigationId: string,
): InvestigationCollections => {
	const key = keyOf(orgId, investigationId)
	if (current && current.key === key) return current
	const previous = current
	current = {
		key,
		investigation: createInvestigationCollection(orgId, investigationId),
		lensRuns: createInvestigationLensRunsCollection(orgId, investigationId),
	}
	// Swap first, tear down after — an in-flight read must never resolve against
	// the collection we are replacing. Deferred until its live queries unsubscribe,
	// for the reason `scheduleOrgCollectionsCleanup` defers: cleaning up underneath
	// a live query restarts sync on a dead collection.
	if (previous) {
		cleanupCollectionWhenIdle(previous.investigation)
		cleanupCollectionWhenIdle(previous.lensRuns)
	}
	return current
}
