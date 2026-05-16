// ---------------------------------------------------------------------------
// One-shot data migration for stored dashboards.
//
// Reshapes a persisted dashboard JSON document to the current widget shape:
//   - query drafts inside `dataSource.params.queries` become source-discriminated
//     — traces/logs queries drop the metric-only fields they never used;
//   - the unused top-level `variables` field is removed.
//
// Operates on plain JSON (`unknown`), never on decoded class instances, because
// it runs before the strict schema can decode legacy data. It is idempotent:
// running it on an already-current document returns an equivalent document.
// ---------------------------------------------------------------------------

const METRIC_ONLY_QUERY_FIELDS = ["metricName", "metricType", "isMonotonic", "signalSource"] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reshapeQueryDraft(query: unknown): unknown {
	if (!isPlainObject(query)) return query
	const source = query.dataSource

	if (source === "metrics") {
		return { ...query, metricType: query.metricType ?? "gauge" }
	}

	if (source === "traces" || source === "logs") {
		const next: Record<string, unknown> = { ...query }
		for (const field of METRIC_ONLY_QUERY_FIELDS) delete next[field]
		return next
	}

	return query
}

function reshapeDataSource(dataSource: unknown): unknown {
	if (!isPlainObject(dataSource)) return dataSource
	const params = dataSource.params
	if (!isPlainObject(params) || !Array.isArray(params.queries)) return dataSource

	return {
		...dataSource,
		params: { ...params, queries: params.queries.map(reshapeQueryDraft) },
	}
}

function reshapeWidget(widget: unknown): unknown {
	if (!isPlainObject(widget)) return widget

	const next: Record<string, unknown> = {
		...widget,
		dataSource: reshapeDataSource(widget.dataSource),
	}

	// Sparklines embed a second WidgetDataSource inside the display config.
	const display = widget.display
	if (isPlainObject(display) && isPlainObject(display.sparkline) && "dataSource" in display.sparkline) {
		next.display = {
			...display,
			sparkline: {
				...display.sparkline,
				dataSource: reshapeDataSource(display.sparkline.dataSource),
			},
		}
	}

	return next
}

export function reshapeDashboardDocumentV2(doc: unknown): unknown {
	if (!isPlainObject(doc)) return doc

	const next: Record<string, unknown> = { ...doc }
	delete next.variables

	if (Array.isArray(next.widgets)) {
		next.widgets = next.widgets.map(reshapeWidget)
	}

	return next
}
