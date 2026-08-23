import {
	FUNNEL_POPULATION_FILTER_FIELDS,
	type FunnelPopulationFilterField,
	type FunnelPopulationFilters,
	type FunnelStep,
} from "@maple/query-model"
import { splitWhereClause } from "@maple/domain/where-clause"

// The funnel panel's where-clause strings and what they compile to.
//
// Two clauses, one grammar: `key = "value" AND key2 = "value2"`. A step filter
// narrows an event step to rows whose `Attributes[key] = value`
// (`FunnelEventStep.attributeEquals`); the population filter narrows the whole
// funnel to persons with a session matching `session_replays` dimensions
// (`display.funnel.filters`). Only `=` and `AND` exist because that is all the
// funnel query can express — an operator the query cannot run is an error here,
// not a silent drop.
//
// NOT `parseWhereClause` from `@maple/domain/where-clause` for the step filter:
// it lowercases every key, and attribute keys are the customer's own vocabulary
// (`planTier`, `Source`). The population keys are a fixed vocabulary and are
// lowercased deliberately.

/** One `key = value` clause; `value` has its quotes stripped. */
interface EqualsClause {
	readonly key: string
	readonly value: string
}

export type FunnelFilterParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

// `key = "quoted"`, `key = 'quoted'`, or `key = bare` (no spaces). The key
// takes anything but whitespace and operator characters, so a dotted or
// dashed attribute key passes untouched.
const EQUALS_CLAUSE = /^([^\s=!<>~]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/

/** Split a clause string into `key = value` pairs, or say why it cannot. */
function parseEqualsClauses(text: string): FunnelFilterParse<ReadonlyArray<EqualsClause>> {
	const trimmed = text.trim()
	if (trimmed === "") return { ok: true, value: [] }
	if (/\bOR\b/i.test(trimmed)) return { ok: false, error: 'only "AND" joins clauses here' }
	const clauses: EqualsClause[] = []
	for (const part of splitWhereClause(trimmed)) {
		const match = EQUALS_CLAUSE.exec(part)
		if (!match) {
			return {
				ok: false,
				error: /[!<>~]=?|\b(contains|exists)\b/i.test(part)
					? `"${part}": only "=" is supported`
					: `"${part}" is not a key = "value" clause`,
			}
		}
		const key = match[1]!
		const value = match[2] ?? match[3] ?? match[4] ?? ""
		if (value === "") return { ok: false, error: `"${key}" needs a value` }
		if (clauses.some((clause) => clause.key === key)) {
			return { ok: false, error: `"${key}" appears twice` }
		}
		clauses.push({ key, value })
	}
	return { ok: true, value: clauses }
}

/** Quote a value the way the editor prints one. */
const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`

// Step filters → `attributeEquals`

/**
 * `plan = "pro" AND source = "cli"` → `{ plan: "pro", source: "cli" }`. Keys
 * keep their case; an optional `attr.` prefix (muscle memory from the trace
 * where-clause) is stripped. Blank text is no filter.
 */
export function parseFunnelStepFilter(text: string): FunnelFilterParse<Record<string, string>> {
	const parsed = parseEqualsClauses(text)
	if (!parsed.ok) return parsed
	const attributeEquals: Record<string, string> = {}
	for (const clause of parsed.value) {
		const key = clause.key.startsWith("attr.") ? clause.key.slice("attr.".length) : clause.key
		if (key === "") return { ok: false, error: `"${clause.key}" is not an attribute key` }
		if (key in attributeEquals) return { ok: false, error: `"${key}" appears twice` }
		attributeEquals[key] = clause.value
	}
	return { ok: true, value: attributeEquals }
}

/** The canonical text for a stored `attributeEquals` — what the editor shows on open. */
export function formatFunnelStepFilter(attributeEquals: Readonly<Record<string, string>> | undefined): string {
	if (!attributeEquals) return ""
	return Object.entries(attributeEquals)
		.map(([key, value]) => `${key} = ${quote(value)}`)
		.join(" AND ")
}

/**
 * A step as the editor holds it: the wire step plus the raw filter text an
 * event step is being typed with. Assignable to `FunnelStep` (the extra key
 * is optional), so the /analytics view's plain steps flow through unchanged.
 */
export type FunnelStepDraft = FunnelStep & { readonly filterClause?: string }

/** The wire step back into a draft, with its filter spelled out. */
export function draftFromFunnelStep(step: FunnelStep): FunnelStepDraft {
	if (step.kind !== "event") return step
	const filterClause = formatFunnelStepFilter(step.attributeEquals)
	return filterClause === "" ? { kind: "event", eventName: step.eventName } : { ...step, filterClause }
}

/** One draft → the wire step, or why its filter does not compile. */
export function compileFunnelStep(draft: FunnelStepDraft): FunnelFilterParse<FunnelStep> {
	switch (draft.kind) {
		case "event": {
			const { filterClause, attributeEquals: _stored, ...rest } = draft
			const parsed = parseFunnelStepFilter(filterClause ?? "")
			if (!parsed.ok) return parsed
			return {
				ok: true,
				value:
					Object.keys(parsed.value).length > 0
						? { kind: "event", eventName: rest.eventName, attributeEquals: parsed.value }
						: { kind: "event", eventName: rest.eventName },
			}
		}
		case "page": {
			const host = draft.host?.trim()
			return {
				ok: true,
				value: host ? { kind: "page", pagePath: draft.pagePath, host } : { kind: "page", pagePath: draft.pagePath },
			}
		}
		case "session":
			return { ok: true, value: draft }
	}
}

/** Every draft → wire steps, or the first step whose filter does not compile. */
export function compileFunnelSteps(drafts: ReadonlyArray<FunnelStepDraft>): FunnelFilterParse<ReadonlyArray<FunnelStep>> {
	const steps: FunnelStep[] = []
	for (const [index, draft] of drafts.entries()) {
		const compiled = compileFunnelStep(draft)
		if (!compiled.ok) return { ok: false, error: `Step ${index + 1}: ${compiled.error}` }
		steps.push(compiled.value)
	}
	return { ok: true, value: steps }
}

// Population filter ↔ `display.funnel.filters`

/**
 * The where-clause spelling of each population filter field, first entry
 * canonical. Short aliases are accepted on input; the canonical key is what
 * autocomplete offers and what the editor prints.
 */
export const PRODUCT_EVENTS_FILTER_KEYS = {
	host: ["host"],
	pagePath: ["page.path", "path"],
	referrerHost: ["referrer", "referrer.host"],
	country: ["country"],
	deviceType: ["device", "device.type"],
	browserName: ["browser", "browser.name"],
	osName: ["os", "os.name"],
	language: ["language"],
	utmSource: ["utm.source", "utm_source"],
	utmMedium: ["utm.medium", "utm_medium"],
	utmCampaign: ["utm.campaign", "utm_campaign"],
	visitorType: ["visitor_type", "visitor.type"],
} satisfies Readonly<Record<FunnelPopulationFilterField, ReadonlyArray<string>>>

/** The canonical where-clause key of a filter field. */
export const productEventsFilterKey = (field: FunnelPopulationFilterField): string =>
	PRODUCT_EVENTS_FILTER_KEYS[field][0]!

const FIELD_BY_KEY: ReadonlyMap<string, FunnelPopulationFilterField> = new Map(
	FUNNEL_POPULATION_FILTER_FIELDS.flatMap((field) =>
		PRODUCT_EVENTS_FILTER_KEYS[field].map((key) => [key, field] as const),
	),
)

/** The filter field a where-clause key (or alias) names, if any. Case-insensitive. */
export const productEventsFilterField = (key: string): FunnelPopulationFilterField | undefined =>
	FIELD_BY_KEY.get(key.trim().toLowerCase())

const VISITOR_TYPES = ["new", "returning"] as const

/**
 * `country = "DE" AND utm.source = "twitter"` → `{ country: "DE", utmSource: "twitter" }`.
 * Unknown keys are an error that names the vocabulary; `visitor_type` must be
 * `new` or `returning`.
 */
export function parseProductEventsFilterClause(text: string): FunnelFilterParse<FunnelPopulationFilters> {
	const parsed = parseEqualsClauses(text)
	if (!parsed.ok) return parsed
	const filters: Partial<Record<FunnelPopulationFilterField, string>> = {}
	for (const clause of parsed.value) {
		const field = productEventsFilterField(clause.key)
		if (field === undefined) {
			const known = FUNNEL_POPULATION_FILTER_FIELDS.map(productEventsFilterKey).join(", ")
			return { ok: false, error: `"${clause.key}" is not a filter key — use one of ${known}` }
		}
		if (field in filters) return { ok: false, error: `"${productEventsFilterKey(field)}" appears twice` }
		filters[field] = clause.value
	}
	const visitorType = filters.visitorType
	if (visitorType !== undefined && !VISITOR_TYPES.includes(visitorType as (typeof VISITOR_TYPES)[number])) {
		return { ok: false, error: `visitor_type is "new" or "returning"` }
	}
	const { visitorType: _visitorType, ...rest } = filters
	return {
		ok: true,
		value: {
			...rest,
			...(visitorType === "new" || visitorType === "returning" ? { visitorType } : undefined),
		},
	}
}

/** The canonical text for stored filters — what the editor shows on open. */
export function formatProductEventsFilterClause(filters: FunnelPopulationFilters | undefined): string {
	if (!filters) return ""
	return FUNNEL_POPULATION_FILTER_FIELDS.flatMap((field) => {
		const value = filters[field]
		return value === undefined || value === "" ? [] : [`${productEventsFilterKey(field)} = ${quote(value)}`]
	}).join(" AND ")
}

/** True when a filters object narrows anything. */
export const hasProductEventsFilters = (filters: FunnelPopulationFilters | undefined): boolean =>
	filters !== undefined && FUNNEL_POPULATION_FILTER_FIELDS.some((field) => filters[field] !== undefined && filters[field] !== "")
