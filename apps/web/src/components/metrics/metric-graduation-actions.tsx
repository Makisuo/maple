import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { BellIcon, CheckIcon, GridSquareCirclePlusIcon, LinkIcon } from "@/components/icons"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { encodeAlertChartToSearchParam } from "@/lib/alerts/widget-chart-param"
import type { WidgetDataSource } from "@/components/dashboard-builder/types"
import type { MetricsQueryDraft } from "@/lib/query-builder/model"

function buildWidgetDataSource(draft: MetricsQueryDraft): WidgetDataSource {
	return {
		endpoint: "custom_query_builder_timeseries",
		// A fresh query id: the explorer's stable atom-key id must not leak into
		// persisted widgets, where two adds would otherwise share one id.
		params: { queries: [{ ...draft, id: crypto.randomUUID() }] },
	}
}

interface MetricGraduationActionsProps {
	draft: MetricsQueryDraft
}

/**
 * The explorer is scratch space — these actions graduate the current query
 * into something durable: a dashboard widget, an alert rule, or a shared link.
 */
export function MetricGraduationActions({ draft }: MetricGraduationActionsProps) {
	const navigate = useNavigate()
	const [dialogOpen, setDialogOpen] = React.useState(false)
	const [copied, setCopied] = React.useState(false)

	const handleCreateAlert = () => {
		const chart = encodeAlertChartToSearchParam({
			dashboardId: "metrics-explorer",
			widget: {
				id: crypto.randomUUID(),
				visualization: "chart",
				dataSource: buildWidgetDataSource(draft),
				display: { title: draft.metricName },
			},
		})
		void navigate({ to: "/alerts/create", search: chart ? { chart } : {} })
	}

	const handleCopyLink = () => {
		void navigator.clipboard.writeText(window.location.href).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}

	return (
		<div className="flex items-center gap-2">
			<Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
				<GridSquareCirclePlusIcon size={14} />
				Add to dashboard
			</Button>
			<Button variant="outline" size="sm" onClick={handleCreateAlert}>
				<BellIcon size={14} />
				Create alert
			</Button>
			<Button variant="outline" size="sm" onClick={handleCopyLink}>
				{copied ? <CheckIcon size={14} /> : <LinkIcon size={14} />}
				{copied ? "Copied" : "Copy link"}
			</Button>

			<AddToDashboardDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				draft={draft}
			/>
		</div>
	)
}

function AddToDashboardDialog({
	open,
	onOpenChange,
	draft,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	draft: MetricsQueryDraft
}) {
	const navigate = useNavigate()
	const { dashboards, readOnly, addWidget, createDashboard } = useDashboardStore()
	const [newName, setNewName] = React.useState("")
	const [creating, setCreating] = React.useState(false)
	const [error, setError] = React.useState<string | null>(null)

	const addToDashboard = (dashboardId: string) => {
		try {
			addWidget(dashboardId, "chart", buildWidgetDataSource(draft), {
				title: draft.metricName,
				chartId: "query-builder-area",
			})
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to add widget")
			return
		}
		onOpenChange(false)
		void navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
		})
	}

	const handleCreate = async () => {
		const name = newName.trim()
		if (!name || creating) return
		setCreating(true)
		setError(null)
		try {
			const dashboard = await createDashboard(name)
			addToDashboard(dashboard.id)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to create dashboard")
		} finally {
			setCreating(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add to dashboard</DialogTitle>
					<DialogDescription>
						Adds the current query for{" "}
						<span className="font-mono">{draft.metricName}</span> as a chart widget.
					</DialogDescription>
				</DialogHeader>

				{readOnly ? (
					<p className="text-sm text-muted-foreground">
						Dashboards are read-only for your role.
					</p>
				) : (
					<div className="space-y-4">
						{dashboards.length > 0 && (
							<div className="max-h-64 space-y-1 overflow-y-auto">
								{dashboards.map((dashboard) => (
									<button
										key={dashboard.id}
										type="button"
										onClick={() => addToDashboard(dashboard.id)}
										className="flex w-full items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
									>
										<span className="truncate">{dashboard.name}</span>
										<span className="shrink-0 text-xs text-muted-foreground">
											{dashboard.widgets.length} widget
											{dashboard.widgets.length !== 1 ? "s" : ""}
										</span>
									</button>
								))}
							</div>
						)}

						<div className="flex items-center gap-2">
							<Input
								value={newName}
								onChange={(event) => setNewName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") void handleCreate()
								}}
								placeholder="New dashboard name..."
								className="h-8 flex-1 text-sm"
							/>
							<Button
								size="sm"
								onClick={() => void handleCreate()}
								disabled={!newName.trim() || creating}
							>
								{creating ? "Creating..." : "Create & add"}
							</Button>
						</div>

						{error && <p className="text-xs text-destructive">{error}</p>}
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
