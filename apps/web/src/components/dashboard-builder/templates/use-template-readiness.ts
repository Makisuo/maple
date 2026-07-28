import { useMemo } from "react"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import type { Metric } from "@/api/warehouse/metrics"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { listMetricsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

/**
 * The window `listMetrics` looks back over when no explicit range is passed.
 * Readiness is therefore "did this metric arrive recently", not "ever" — the
 * copy has to say so, or a source that last reported three days ago reads as
 * though it were never configured.
 */
export const READINESS_WINDOW_LABEL = "the last 24 h"

/** Metric names are capped by the request schema; a fuller list isn't available. */
const METRIC_LIMIT = 1000

export interface TemplateReadiness {
	/** False only when we positively know the org is missing the data. */
	readonly ready: boolean
	/** Row-sized status, e.g. `no kafka.*` or `not connected`. Null when ready. */
	readonly missingLabel: string | null
	/** The prefix the check ran against, for the detail panel's mono label. */
	readonly prefixLabel: string | null
	/** Distinct metric names matching the prefixes inside the window. */
	readonly metricCount: number
	/** Most recent `lastSeen` across the matching metrics, or null. */
	readonly lastSeen: string | null
}

/** `postgresql.` → `postgresql.*`. The "any metric" sentinel has no useful glob. */
const prefixLabel = (prefix: string): string | null => (prefix === "" ? null : `${prefix}*`)

const firstPrefixLabel = (prefixes: ReadonlyArray<string>): string | null =>
	prefixes.map(prefixLabel).find((value) => value !== null) ?? null

const READY: TemplateReadiness = {
	ready: true,
	missingLabel: null,
	prefixLabel: null,
	metricCount: 0,
	lastSeen: null,
}

/** The subset of a metric row readiness cares about. */
type MetricLike = Pick<Metric, "metricName" | "lastSeen">

/**
 * Readiness for every template in one pass over the org's metric names.
 *
 * Pass `metrics: null` for "we don't know yet" — loading or errored. Gating is
 * informative, never blocking, so an unknown answer reads as ready.
 */
export function computeTemplateReadiness<T extends MetricLike>(
	templates: ReadonlyArray<V2DashboardTemplate>,
	metrics: ReadonlyArray<T> | null,
): Map<string, TemplateReadiness> {
	const byId = new Map<string, TemplateReadiness>()
	if (metrics === null) {
		for (const template of templates) byId.set(template.id, READY)
		return byId
	}

	// Sorted once so each prefix is answered by a binary search to its first
	// possible match plus a walk over that prefix's own run, rather than a full
	// scan of the name list per template.
	const sorted = [...metrics].sort((a, b) => (a.metricName < b.metricName ? -1 : 1))

	const matches = (prefix: string): ReadonlyArray<T> => {
		if (prefix === "") return sorted
		let low = 0
		let high = sorted.length
		while (low < high) {
			const mid = (low + high) >>> 1
			if (sorted[mid]!.metricName < prefix) low = mid + 1
			else high = mid
		}
		const run: T[] = []
		for (let i = low; i < sorted.length && sorted[i]!.metricName.startsWith(prefix); i += 1) {
			run.push(sorted[i]!)
		}
		return run
	}

	for (const template of templates) {
		const prefixes = template.requiredMetricPrefixes
		if (prefixes.length === 0) {
			byId.set(template.id, READY)
			continue
		}

		const matched = prefixes.map(matches)
		// Every prefix must be present: a template that charts two receivers
		// renders half-empty if only one is reporting.
		const ready = matched.every((rows) => rows.length > 0)
		const flat = matched.flat()

		byId.set(template.id, {
			ready,
			missingLabel: ready
				? null
				: (template.requirement?.missing ?? `no ${firstPrefixLabel(prefixes) ?? "data"}`),
			prefixLabel: firstPrefixLabel(prefixes),
			metricCount: new Set(flat.map((metric) => metric.metricName)).size,
			lastSeen: flat.reduce<string | null>(
				(latest, metric) => (latest === null || metric.lastSeen > latest ? metric.lastSeen : latest),
				null,
			),
		})
	}

	return byId
}

/**
 * Readiness for every template, against the org's recent metric names.
 *
 * **Fail-open**: while the metric list is loading or errored, every template
 * reads as ready and `resolved` is false, so the UI can avoid claiming a
 * template needs setup when it simply doesn't know.
 */
export function useTemplateReadiness(templates: ReadonlyArray<V2DashboardTemplate>): {
	readonly byId: ReadonlyMap<string, TemplateReadiness>
	readonly resolved: boolean
} {
	const metricsResult = useAtomValue(listMetricsResultAtom({ data: { limit: METRIC_LIMIT } }))

	const metrics = useMemo(
		() =>
			Result.builder(metricsResult)
				.onSuccess((response) => response.data)
				.orElse(() => null),
		[metricsResult],
	)

	return useMemo(
		() => ({ byId: computeTemplateReadiness(templates, metrics), resolved: metrics !== null }),
		[templates, metrics],
	)
}
