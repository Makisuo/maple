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
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { logFilterChips } from "@/lib/logs/log-filter-chips"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"

const logsSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	severities: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	deploymentEnvMatchMode: Schema.optional(Schema.Literals(["contains"])),
	namespaces: OptionalStringArrayParam,
	namespaceMatchMode: Schema.optional(Schema.Literals(["contains"])),
	excludedServices: OptionalStringArrayParam,
	excludedSeverities: OptionalStringArrayParam,
	excludedDeploymentEnvs: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	// Attribute keys pinned as columns in the logs stream. Shareable via URL.
	columns: OptionalStringArrayParam,
	search: Schema.optional(Schema.String),
	// Scopes the stream to one trace. Set by pasting a trace ID into the search
	// box or following "View Logs" from a trace; cleared via its chip.
	traceId: Schema.optional(Schema.String),
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
	const pinnedNamespace = useGlobalNamespace()

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

	const activeFilterChips = logFilterChips(search)
		// URL namespace filters are ignored while the org-global pin is on —
		// chips for them would suggest they still apply.
		.filter(
			(chip) =>
				pinnedNamespace === null ||
				(chip.param !== "namespaces" && chip.param !== "excludedNamespaces"),
		)
		.map((chip) => ({
			id: chip.param,
			label: chip.label,
			values: chip.values,
			negated: chip.negated,
			// The chip's tooltip still carries the full ID; the trace page itself
			// abbreviates to the same 8 characters.
			getValueLabel: chip.param === "traceId" ? (value: string) => value.slice(0, 8) : undefined,
			onRemove: () => navigate({ search: (prev) => ({ ...prev, [chip.param]: undefined }) }),
		}))

	const clearFacetFilters = () => {
		navigate({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(logFilterChips(prev).map((chip) => [chip.param, undefined])),
			}),
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
						{/* `Fill`, not `Scroll`: the logs stream is virtualized and owns its
						    own scroller, so an outer `overflow-auto` only adds a second
						    scrollbar for the wheel to chain into at the ends. */}
						<DashboardLayout.Fill>
							<div className="flex min-h-0 flex-1 flex-col p-4">
								<ActiveFilterChips chips={activeFilterChips} onClearAll={clearFacetFilters} />
								<LogsTable filters={search} />
							</div>
						</DashboardLayout.Fill>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
