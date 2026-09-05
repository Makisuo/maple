import type { IssueKind } from "@maple/domain/http"

import type { ErrorsSearchParams } from "@/routes/errors/index"

export const KIND_LABEL = {
	error: "Exceptions",
	alert: "Alert rules",
	integration: "Integrations",
} satisfies Record<IssueKind, string>

/** The search params the sidebar owns. Everything else on the route (view,
 *  sort, severity) lives in the toolbar and is not a "filter" in this sense. */
export type ErrorFilterSearch = Pick<ErrorsSearchParams, "service" | "env" | "kind" | "regressed">

export interface ErrorFilterChipDescriptor {
	param: keyof ErrorFilterSearch
	/** Matches the sidebar section title exactly. */
	label: string
	values: readonly string[]
}

/** The applied sidebar filters, in the sidebar's own order. */
export function errorFilterChips(search: ErrorFilterSearch): ErrorFilterChipDescriptor[] {
	const chips: ErrorFilterChipDescriptor[] = []
	if (search.service) chips.push({ param: "service", label: "Service", values: [search.service] })
	if (search.env) chips.push({ param: "env", label: "Environment", values: [search.env] })
	if (search.kind) chips.push({ param: "kind", label: "Source", values: [KIND_LABEL[search.kind]] })
	if (search.regressed) chips.push({ param: "regressed", label: "State", values: ["Regressed"] })
	return chips
}

export const hasErrorFilters = (search: ErrorFilterSearch): boolean => errorFilterChips(search).length > 0

/** Every sidebar param cleared, for "Clear filters" and the empty state. */
export const CLEARED_ERROR_FILTERS = {
	service: undefined,
	env: undefined,
	kind: undefined,
	regressed: undefined,
} satisfies Record<keyof ErrorFilterSearch, undefined>
