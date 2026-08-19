import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * The issues list merged into `/errors`.
 *
 * They were always the same objects — the warehouse groups error events by
 * fingerprint hash, and `error_issues` is keyed on that same hash — so keeping
 * two lists meant neither could answer a triage question on its own. Existing
 * links and bookmarks land on the unified list with their filter carried over.
 *
 * `/errors/issues/$issueId` is untouched; the detail page is still the place
 * one fingerprint is worked.
 */
export const Route = createFileRoute("/errors/issues/")({
	beforeLoad: ({ search }) => {
		throw redirect({ to: "/errors", search: legacySearch(search), replace: true })
	},
})

type HubView = "open" | "triage" | "active" | "resolved" | "all"

/** The old list's `workflowState` tabs map onto the hub's views. A Map rather
 *  than an object because the incoming value is unvalidated search-param text. */
const VIEW_FOR_STATE = new Map<string, HubView>([
	["triage", "triage"],
	["regressed", "triage"],
	["todo", "active"],
	["in_progress", "active"],
	["in_review", "active"],
	["done", "resolved"],
	["cancelled", "resolved"],
	["wontfix", "resolved"],
	["all", "all"],
])

function legacySearch(search: Record<string, unknown>): Record<string, unknown> {
	const state = typeof search.workflowState === "string" ? search.workflowState : undefined
	const severity = typeof search.severity === "string" ? search.severity : undefined
	const view = state === undefined ? undefined : VIEW_FOR_STATE.get(state)
	return {
		// The hub defaults to Open, so that tab needs no param. An old link with
		// no `workflowState` had no opinion either, and Open is the closest thing
		// to what the unfiltered issues list used to show.
		...(view && view !== "open" ? { view } : undefined),
		...(severity && severity !== "all" ? { severity } : undefined),
		// The old list had no time range and showed all-time issues; 7d is the
		// closest honest default for a window-scoped list.
		timePreset: "7d",
	}
}
