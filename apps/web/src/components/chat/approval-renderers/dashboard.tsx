import { Badge } from "@maple/ui/components/ui/badge"
import {
	ChartLineIcon,
	CirclePercentageIcon,
	GridIcon,
	MenuIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
	type IconComponent,
} from "@/components/icons"
import { asArray, asRecord, asString, safeParseJson } from "./parse"

const VIZ_ICONS: Record<string, IconComponent> = {
	chart: ChartLineIcon,
	stat: CirclePercentageIcon,
	table: GridIcon,
	list: MenuIcon,
}

const VIZ_LABELS: Record<string, string> = {
	chart: "Chart",
	stat: "Stat",
	table: "Table",
	list: "List",
}

interface ApprovalRendererProps {
	input: unknown
}

interface NormalizedWidget {
	visualization: string
	title: string
	source?: string
	groupBy?: string
}

function normalizeWidget(raw: unknown): NormalizedWidget | undefined {
	const obj = asRecord(raw)
	if (!obj) return undefined

	const visualization = asString(obj.visualization) ?? "chart"
	const display = asRecord(obj.display)
	const dataSource = asRecord(obj.dataSource)
	const dataParams = asRecord(dataSource?.params)

	const title = asString(display?.title) ?? asString(obj.title) ?? "Untitled widget"

	const source =
		asString(dataSource?.endpoint) ??
		asString(obj.source) ??
		asString(dataParams?.source) ??
		undefined

	const groupBy =
		asString(dataParams?.group_by) ??
		asString(obj.group_by) ??
		undefined

	return { visualization, title, source, groupBy }
}

function WidgetRow({ widget }: { widget: NormalizedWidget }) {
	const Icon = Object.hasOwn(VIZ_ICONS, widget.visualization)
		? VIZ_ICONS[widget.visualization]
		: ChartLineIcon
	return (
		<div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="truncate text-xs font-medium">{widget.title}</span>
			{widget.source ? (
				<span className="truncate text-[11px] text-muted-foreground">{widget.source}</span>
			) : null}
			{widget.groupBy ? (
				<Badge variant="outline" className="ml-auto h-4 px-1.5 text-[10px]">
					{widget.groupBy}
				</Badge>
			) : null}
		</div>
	)
}

function WidgetList({ widgets, max = 8 }: { widgets: NormalizedWidget[]; max?: number }) {
	if (widgets.length === 0) return null
	const visible = widgets.slice(0, max)
	const overflow = widgets.length - visible.length
	return (
		<div className="space-y-1">
			{visible.map((w, i) => (
				<WidgetRow key={i} widget={w} />
			))}
			{overflow > 0 ? (
				<div className="px-2 text-[11px] text-muted-foreground">+ {overflow} more</div>
			) : null}
		</div>
	)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1.5">
			<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				{title}
			</div>
			{children}
		</div>
	)
}

function FieldChip({ label, value }: { label: string; value: string }) {
	return (
		<Badge variant="outline" className="gap-1 font-normal">
			<span className="text-muted-foreground">{label}</span>
			<span className="font-mono">{value}</span>
		</Badge>
	)
}

function deriveWidgetsFromCreate(input: Record<string, unknown>): NormalizedWidget[] {
	const dashboardJson = safeParseJson(input.dashboard_json)
	if (dashboardJson.ok) {
		const doc = asRecord(dashboardJson.value)
		const widgets = asArray(doc?.widgets) ?? []
		return widgets.map(normalizeWidget).filter((w): w is NormalizedWidget => Boolean(w))
	}

	const simpleWidgets = safeParseJson(input.widgets)
	if (simpleWidgets.ok) {
		const arr = asArray(simpleWidgets.value) ?? []
		return arr.map(normalizeWidget).filter((w): w is NormalizedWidget => Boolean(w))
	}

	return []
}

export function CreateDashboardSummary({ input }: ApprovalRendererProps) {
	const obj = asRecord(input) ?? {}
	const name = asString(obj.name) ?? "Untitled dashboard"
	const description = asString(obj.description)
	const serviceName = asString(obj.service_name)
	const timeRange = asString(obj.time_range) ?? "1h"
	const isCustom = Boolean(obj.dashboard_json) || Boolean(obj.widgets)
	const template = asString(obj.template) ?? (isCustom ? "Custom" : "service-health")
	const widgets = deriveWidgetsFromCreate(obj)
	const dashboardJsonName = (() => {
		const parsed = safeParseJson(obj.dashboard_json)
		if (!parsed.ok) return undefined
		const doc = asRecord(parsed.value)
		return asString(doc?.name) ?? asString(doc?.title)
	})()

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold">{name}</div>
					{dashboardJsonName && dashboardJsonName !== name ? (
						<div className="truncate text-[11px] text-muted-foreground">
							Inner title: {dashboardJsonName}
						</div>
					) : null}
				</div>
			</div>

			{description ? (
				<div className="text-xs text-muted-foreground">{description}</div>
			) : null}

			<div className="flex flex-wrap gap-1.5">
				<FieldChip label="template" value={template} />
				{serviceName ? <FieldChip label="service" value={serviceName} /> : null}
				<FieldChip label="time" value={timeRange} />
			</div>

			{widgets.length > 0 ? (
				<Section title={`Widgets (${widgets.length})`}>
					<WidgetList widgets={widgets} />
				</Section>
			) : !isCustom ? (
				<div className="rounded-md border border-dashed border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
					Template will generate widgets automatically.
				</div>
			) : null}
		</div>
	)
}

export function UpdateDashboardSummary({ input }: ApprovalRendererProps) {
	const obj = asRecord(input) ?? {}
	const dashboardId = asString(obj.dashboard_id) ?? "—"
	const name = asString(obj.name)
	const description = asString(obj.description)
	const timeRange = asString(obj.time_range)
	const hasFullReplacement = Boolean(obj.dashboard_json)
	const widgets = hasFullReplacement ? deriveWidgetsFromCreate(obj) : []

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-sm font-semibold">Update dashboard</span>
				<Badge variant="outline" className="ml-auto font-mono text-[10px]">
					{dashboardId}
				</Badge>
			</div>

			<div className="space-y-1">
				{name ? (
					<div className="text-xs">
						<span className="text-muted-foreground">New name: </span>
						<span className="font-medium">{name}</span>
					</div>
				) : null}
				{description ? (
					<div className="text-xs">
						<span className="text-muted-foreground">New description: </span>
						<span>{description}</span>
					</div>
				) : null}
				{timeRange ? (
					<div className="text-xs">
						<span className="text-muted-foreground">New time range: </span>
						<span className="font-mono">{timeRange}</span>
					</div>
				) : null}
				{!name && !description && !timeRange && !hasFullReplacement ? (
					<div className="text-xs text-muted-foreground">No metadata changes</div>
				) : null}
			</div>

			{hasFullReplacement ? (
				<Section
					title={
						widgets.length > 0
							? `Full replacement · ${widgets.length} widget${widgets.length === 1 ? "" : "s"}`
							: "Full replacement"
					}
				>
					<div className="mb-1.5">
						<Badge variant="destructive" className="text-[10px]">
							Replaces entire dashboard
						</Badge>
					</div>
					<WidgetList widgets={widgets} />
				</Section>
			) : null}
		</div>
	)
}

export function AddDashboardWidgetSummary({ input }: ApprovalRendererProps) {
	const obj = asRecord(input) ?? {}
	const dashboardId = asString(obj.dashboard_id) ?? "—"
	const visualization = asString(obj.visualization) ?? "chart"
	const Icon = Object.hasOwn(VIZ_ICONS, visualization)
		? VIZ_ICONS[visualization]
		: ChartLineIcon
	const vizLabel = Object.hasOwn(VIZ_LABELS, visualization)
		? VIZ_LABELS[visualization]
		: visualization

	const display = safeParseJson<Record<string, unknown>>(obj.display_json)
	const dataSource = safeParseJson<Record<string, unknown>>(obj.data_source_json)
	const layout = safeParseJson<Record<string, unknown>>(obj.layout_json)

	const title =
		(display.ok ? asString(display.value.title) : undefined) ?? "Untitled widget"
	const endpoint = dataSource.ok ? asString(dataSource.value.endpoint) : undefined
	const params = dataSource.ok ? asRecord(dataSource.value.params) : undefined
	const serviceName = params ? asString(params.service_name) : undefined

	const layoutLabel = (() => {
		if (!layout.ok) return "auto-placed"
		const x = layout.value.x
		const y = layout.value.y
		const w = layout.value.w
		const h = layout.value.h
		if (typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number") {
			return `${x},${y} · ${w}×${h}`
		}
		return "auto-placed"
	})()

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-sm font-semibold">Add widget</span>
				<Badge variant="outline" className="ml-auto font-mono text-[10px]">
					{dashboardId}
				</Badge>
			</div>

			<div className="rounded-md border border-border/60 bg-background/60 p-2">
				<div className="flex items-center gap-2">
					<Icon className="size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs font-medium">{title}</div>
						{endpoint ? (
							<div className="truncate text-[11px] text-muted-foreground">{endpoint}</div>
						) : null}
					</div>
				</div>
			</div>

			<div className="flex flex-wrap gap-1.5">
				<FieldChip label="viz" value={vizLabel} />
				{serviceName ? <FieldChip label="service" value={serviceName} /> : null}
				<FieldChip label="layout" value={layoutLabel} />
			</div>
		</div>
	)
}

export function UpdateDashboardWidgetSummary({ input }: ApprovalRendererProps) {
	const obj = asRecord(input) ?? {}
	const dashboardId = asString(obj.dashboard_id) ?? "—"
	const widgetId = asString(obj.widget_id) ?? "—"
	const visualization = asString(obj.visualization)

	const dataSource = safeParseJson<Record<string, unknown>>(obj.data_source_json)
	const display = safeParseJson<Record<string, unknown>>(obj.display_json)
	const layout = safeParseJson<Record<string, unknown>>(obj.layout_json)

	const changes: Array<{ label: string; detail?: string }> = []
	if (visualization) changes.push({ label: "Visualization", detail: visualization })
	if (display.ok) {
		const title = asString(display.value.title)
		changes.push({
			label: "Display config",
			detail: title ? `title: ${title}` : undefined,
		})
	}
	if (dataSource.ok) {
		const endpoint = asString(dataSource.value.endpoint)
		changes.push({
			label: "Data source",
			detail: endpoint ? `endpoint: ${endpoint}` : undefined,
		})
	}
	if (layout.ok) {
		changes.push({ label: "Layout" })
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-sm font-semibold">Update widget</span>
			</div>

			<div className="flex flex-wrap gap-1.5">
				<FieldChip label="dashboard" value={dashboardId} />
				<FieldChip label="widget" value={widgetId} />
			</div>

			<Section title={`Changes (${changes.length})`}>
				{changes.length === 0 ? (
					<div className="text-xs text-muted-foreground">No changes</div>
				) : (
					<ul className="space-y-1 text-xs">
						{changes.map((c, i) => (
							<li key={i} className="flex gap-2">
								<span className="font-medium">{c.label}</span>
								{c.detail ? (
									<span className="truncate text-muted-foreground">{c.detail}</span>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Section>
		</div>
	)
}

export function RemoveDashboardWidgetSummary({ input }: ApprovalRendererProps) {
	const obj = asRecord(input) ?? {}
	const dashboardId = asString(obj.dashboard_id) ?? "—"
	const widgetId = asString(obj.widget_id) ?? "—"

	return (
		<div className="flex items-start gap-2">
			<TrashIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
			<div className="text-xs leading-relaxed">
				Remove widget{" "}
				<span className="rounded bg-muted px-1 font-mono text-[11px]">{widgetId}</span> from
				dashboard{" "}
				<span className="rounded bg-muted px-1 font-mono text-[11px]">{dashboardId}</span>.
			</div>
		</div>
	)
}

export function ReorderDashboardWidgetsSummary({ input }: ApprovalRendererProps) {
	const obj = asRecord(input) ?? {}
	const dashboardId = asString(obj.dashboard_id) ?? "—"

	const layoutsRaw = safeParseJson(obj.layouts_json)
	const layouts = layoutsRaw.ok ? asArray(layoutsRaw.value) ?? [] : []
	const ids = layouts
		.map((entry) => asString(asRecord(entry)?.id))
		.filter((id): id is string => Boolean(id))
	const previewIds = ids.slice(0, 4)
	const overflow = ids.length - previewIds.length

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<GridIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-sm font-semibold">
					Reorder {ids.length || ""} widget{ids.length === 1 ? "" : "s"}
				</span>
				<Badge variant="outline" className="ml-auto font-mono text-[10px]">
					{dashboardId}
				</Badge>
			</div>
			{previewIds.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{previewIds.map((id) => (
						<span
							key={id}
							className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
						>
							{id}
						</span>
					))}
					{overflow > 0 ? (
						<span className="text-[10px] text-muted-foreground">+ {overflow} more</span>
					) : null}
				</div>
			) : null}
		</div>
	)
}
