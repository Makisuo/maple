/**
 * The dashboards-list unit: the org's Electric-synced `dashboards` collection
 * derived into the sorted, decoded list the /dashboards route renders. The
 * decode + sort that used to run inside `useDashboardStore`'s live query now
 * recomputes only when the collection emits, and lives outside the component
 * tree (importable from a non-React runtime).
 *
 * List preferences (favorites/sort/tag filter) and all mutations stay in the
 * component — preferences are localStorage/React concerns, and writes go
 * through `useDashboardMutations` so the route's action handlers add no read
 * subscription of their own.
 */

import { Model, Store } from "@maple/unitflow"
import * as Db from "@maple/unitflow/db"
import * as Effect from "effect/Effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

import type { Dashboard } from "@/components/dashboard-builder/types"
import { type DashboardRow, rowToDashboard } from "@/lib/collections/dashboards"
import { getOrgCollections } from "@/lib/collections/org-collections"
import { collectionFailureMessage, makeOrgCollectionsKey, orgIdOf } from "@/lib/models/org-collections-key"

/** The fully derived list — everything the route renders when ready. */
export interface DashboardsListReady {
	readonly phase: "ready"
	readonly dashboards: ReadonlyArray<Dashboard>
}

/** The derived list, in the phases the route renders distinctly. */
export type DashboardsListData =
	| { readonly phase: "loading" }
	| { readonly phase: "error"; readonly message: string }
	| DashboardsListReady

/**
 * The whole list derivation as one pure function over raw rows — unit-testable
 * without React or a registry. Newest-updated first (the order the old live
 * query's `orderBy(updated_at, "desc")` produced); an undecodable
 * `payload_json` drops its row rather than crashing the list.
 */
export const deriveDashboardsList = (rows: ReadonlyArray<DashboardRow>): ReadonlyArray<Dashboard> => {
	// ISO timestamps order lexicographically; newest first, as the server lists do.
	const byIsoDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
	return [...rows]
		.sort((a, b) => byIsoDesc(a.updated_at, b.updated_at))
		.map(rowToDashboard)
		.filter((dashboard): dashboard is Dashboard => dashboard !== null)
}

/** Row-level combine body: phase handling, then {@link deriveDashboardsList}. */
const buildList = (rows: Db.CollectionState<DashboardRow>): DashboardsListData => {
	const message = collectionFailureMessage(rows)
	if (message !== null) {
		return { phase: "error", message }
	}
	if (!AsyncResult.isSuccess(rows)) {
		return { phase: "loading" }
	}
	return { phase: "ready", dashboards: deriveDashboardsList(rows.value) }
}

export class DashboardsListModel extends Model.Service<DashboardsListModel>()("maple/dashboards/list")({
	// Not the singleton default (keepAlive): the shape-stream subscription should
	// not stay live for the whole app session once the user leaves /dashboards.
	// The idle TTL keeps state warm across quick back-navigation, then drains
	// after the last View unmounts.
	lifetime: { idleTimeToLive: "5 minutes" },
	make: () =>
		Effect.gen(function* () {
			const orgKey = yield* makeOrgCollectionsKey
			const rows = yield* Db.fromCollectionByKey(orgKey, (key) => getOrgCollections(orgIdOf(key)).dashboards)

			const list = rows.pipe(Store.map(buildList))

			return {
				inputs: {},
				outputs: { list },
				ui: { list },
			}
		}),
}) {}
