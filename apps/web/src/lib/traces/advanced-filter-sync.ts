import {
	normalizeKey,
	parseBoolean,
	parseNumber,
	parseWhereClause as parseWhereClauses,
} from "@maple/query-engine/where-clause"
import { Match } from "effect"

export interface AttributeFilterEntry {
	key: string
	value: string
	matchMode?: FilterMatchMode
	negated?: boolean
}

export interface TracesSearchLike {
	services?: string[]
	spanNames?: string[]
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethods?: string[]
	httpStatusCodes?: string[]
	deploymentEnvs?: string[]
	startTime?: string
	endTime?: string
	rootOnly?: boolean
	whereClause?: string
	attributeFilters?: readonly AttributeFilterEntry[]
	resourceAttributeFilters?: readonly AttributeFilterEntry[]
	serviceMatchMode?: FilterMatchMode
	spanNameMatchMode?: FilterMatchMode
	deploymentEnvMatchMode?: FilterMatchMode
	excludedServices?: string[]
	excludedSpanNames?: string[]
	excludedDeploymentEnvs?: string[]
	excludedHttpMethods?: string[]
	excludedHttpStatusCodes?: string[]
}

export type FilterMatchMode = "contains"

export interface ParsedWhereClauseFilters {
	service?: string
	spanName?: string
	deploymentEnv?: string
	httpMethod?: string
	httpStatusCode?: string
	hasError?: true
	rootOnly?: false
	minDurationMs?: number
	maxDurationMs?: number
	attributeFilters: AttributeFilterEntry[]
	resourceAttributeFilters: AttributeFilterEntry[]
	matchModes?: Partial<Record<string, FilterMatchMode>>
	excludedServices?: string[]
	excludedSpanNames?: string[]
	excludedDeploymentEnvs?: string[]
	excludedHttpMethods?: string[]
	excludedHttpStatusCodes?: string[]
}

function quoteValue(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\\"')}"`
}

export function parseWhereClause(whereClause: string | undefined): {
	filters: ParsedWhereClauseFilters
	hasIncompleteClauses: boolean
} {
	if (!whereClause || !whereClause.trim()) {
		return {
			filters: { attributeFilters: [], resourceAttributeFilters: [] },
			hasIncompleteClauses: false,
		}
	}

	const { clauses, warnings } = parseWhereClauses(whereClause.trim())

	let parsed: ParsedWhereClauseFilters = { attributeFilters: [], resourceAttributeFilters: [] }
	let hasIncompleteClauses = warnings.length > 0

	for (const clause of clauses) {
		const key = normalizeKey(clause.key)
		const isContains = clause.operator === "contains" || clause.operator === "!contains"
		const isExists = clause.operator === "exists" || clause.operator === "!exists"
		const isNegated =
			clause.operator === "!=" || clause.operator === "!contains" || clause.operator === "!exists"

		function setMatchMode(modeKey: string) {
			if (isContains) {
				parsed.matchModes ??= {}
				parsed.matchModes[modeKey] = "contains"
			}
		}

		// Handle attr.* and resource.* prefixes before Match
		if (key.startsWith("attr.")) {
			const attributeKey = key.slice(5).trim()
			if (!attributeKey || parsed.attributeFilters.length >= 5) continue
			parsed.attributeFilters.push({
				key: attributeKey,
				value: clause.value,
				matchMode: isContains ? "contains" : undefined,
				negated: isNegated || undefined,
			})
			continue
		}

		if (key.startsWith("resource.")) {
			const resourceKey = key.slice(9).trim()
			if (!resourceKey || parsed.resourceAttributeFilters.length >= 5) continue
			parsed.resourceAttributeFilters.push({
				key: resourceKey,
				value: clause.value,
				matchMode: isContains ? "contains" : undefined,
				negated: isNegated || undefined,
			})
			continue
		}

		// `exists` / `!exists` are only meaningful on attr.* / resource.* keys.
		// On named fields they're not currently supported — skip to avoid silently
		// dropping the value into a positive match.
		if (isExists) {
			hasIncompleteClauses = true
			continue
		}

		parsed = Match.value(key).pipe(
			Match.when("service.name", () => {
				if (isNegated) {
					const current = parsed.excludedServices ?? []
					return { ...parsed, excludedServices: [...current, clause.value] }
				}
				setMatchMode("service")
				return { ...parsed, service: clause.value }
			}),
			Match.when("span.name", () => {
				if (isNegated) {
					const current = parsed.excludedSpanNames ?? []
					return { ...parsed, excludedSpanNames: [...current, clause.value] }
				}
				setMatchMode("spanName")
				return { ...parsed, spanName: clause.value }
			}),
			Match.when("deployment.environment", () => {
				if (isNegated) {
					const current = parsed.excludedDeploymentEnvs ?? []
					return { ...parsed, excludedDeploymentEnvs: [...current, clause.value] }
				}
				setMatchMode("deploymentEnv")
				return { ...parsed, deploymentEnv: clause.value }
			}),
			Match.when("http.method", () => {
				if (isNegated) {
					const current = parsed.excludedHttpMethods ?? []
					return { ...parsed, excludedHttpMethods: [...current, clause.value] }
				}
				setMatchMode("httpMethod")
				return { ...parsed, httpMethod: clause.value }
			}),
			Match.when("http.status_code", () => {
				if (isNegated) {
					const current = parsed.excludedHttpStatusCodes ?? []
					return { ...parsed, excludedHttpStatusCodes: [...current, clause.value] }
				}
				setMatchMode("httpStatusCode")
				return { ...parsed, httpStatusCode: clause.value }
			}),
			Match.when("has_error", () => {
				const boolValue = parseBoolean(clause.value)
				if (boolValue === null) {
					hasIncompleteClauses = true
					return parsed
				}
				return { ...parsed, hasError: boolValue === true ? (true as const) : undefined }
			}),
			Match.when("root_only", () => {
				const boolValue = parseBoolean(clause.value)
				if (boolValue === null) {
					hasIncompleteClauses = true
					return parsed
				}
				return { ...parsed, rootOnly: boolValue === false ? (false as const) : undefined }
			}),
			Match.when("min_duration_ms", () => {
				const numeric = parseNumber(clause.value)
				if (numeric === null) {
					hasIncompleteClauses = true
					return parsed
				}
				return { ...parsed, minDurationMs: numeric }
			}),
			Match.when("max_duration_ms", () => {
				const numeric = parseNumber(clause.value)
				if (numeric === null) {
					hasIncompleteClauses = true
					return parsed
				}
				return { ...parsed, maxDurationMs: numeric }
			}),
			Match.orElse(() => parsed),
		)
	}

	return {
		filters: parsed,
		hasIncompleteClauses,
	}
}

export function toWhereClause(filters: ParsedWhereClauseFilters): string | undefined {
	const clauses: string[] = []
	const modes = filters.matchModes ?? {}

	function op(key: string): string {
		return modes[key] === "contains" ? "contains" : "="
	}

	if (filters.service) {
		clauses.push(`service.name ${op("service")} ${quoteValue(filters.service)}`)
	}

	if (filters.spanName) {
		clauses.push(`span.name ${op("spanName")} ${quoteValue(filters.spanName)}`)
	}

	if (filters.deploymentEnv) {
		clauses.push(`deployment.environment ${op("deploymentEnv")} ${quoteValue(filters.deploymentEnv)}`)
	}

	if (filters.httpMethod) {
		clauses.push(`http.method ${op("httpMethod")} ${quoteValue(filters.httpMethod)}`)
	}

	if (filters.httpStatusCode) {
		clauses.push(`http.status_code ${op("httpStatusCode")} ${quoteValue(filters.httpStatusCode)}`)
	}

	if (filters.hasError === true) {
		clauses.push("has_error = true")
	}

	if (filters.rootOnly === false) {
		clauses.push("root_only = false")
	}

	if (typeof filters.minDurationMs === "number") {
		clauses.push(`min_duration_ms = ${String(filters.minDurationMs)}`)
	}

	if (typeof filters.maxDurationMs === "number") {
		clauses.push(`max_duration_ms = ${String(filters.maxDurationMs)}`)
	}

	for (const af of filters.attributeFilters) {
		const afOp =
			af.matchMode === "contains" ? (af.negated ? "!contains" : "contains") : af.negated ? "!=" : "="
		clauses.push(`attr.${af.key} ${afOp} ${quoteValue(af.value)}`)
	}

	for (const rf of filters.resourceAttributeFilters) {
		const rfOp =
			rf.matchMode === "contains" ? (rf.negated ? "!contains" : "contains") : rf.negated ? "!=" : "="
		clauses.push(`resource.${rf.key} ${rfOp} ${quoteValue(rf.value)}`)
	}

	for (const v of filters.excludedServices ?? []) {
		clauses.push(`service.name != ${quoteValue(v)}`)
	}
	for (const v of filters.excludedSpanNames ?? []) {
		clauses.push(`span.name != ${quoteValue(v)}`)
	}
	for (const v of filters.excludedDeploymentEnvs ?? []) {
		clauses.push(`deployment.environment != ${quoteValue(v)}`)
	}
	for (const v of filters.excludedHttpMethods ?? []) {
		clauses.push(`http.method != ${quoteValue(v)}`)
	}
	for (const v of filters.excludedHttpStatusCodes ?? []) {
		clauses.push(`http.status_code != ${quoteValue(v)}`)
	}

	if (clauses.length === 0) {
		return undefined
	}

	return clauses.join(" AND ")
}

/**
 * One-way transform: parses a where clause string and merges the parsed
 * filter values into the search params. Does NOT reverse-sync checkboxes
 * back into whereClause text.
 */
export function applyWhereClause(search: TracesSearchLike, whereClause: string): TracesSearchLike {
	const trimmed = whereClause.trim()

	if (!trimmed) {
		return {
			...search,
			whereClause: undefined,
			services: undefined,
			spanNames: undefined,
			hasError: undefined,
			minDurationMs: undefined,
			maxDurationMs: undefined,
			httpMethods: undefined,
			httpStatusCodes: undefined,
			deploymentEnvs: undefined,
			rootOnly: undefined,
			attributeFilters: undefined,
			resourceAttributeFilters: undefined,
			serviceMatchMode: undefined,
			spanNameMatchMode: undefined,
			deploymentEnvMatchMode: undefined,
			excludedServices: undefined,
			excludedSpanNames: undefined,
			excludedDeploymentEnvs: undefined,
			excludedHttpMethods: undefined,
			excludedHttpStatusCodes: undefined,
		}
	}

	const { filters } = parseWhereClause(trimmed)
	const modes = filters.matchModes ?? {}

	return {
		...search,
		whereClause: trimmed,
		services: filters.service ? [filters.service] : search.services,
		spanNames: filters.spanName ? [filters.spanName] : search.spanNames,
		hasError: filters.hasError ?? search.hasError,
		minDurationMs: filters.minDurationMs ?? search.minDurationMs,
		maxDurationMs: filters.maxDurationMs ?? search.maxDurationMs,
		httpMethods: filters.httpMethod ? [filters.httpMethod] : search.httpMethods,
		httpStatusCodes: filters.httpStatusCode ? [filters.httpStatusCode] : search.httpStatusCodes,
		deploymentEnvs: filters.deploymentEnv ? [filters.deploymentEnv] : search.deploymentEnvs,
		rootOnly: filters.rootOnly ?? search.rootOnly,
		attributeFilters:
			filters.attributeFilters.length > 0 ? filters.attributeFilters : search.attributeFilters,
		resourceAttributeFilters:
			filters.resourceAttributeFilters.length > 0
				? filters.resourceAttributeFilters
				: search.resourceAttributeFilters,
		serviceMatchMode: filters.service ? modes.service : search.serviceMatchMode,
		spanNameMatchMode: filters.spanName ? modes.spanName : search.spanNameMatchMode,
		deploymentEnvMatchMode: filters.deploymentEnv ? modes.deploymentEnv : search.deploymentEnvMatchMode,
		excludedServices: filters.excludedServices?.length ? filters.excludedServices : search.excludedServices,
		excludedSpanNames: filters.excludedSpanNames?.length
			? filters.excludedSpanNames
			: search.excludedSpanNames,
		excludedDeploymentEnvs: filters.excludedDeploymentEnvs?.length
			? filters.excludedDeploymentEnvs
			: search.excludedDeploymentEnvs,
		excludedHttpMethods: filters.excludedHttpMethods?.length
			? filters.excludedHttpMethods
			: search.excludedHttpMethods,
		excludedHttpStatusCodes: filters.excludedHttpStatusCodes?.length
			? filters.excludedHttpStatusCodes
			: search.excludedHttpStatusCodes,
	}
}
