import { WIDGET_TYPES } from "@maple/domain/http"

import { GridIcon } from "@/components/icons"
import { WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { tablePresets } from "@/components/dashboard-builder/widgets/widget-definitions"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { rowsPresetPreview } from "@/components/dashboard-builder/widgets/types/preset-preview"
import {
	hasActiveGroupBy,
	inferDisplayUnitForQuery,
	isVisibleQuery,
	parsePositiveNumber,
} from "@/lib/query-builder/widget-builder-shared"

/**
 * Rows from the query builder. A grouped table is a breakdown (one row per
 * group); an ungrouped one is the raw timeseries, capped by the row limit.
 */
export const tableWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.table,
	icon: GridIcon,
	Renderer: TableWidget,
	queryEditor: "builder",
	ConfigPanel: () => (
		<>
			<WidgetSettings.RowLimit />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: tablePresets,
	PresetPreview: rowsPresetPreview({
		"table-traces": [
			{ serviceName: "api-gw", spanName: "GET /api/users", durationMs: 142, hasError: false },
			{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, hasError: true },
			{ serviceName: "api-gw", spanName: "GET /api/health", durationMs: 3, hasError: false },
		],
		"table-errors": [
			{ errorType: "ConnectionTimeout", count: 342, affectedServicesCount: 5 },
			{ errorType: "NullPointerException", count: 128, affectedServicesCount: 3 },
			{ errorType: "RateLimitExceeded", count: 87, affectedServicesCount: 2 },
		],
		"table-services": [
			{ serviceName: "api-gateway", p95LatencyMs: 245, errorRate: 2.1, throughput: 1250 },
			{ serviceName: "user-service", p95LatencyMs: 89, errorRate: 0.4, throughput: 830 },
			{ serviceName: "order-service", p95LatencyMs: 412, errorRate: 5.2, throughput: 340 },
		],
	}),

	initialState: (widget) => ({
		tableLimit:
			typeof widget.dataSource.transform?.limit === "number"
				? String(widget.dataSource.transform.limit)
				: "",
	}),

	buildDataSource: ({ base, state, sharedTransform, visibleQueries }) => {
		const limit = parsePositiveNumber(state.tableLimit)

		if (visibleQueries.some(hasActiveGroupBy)) {
			return {
				endpoint: "custom_query_builder_breakdown",
				params: { queries: visibleQueries },
				transform: limit ? { limit } : undefined,
			}
		}

		if (!limit) return base
		return { ...base, transform: { ...sharedTransform, limit } }
	},

	buildDisplay: ({ base, state }) => {
		// A grouped table renders `{name, value}` rows, so its columns are derived
		// from the group-by rather than configured. Ungrouped tables let the
		// renderer infer columns from the rows.
		const groupByQuery = state.queries.find((query) => isVisibleQuery(query) && hasActiveGroupBy(query))
		if (!groupByQuery) return extendDisplay(base, { columns: undefined })

		const groupLabel =
			groupByQuery.groupBy.find((g) => g.trim() && g.trim().toLowerCase() !== "none") ?? "name"
		return extendDisplay(base, {
			columns: [
				{ field: "name", header: groupLabel, align: "left" },
				{
					field: "value",
					header: groupByQuery.aggregation ?? "value",
					unit: inferDisplayUnitForQuery(groupByQuery) ?? "number",
					align: "right",
				},
			],
		})
	},
}
