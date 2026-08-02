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

import { Model, Registry, Store } from "@maple/unitflow"
import * as Db from "@maple/unitflow/db"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

import type { Dashboard } from "@/components/dashboard-builder/types"
import { type DashboardRow, rowToDashboard } from "@/lib/collections/dashboards"
import {
	type DashboardsFallbackState,
	makeDashboardsFallbackStore,
	requestDashboardsFallback,
} from "@/lib/collections/dashboards-fallback"
import { getOrgCollections } from "@/lib/collections/org-collections"
import {
	collectionFailureMessage,
	makeOrgCollectionsKey,
	orgCollectionStuckOptions,
	orgIdOf,
} from "@/lib/models/org-collections-key"

/** The fully derived list — everything the route renders when ready. */
export interface DashboardsListReady {
	readonly phase: "ready"
	readonly dashboards: ReadonlyArray<Dashboard>
	/**
	 * True when the rows came from the plain-HTTP fallback rather than the shape
	 * stream: correct as of the fetch, but frozen, and writes are unavailable.
	 */
	readonly degraded: boolean
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

/**
 * Row-level combine body: phase handling, then {@link deriveDashboardsList}.
 *
 * Synced rows always win. The HTTP fallback only stands in once the shape stream
 * has failed, and once it has loaded it keeps standing in across heal attempts
 * (each of which re-enters `loading`) so the list a user is reading doesn't blink
 * back to a skeleton every 30 seconds.
 *
 * Exported for tests — the phase table is where the fallback's edge cases live.
 */
export const buildList = (
	rows: Db.CollectionState<DashboardRow>,
	fallback: DashboardsFallbackState,
): DashboardsListData => {
	if (AsyncResult.isSuccess(rows) && rows.value.length > 0) {
		return { phase: "ready", dashboards: deriveDashboardsList(rows.value), degraded: false }
	}
	if (fallback.status === "ready") {
		return { phase: "ready", dashboards: fallback.dashboards, degraded: true }
	}
	const message = collectionFailureMessage(rows)
	// `idle` with a failed collection is the single tick between the failure and
	// the fallback request it triggers — reporting an error there would flash one.
	if (fallback.status === "loading" || (message !== null && fallback.status === "idle")) {
		return { phase: "loading" }
	}
	if (message !== null) {
		return { phase: "error", message }
	}
	if (!AsyncResult.isSuccess(rows)) {
		return { phase: "loading" }
	}
	return { phase: "ready", dashboards: deriveDashboardsList(rows.value), degraded: false }
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
			const rows = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).dashboards,
				// Without this the page has no bounded load at all: an unreachable
				// sync endpoint leaves the collection in `loading` and the route
				// renders its skeleton forever.
				orgCollectionStuckOptions,
			)

			const fallback = yield* makeDashboardsFallbackStore
			// The moment live sync gives up, read the same rows over plain HTTP.
			// Dashboards aren't latency-critical to sync, so a frozen-but-correct
			// list beats an error page for data the API serves happily.
			yield* Registry.run(
				Store.stream(rows).pipe(
					Stream.mapEffect((state) =>
						AsyncResult.isFailure(state) ? Effect.sync(requestDashboardsFallback) : Effect.void,
					),
				),
			)

			const list = Store.combine([rows, fallback], buildList)

			return {
				inputs: {},
				outputs: { list },
				ui: { list },
			}
		}),
}) {}
