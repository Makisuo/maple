/**
 * The errors-issues unit: issues + actors + open incidents (three
 * Electric-synced collections) combined into the server's list view — the
 * actor join, the open-incident membership, and the newest-seen-first order —
 * client-side. Replaces the `useErrorIssuesList` hook: the derivation
 * recomputes only when a source emits and lives outside the component tree.
 *
 * The URL-backed workflow/severity/kind filters stay in the route — they are
 * routing concerns — applied over the derived list via {@link filterIssues}.
 */

import type { ActorDocument, ErrorIssueDocument } from "@maple/domain/http"
import { Model, Store } from "@maple/unitflow"
import * as Db from "@maple/unitflow/db"
import { Reducer } from "@maple/unitflow/reducer"
import * as Effect from "effect/Effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

import {
	type ActorRow,
	type ErrorIncidentRow,
	type ErrorIssueRow,
	rowToActor,
	rowToIssue,
} from "@/lib/collections/errors"
import { getOrgCollections } from "@/lib/collections/org-collections"
import { initialIssueSelection, updateIssueSelection } from "@/lib/models/issue-selection"
import { collectionFailureMessage, makeOrgCollectionsKey, orgIdOf } from "@/lib/models/org-collections-key"

/** The server's page cap, mirrored client-side by {@link filterIssues}. */
export const ISSUES_PAGE_LIMIT = 100

/**
 * Filters the errors-issues list applies server-side. `severity` is either an
 * IssueSeverity value, the literal `"unset"` (NULL severity), or `undefined`
 * (any); mirrored client-side over the derived list.
 */
export interface ErrorIssuesFilters {
	readonly workflowState?: string
	readonly severity?: string
	readonly kind?: string
}

/** The fully derived issues list — everything the page renders. */
export interface ErrorIssuesReady {
	readonly phase: "ready"
	readonly issues: ReadonlyArray<ErrorIssueDocument>
}

/** The derived issues list, in the phases the page renders distinctly. */
export type ErrorIssuesData =
	| { readonly phase: "loading" }
	| { readonly phase: "error"; readonly message: string }
	| ErrorIssuesReady

export interface IssuesInputs {
	readonly issues: ReadonlyArray<ErrorIssueRow>
	readonly actors: ReadonlyArray<ActorRow>
	readonly openIncidentIssueIds: ReadonlySet<string>
}

/**
 * The whole list derivation as one pure function over synced rows —
 * unit-testable without React or a registry. Reproduces the server's joins:
 * assigned/lease-holder actors from the actor map, `hasOpenIncident` from the
 * open-incident membership, and the newest-seen-first order.
 */
export const deriveErrorIssues = (inputs: IssuesInputs): ReadonlyArray<ErrorIssueDocument> => {
	const actorMap = new Map<string, ActorDocument>()
	for (const row of inputs.actors) {
		actorMap.set(row.id, rowToActor(row))
	}
	return [...inputs.issues]
		// Mirror the server order: most recently seen first.
		.sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : a.last_seen_at > b.last_seen_at ? -1 : 0))
		.map((row) => rowToIssue(row, inputs.openIncidentIssueIds.has(row.id), actorMap))
}

/**
 * Client-side mirror of the server's WHERE clause + page cap over the derived
 * (already sorted) list. `error_issues` is archived-filtered server-side
 * (archived_at IS NULL), so no archived check here.
 */
export const filterIssues = (
	issues: ReadonlyArray<ErrorIssueDocument>,
	filters: ErrorIssuesFilters,
): ReadonlyArray<ErrorIssueDocument> =>
	issues
		.filter((issue) => {
			if (filters.workflowState && issue.workflowState !== filters.workflowState) return false
			if (filters.severity === "unset") {
				if (issue.severity != null) return false
			} else if (filters.severity && issue.severity !== filters.severity) {
				return false
			}
			if (filters.kind && issue.kind !== filters.kind) return false
			return true
		})
		.slice(0, ISSUES_PAGE_LIMIT)

interface IssuesSources {
	readonly issues: Db.CollectionState<ErrorIssueRow>
	readonly actors: Db.CollectionState<ActorRow>
	readonly openIncidents: Db.CollectionState<ErrorIncidentRow>
}

/** Row-level combine body: phase handling + row→document, then {@link deriveErrorIssues}. */
const buildIssues = (sources: IssuesSources): ErrorIssuesData => {
	// Only the issues collection gates the page — for BOTH error and loading.
	// Actors and open incidents are secondary joins that degrade to [] while
	// they stream in (and if they fail), exactly like the hook did: a failing
	// secondary shape must not blank an otherwise-usable list.
	const message = collectionFailureMessage(sources.issues)
	if (message !== null) {
		return { phase: "error", message }
	}
	if (!AsyncResult.isSuccess(sources.issues)) {
		return { phase: "loading" }
	}

	const actorRows = AsyncResult.isSuccess(sources.actors) ? sources.actors.value : []
	const incidentRows = AsyncResult.isSuccess(sources.openIncidents) ? sources.openIncidents.value : []
	// An issue has an open incident when the open_error_incidents shape (server
	// filters status='open') carries a row for its id.
	const openIncidentIssueIds = new Set<string>()
	for (const row of incidentRows) openIncidentIssueIds.add(row.issue_id)

	return {
		phase: "ready",
		issues: deriveErrorIssues({
			issues: sources.issues.value,
			actors: actorRows,
			openIncidentIssueIds,
		}),
	}
}

export class ErrorIssuesModel extends Model.Service<ErrorIssuesModel>()("maple/errors/issues")({
	// Not the singleton default (keepAlive): the instance's 3 shape-stream
	// subscriptions should not stay live for the whole app session once the
	// user leaves /errors/issues. The idle TTL keeps state warm across quick
	// back-navigation, then drains everything after the last View unmounts.
	lifetime: { idleTimeToLive: "5 minutes" },
	make: () =>
		Effect.gen(function* () {
			const orgKey = yield* makeOrgCollectionsKey
			const issues = yield* Db.fromCollectionByKey(orgKey, (key) => getOrgCollections(orgIdOf(key)).errorIssues)
			const actors = yield* Db.fromCollectionByKey(orgKey, (key) => getOrgCollections(orgIdOf(key)).actors)
			const openIncidents = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).openErrorIncidents,
			)

			const overview = Store.combine([issues, actors, openIncidents], (issuesState, actorsState, incidentsState) =>
				buildIssues({ issues: issuesState, actors: actorsState, openIncidents: incidentsState }),
			)

			// Row selection (multi-select + shift-range + clear) is model-owned
			// interactive state — a pure reducer instead of the route's old
			// useState/useRef tangle. The View drives it through `dispatchSelection`
			// and reads `selection`; see @/lib/models/issue-selection.
			const selection = yield* Reducer.make({
				initial: initialIssueSelection,
				update: updateIssueSelection,
				name: "maple/errors/issues.selection",
			})

			return {
				inputs: { dispatchSelection: selection.dispatch },
				outputs: { overview },
				ui: { overview, selection: selection.state, dispatchSelection: selection.dispatch },
			}
		}),
}) {}
