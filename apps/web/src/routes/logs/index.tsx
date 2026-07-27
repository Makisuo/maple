import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LogsTable } from "@/components/logs/logs-table"
import { LogsVolumeChart } from "@/components/logs/logs-volume-chart"
import { LogsFilterSidebar } from "@/components/logs/logs-filter-sidebar"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const logsSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	severities: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	deploymentEnvMatchMode: Schema.optional(Schema.Literals(["contains"])),
	namespaces: OptionalStringArrayParam,
	namespaceMatchMode: Schema.optional(Schema.Literals(["contains"])),
	// Attribute keys pinned as columns in the logs stream. Shareable via URL.
	columns: OptionalStringArrayParam,
	search: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export type LogsSearchParams = Schema.Schema.Type<typeof logsSearchSchema>

export const Route = createFileRoute("/logs/")({
	component: LogsPage,
	validateSearch: Schema.toStandardSchemaV1(logsSearchSchema),
})

function LogsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const handleTimeChange = (
		range: {
			startTime?: string
			endTime?: string
			presetValue?: string
		},
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Logs" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<LogsFilterSidebar />
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Logs">
								<TimeRangeHeaderControls
									startTime={search.startTime}
									endTime={search.endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
							<LogsVolumeChart
								filters={search}
								onTimeRangeSelect={(range) =>
									handleTimeChange(
										{ startTime: range.startTime, endTime: range.endTime },
										{ replace: true },
									)
								}
							/>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<LogsTable filters={search} />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
