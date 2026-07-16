/**
 * The issues-list selection state as a pure unitflow reducer — the first real
 * adoption of `@maple/unitflow/reducer`. Multi-select with shift-range and a
 * clear action is exactly the "complex interactive local state" a reducer is
 * for: every transition flows through one exhaustive `update`, so the
 * shift-anchor logic (the fiddly part) is testable as plain data instead of
 * living in a `useState` + `useRef` + imperative-handler tangle in the route.
 *
 * The reducer lives here (not in `error-issues-model.ts`) so the pure logic is
 * importable without the model's Electric-collection dependencies. The model
 * (`ErrorIssuesModel`) wraps it in `Reducer.make` and republishes it through
 * `ui`; the URL-backed workflow/severity filters stay in the route.
 */

import { Command, type Reducer } from "@maple/unitflow/reducer"

export interface IssueSelectionState {
	readonly selectedIds: ReadonlySet<string>
	/** The last singly-toggled row — the origin of a shift-range select. */
	readonly anchor: string | null
}

export type IssueSelectionMsg =
	| {
			readonly _tag: "Toggled"
			readonly id: string
			readonly shiftKey: boolean
			/** The visible rows in display order, for resolving a shift-range. */
			readonly orderedIds: ReadonlyArray<string>
	  }
	| { readonly _tag: "Cleared" }

export const initialIssueSelection: IssueSelectionState = { selectedIds: new Set(), anchor: null }

/** Convenience constructors for the route to dispatch. */
export const toggledSelection = (
	id: string,
	shiftKey: boolean,
	orderedIds: ReadonlyArray<string>,
): IssueSelectionMsg => ({ _tag: "Toggled", id, shiftKey, orderedIds })

export const clearedSelection: IssueSelectionMsg = { _tag: "Cleared" }

/**
 * The whole selection state machine. Mirrors the route's previous imperative
 * handler exactly: a shift+anchor toggle adds the inclusive range (leaving the
 * anchor put); any other toggle flips the single row and becomes the new
 * anchor; clear resets both.
 */
export const updateIssueSelection: Reducer.Update<IssueSelectionState, IssueSelectionMsg> = (state, msg) => {
	switch (msg._tag) {
		case "Cleared":
			return [initialIssueSelection, Command.none]
		case "Toggled": {
			const next = new Set(state.selectedIds)
			if (msg.shiftKey && state.anchor !== null) {
				const from = msg.orderedIds.indexOf(state.anchor)
				const to = msg.orderedIds.indexOf(msg.id)
				if (from !== -1 && to !== -1) {
					const [lo, hi] = from < to ? [from, to] : [to, from]
					for (let i = lo; i <= hi; i++) {
						const id = msg.orderedIds[i]
						if (id !== undefined) next.add(id)
					}
					// A range select extends from the anchor; the anchor stays put.
					return [{ selectedIds: next, anchor: state.anchor }, Command.none]
				}
			}
			if (next.has(msg.id)) next.delete(msg.id)
			else next.add(msg.id)
			return [{ selectedIds: next, anchor: msg.id }, Command.none]
		}
	}
}
