import { useState } from "react"
import {
	PlusIcon,
	PencilIcon,
	CheckIcon,
	GridIcon,
	DotsVerticalIcon,
	DownloadIcon,
	HistoryIcon,
	BracketsCurlyIcon,
	TagIcon,
	LayersIcon,
	LinkIcon,
} from "@/components/icons"

import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@maple/ui/components/ui/dropdown-menu"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { ReloadControls } from "@/components/time-range-picker/reload-controls"
import { RefreshIntervalPicker } from "@/components/time-range-picker/refresh-interval-picker"
import { VariableSelects } from "@/components/dashboard-builder/toolbar/variable-selects"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import { downloadPortableDashboard } from "@/components/dashboard-builder/portable-dashboard"
import { VariablesManagerDialog } from "@/components/dashboard-builder/config/variables-manager-dialog"
import { TagEditorDialog } from "@/components/dashboard-builder/tag-editor"
import { ShareDashboardDialog } from "@/components/dashboard-builder/toolbar/share-dashboard-dialog"
import { collectTags } from "@/components/dashboard-builder/list/dashboard-summary"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import type { Dashboard } from "@/components/dashboard-builder/types"
import type { DashboardRefreshIntervalSeconds } from "@maple/domain/http"

interface DashboardToolbarProps {
	dashboard: Dashboard
	onToggleEdit: () => void
	onAddWidget: () => void
	onOpenHistory?: () => void
	/** Effective cadence for this viewer: `?refresh=` if set, else the board's default. */
	refreshIntervalSeconds: DashboardRefreshIntervalSeconds
	onRefreshIntervalChange: (value: DashboardRefreshIntervalSeconds) => void
}

export function DashboardToolbar({
	dashboard,
	onToggleEdit,
	onAddWidget,
	onOpenHistory,
	refreshIntervalSeconds,
	onRefreshIntervalChange,
}: DashboardToolbarProps) {
	const { mode, readOnly, autoLayoutWidgets, addSection } = useDashboardActions()
	const {
		state: { timeRange, resolvedTimeRange },
		actions: { setTimeRange },
	} = useDashboardTimeRange()
	const { updateDashboardVariables, updateDashboard, dashboards } = useDashboardStore()
	const [variablesDialogOpen, setVariablesDialogOpen] = useState(false)
	const [tagsDialogOpen, setTagsDialogOpen] = useState(false)
	const [shareDialogOpen, setShareDialogOpen] = useState(false)

	const isEdit = mode === "edit"

	return (
		// Wraps rather than overflows: variable chips, the time picker and the
		// action group together need ~700px, which the canvas does not have on a
		// phone or with both sidebars open. Gating is on `@container/page`
		// (declared by PageLayout.Content) because the sidebars, not the viewport,
		// decide how much room this actually gets.
		<div className="flex flex-wrap items-center justify-end gap-2 @min-[720px]/page:gap-3">
			<div className="flex min-w-0 max-w-full items-center overflow-x-auto">
				<VariableSelects
					onManage={isEdit && !readOnly ? () => setVariablesDialogOpen(true) : undefined}
				/>
			</div>
			<TimeRangePicker
				hotkey
				startTime={resolvedTimeRange?.startTime}
				endTime={resolvedTimeRange?.endTime}
				presetValue={timeRange.type === "relative" ? timeRange.value : undefined}
				onChange={(range) => {
					if (range.startTime && range.endTime) {
						if (range.presetValue) {
							setTimeRange({
								type: "relative",
								value: range.presetValue,
							})
						} else {
							setTimeRange({
								type: "absolute",
								startTime: range.startTime,
								endTime: range.endTime,
							})
						}
					}
				}}
			/>

			<div className="flex items-center gap-1">
				<ReloadControls />
				<RefreshIntervalPicker
					value={refreshIntervalSeconds}
					onChange={onRefreshIntervalChange}
					savedDefault={dashboard.refreshIntervalSeconds}
				/>
			</div>

			<div className="flex items-center gap-1">
				{/* Labels collapse to icon-only on a narrow canvas; `aria-label`
				    keeps the buttons named for screen readers either way. */}
				{isEdit && (
					<Button
						variant="outline"
						size="sm"
						onClick={onAddWidget}
						disabled={readOnly}
						aria-label="Add widget"
					>
						<PlusIcon size={14} data-icon="inline-start" />
						<span className="hidden @min-[560px]/page:inline">Add Widget</span>
					</Button>
				)}
				<Button
					variant={isEdit ? "default" : "outline"}
					size="sm"
					onClick={onToggleEdit}
					disabled={readOnly}
					aria-label={isEdit ? "Done editing" : "Edit dashboard"}
				>
					{isEdit ? (
						<CheckIcon size={14} data-icon="inline-start" />
					) : (
						<PencilIcon size={14} data-icon="inline-start" />
					)}
					<span className="hidden @min-[560px]/page:inline">{isEdit ? "Done" : "Edit"}</span>
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={<Button variant="ghost" size="icon-xs" aria-label="More dashboard actions" />}
					>
						<DotsVerticalIcon size={16} />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-[180px]">
						{isEdit && (
							<DropdownMenuItem
								onClick={autoLayoutWidgets}
								disabled={readOnly}
								className="whitespace-nowrap"
							>
								<GridIcon size={14} />
								Auto Layout
							</DropdownMenuItem>
						)}
						{isEdit && (
							<DropdownMenuItem
								onClick={() => addSection()}
								disabled={readOnly}
								className="whitespace-nowrap"
							>
								<LayersIcon size={14} />
								Add group
							</DropdownMenuItem>
						)}
						{isEdit && (
							<DropdownMenuItem
								onClick={() => setVariablesDialogOpen(true)}
								disabled={readOnly}
								className="whitespace-nowrap"
							>
								<BracketsCurlyIcon size={14} />
								Variables
							</DropdownMenuItem>
						)}
						{isEdit && (
							<DropdownMenuItem
								onClick={() => setTagsDialogOpen(true)}
								disabled={readOnly}
								className="whitespace-nowrap"
							>
								<TagIcon size={14} />
								Tags
							</DropdownMenuItem>
						)}
						{onOpenHistory && (
							<DropdownMenuItem onClick={onOpenHistory} className="whitespace-nowrap">
								<HistoryIcon size={14} />
								Version history
							</DropdownMenuItem>
						)}
						{(isEdit || onOpenHistory) && <DropdownMenuSeparator />}
						<DropdownMenuItem
							onClick={() => setShareDialogOpen(true)}
							className="whitespace-nowrap"
						>
							<LinkIcon size={14} />
							Share…
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => downloadPortableDashboard(dashboard)}
							className="whitespace-nowrap"
						>
							<DownloadIcon size={14} />
							Export as JSON
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<VariablesManagerDialog
				open={variablesDialogOpen}
				onOpenChange={setVariablesDialogOpen}
				variables={dashboard.variables ?? []}
				onSave={(variables) => updateDashboardVariables(dashboard.id, variables)}
			/>

			<ShareDashboardDialog
				dashboard={dashboard}
				open={shareDialogOpen}
				onOpenChange={setShareDialogOpen}
			/>

			<TagEditorDialog
				open={tagsDialogOpen}
				onOpenChange={setTagsDialogOpen}
				dashboardName={dashboard.name}
				tags={dashboard.tags ?? []}
				suggestions={collectTags(dashboards)}
				onSave={(tags) => updateDashboard(dashboard.id, { tags })}
			/>
		</div>
	)
}
