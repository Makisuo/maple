import { defineRegistry } from "@json-render/react"
import { catalog } from "./catalog"
import { TraceList } from "./components/trace-list"
import { LogList } from "./components/log-list"
import { ServiceTable } from "./components/service-table"
import { ErrorList } from "./components/error-list"
import { SpanTree } from "./components/span-tree"
import { SystemHealthCard } from "./components/system-health-card"
import { MetricsList } from "./components/metrics-list"
import { StatCards } from "./components/stat-cards"
import { DataTable } from "./components/data-table"
import { QueryChart } from "./components/query-chart"

export const { registry } = defineRegistry(catalog, {
	components: {
		Stack: ({ props, children }) => (
			<div className="space-y-2" style={props.gap ? { gap: `${props.gap * 4}px` } : undefined}>
				{children}
			</div>
		),
		TraceList,
		LogList,
		ServiceTable,
		ErrorList,
		SpanTree,
		SystemHealthCard,
		MetricsList,
		StatCards,
		DataTable,
		QueryChart,
	},
})
