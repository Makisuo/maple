import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Option, Schema } from "effect"
import { Fragment, useState, useMemo } from "react"
import { toast } from "sonner"

import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { DestinationCard } from "@/components/alerts/destination-card"
import { ProviderLogo } from "@/components/alerts/destination-provider"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatStrip, AlertFiringHero } from "@/components/alerts/alert-stat-card"
import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"
import { AlertTagControls } from "@/components/alerts/alert-tag-controls"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import {
	filterByTags,
	groupByTag as groupItemsByTag,
	tagFacets,
	type TagGroup,
} from "@/lib/alerts/tag-grouping"
import { formatRelativeTime } from "@/lib/format"
import {
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import {
	type DestinationFormState,
	signalLabels,
	comparatorLabels,
	formatSignalValue,
	formatAlertDateTime,
	formatAlertTime,
	eventTypeMeta,
	deliveryStatusMeta,
	groupDeliveryEventsByDay,
	getExitErrorMessage,
	defaultDestinationForm,
	destinationToFormState,
	buildDestinationCreatePayload,
	buildDestinationUpdatePayload,
	buildRuleToggleRequest,
} from "@/lib/alerts/form-utils"
import {
	BellIcon,
	CircleWarningIcon,
	FireIcon,
	MagnifierIcon,
	PlusIcon,
	TruckIcon,
	XmarkIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"

const tabValues = ["monitor", "rules", "settings"] as const
type AlertsTab = (typeof tabValues)[number]

const AlertsSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	serviceName: Schema.optional(Schema.String),
	createdBy: Schema.optional(Schema.String),
	/** Tag filter, shared across the Monitor and Rules tabs. */
	tags: OptionalStringArrayParam,
	/** When set, the active list is grouped into per-tag sections. */
	groupByTag: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
})

/** Sentinel value for the "Created by" filter meaning no creator restriction. */
const ANY_CREATOR = "__anyone__"

export const Route = effectRoute(createFileRoute("/alerts/"))({
	component: AlertsPage,
	validateSearch: Schema.toStandardSchemaV1(AlertsSearch),
})

type AlertDestination = AlertDestinationDocument
type AlertRule = AlertRuleDocument
type AlertDeliveryEvent = AlertDeliveryEventDocument

/* -------------------------------------------------------------------------- */
/*  Signal badge tone                                                         */
/* -------------------------------------------------------------------------- */

const signalBadgeClass: Record<string, string> = {
	error_rate: "border-destructive/30 text-destructive",
	p95_latency: "border-primary/30 text-primary",
	p99_latency: "border-primary/30 text-primary",
	apdex: "border-severity-warn/30 text-severity-warn",
	// Throughput rides the dedicated chart-throughput hue so the chip stays
	// distinguishable from the amber p95/apdex chips (see DESIGN.md).
	throughput: "border-[var(--chart-throughput)]/30 text-[var(--chart-throughput)]",
	metric: "border-muted-foreground/30 text-muted-foreground",
	query: "border-muted-foreground/30 text-muted-foreground",
}

/** Critical before warning, then most-recently-triggered first. */
const severityRank: Record<string, number> = { critical: 0, warning: 1 }
function sortIncidents(incidents: AlertIncidentDocument[]): AlertIncidentDocument[] {
	return [...incidents].sort((a, b) => {
		const bySeverity = (severityRank[a.severity] ?? 2) - (severityRank[b.severity] ?? 2)
		if (bySeverity !== 0) return bySeverity
		const ta = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
		const tb = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
		return tb - ta
	})
}

function SignalBadge({ signalType }: { signalType: string }) {
	return (
		<Badge variant="outline" className={cn("text-xs", signalBadgeClass[signalType])}>
			{signalLabels[signalType as keyof typeof signalLabels] ?? signalType}
		</Badge>
	)
}

/** Secondary-tone tag chips, kept visually distinct from outline service badges. */
function TagChips({ tags }: { tags: readonly string[] }) {
	if (tags.length === 0) return null
	return (
		<div className="mt-1 flex flex-wrap gap-1">
			{tags.map((tag) => (
				<Badge key={tag} variant="secondary" size="sm">
					{tag}
				</Badge>
			))}
		</div>
	)
}

/** Group-header row reused by the Rules and Monitor grouped tables. */
function TagGroupHeaderRow({
	label,
	count,
	noun,
	colSpan,
}: {
	label: string
	count: number
	noun: string
	colSpan: number
}) {
	return (
		<TableRow>
			<TableCell
				colSpan={colSpan}
				className="bg-muted/30 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
			>
				<span className="flex items-center gap-2">
					{label}
					<span className="tracking-normal normal-case text-muted-foreground/55 tabular-nums">
						{count} {count === 1 ? noun : `${noun}s`}
					</span>
				</span>
			</TableCell>
		</TableRow>
	)
}

/**
 * Notify cell. Shows the real provider marks a rule routes to (joined from the
 * already-loaded destinations) instead of an opaque count. An enabled rule with
 * no destination is surfaced as a warning — it can page no one.
 */
function NotifyChannels({ destinations, enabled }: { destinations: AlertDestination[]; enabled: boolean }) {
	if (destinations.length === 0) {
		if (!enabled) return <span className="text-muted-foreground text-xs">No channel</span>
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<span className="inline-flex cursor-default items-center gap-1 text-warning text-xs" />
					}
				>
					<CircleWarningIcon size={12} />
					No channel
				</TooltipTrigger>
				<TooltipContent>Enabled but routed nowhere — this rule can notify no one.</TooltipContent>
			</Tooltip>
		)
	}

	const shown = destinations.slice(0, 3)
	const extra = destinations.length - shown.length
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="inline-flex cursor-default items-center gap-1.5" />}>
				<span className="flex items-center gap-1">
					{shown.map((d) => (
						<ProviderLogo key={d.id} type={d.type} size={28} bare className="flex items-center" />
					))}
				</span>
				{extra > 0 && <span className="text-muted-foreground text-xs tabular-nums">+{extra}</span>}
			</TooltipTrigger>
			<TooltipContent>{destinations.map((d) => d.name).join(", ")}</TooltipContent>
		</Tooltip>
	)
}

/* -------------------------------------------------------------------------- */
/*  Monitor Tab                                                               */
/* -------------------------------------------------------------------------- */

function MonitorTab({
	rules,
	incidents,
	deliveryEvents,
	loading,
	selectedTags,
	grouped,
	onSelectedTagsChange,
	onGroupedChange,
}: {
	rules: AlertRule[]
	incidents: AlertIncidentDocument[]
	deliveryEvents: AlertDeliveryEvent[]
	loading: boolean
	selectedTags: string[]
	grouped: boolean
	onSelectedTagsChange: (tags: string[]) => void
	onGroupedChange: (grouped: boolean) => void
}) {
	const openIncidents = useMemo(() => incidents.filter((i) => i.status === "open"), [incidents])
	const criticalCount = openIncidents.filter((i) => i.severity === "critical").length
	const warningCount = openIncidents.filter((i) => i.severity === "warning").length
	const enabledRules = rules.filter((r) => r.enabled).length

	// Triggered window — a quick lens over how recently rules have been firing.
	const [triggeredWindow, setTriggeredWindow] = useState<"24h" | "7d" | "30d">("24h")
	const triggeredInWindow = useMemo(() => {
		const windowMs =
			triggeredWindow === "24h"
				? 24 * 60 * 60 * 1000
				: triggeredWindow === "7d"
					? 7 * 24 * 60 * 60 * 1000
					: 30 * 24 * 60 * 60 * 1000
		const cutoff = Date.now() - windowMs
		return incidents.filter((i) => {
			if (!i.firstTriggeredAt) return false
			return new Date(i.firstTriggeredAt).getTime() >= cutoff
		}).length
	}, [incidents, triggeredWindow])

	const mttr = useMemo(() => {
		const resolved = incidents.filter((i) => i.resolvedAt && i.firstTriggeredAt)
		if (resolved.length === 0) return "—"
		const avg =
			resolved.reduce((sum, i) => {
				return sum + (new Date(i.resolvedAt!).getTime() - new Date(i.firstTriggeredAt).getTime())
			}, 0) / resolved.length
		if (avg < 60_000) return `${Math.round(avg / 1000)}s`
		if (avg < 3_600_000) return `${(avg / 60_000).toFixed(1)}m`
		return `${(avg / 3_600_000).toFixed(1)}h`
	}, [incidents])

	const rulesById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules])

	// Incidents inherit their rule's tags via a client-side join — no incident
	// row carries tags itself.
	const tagsByRuleId = useMemo(() => new Map(rules.map((r) => [r.id, r.tags])), [rules])
	const incidentTagFacets = useMemo(
		() => tagFacets(openIncidents, (i) => tagsByRuleId.get(i.ruleId) ?? []),
		[openIncidents, tagsByRuleId],
	)
	const visibleIncidents = useMemo(
		() =>
			sortIncidents([
				...filterByTags(openIncidents, (i) => tagsByRuleId.get(i.ruleId) ?? [], selectedTags),
			]),
		[openIncidents, tagsByRuleId, selectedTags],
	)
	const incidentGroups = useMemo(
		() => (grouped ? groupItemsByTag(visibleIncidents, (i) => tagsByRuleId.get(i.ruleId) ?? []) : null),
		[grouped, visibleIncidents, tagsByRuleId],
	)
	const visibleEvents = useMemo(
		() => [...filterByTags(deliveryEvents, (e) => tagsByRuleId.get(e.ruleId) ?? [], selectedTags)],
		[deliveryEvents, tagsByRuleId, selectedTags],
	)

	if (loading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-[60px] w-full" />
				<Skeleton className="h-48 w-full" />
				<Skeleton className="h-[84px] w-full" />
			</div>
		)
	}

	const lastEvaluatedHint = deliveryEvents[0]?.scheduledAt
		? `Last evaluated ${formatRelativeTime(deliveryEvents[0].scheduledAt)}`
		: undefined

	const renderIncidentRow = (incident: AlertIncidentDocument, key: string) => {
		const duration = incident.lastTriggeredAt ? formatRelativeTime(incident.lastTriggeredAt) : "—"
		const tags = tagsByRuleId.get(incident.ruleId) ?? []
		return (
			<TableRow key={key} className="cursor-pointer">
				<TableCell>
					<AlertSeverityBadge severity={incident.severity} />
				</TableCell>
				<TableCell>
					<Link
						to="/alerts/$ruleId"
						params={{ ruleId: incident.ruleId }}
						className="font-medium hover:underline"
					>
						{incident.ruleName}
					</Link>
					{!grouped && <TagChips tags={tags} />}
				</TableCell>
				<TableCell>
					<span className="font-mono text-muted-foreground">{incident.groupKey ?? "all"}</span>
				</TableCell>
				<TableCell>
					<span className="font-mono text-destructive">
						{formatSignalValue(incident.signalType, incident.lastObservedValue)}
					</span>
					<span className="text-muted-foreground text-xs ml-1">
						/ {formatSignalValue(incident.signalType, incident.threshold)}
					</span>
				</TableCell>
				<TableCell>{duration}</TableCell>
				<TableCell>
					{incident.lastNotifiedAt ? formatRelativeTime(incident.lastNotifiedAt) : "Never"}
				</TableCell>
			</TableRow>
		)
	}

	const tagControls = (
		<AlertTagControls
			facets={incidentTagFacets}
			selected={selectedTags}
			onSelectedChange={onSelectedTagsChange}
			grouped={grouped}
			onGroupedChange={onGroupedChange}
		/>
	)

	return (
		<div className="space-y-6">
			{/* Status bar — flat one-row state; the incident list leads directly below */}
			<AlertFiringHero
				openCount={openIncidents.length}
				criticalCount={criticalCount}
				warningCount={warningCount}
				rulesEnabled={enabledRules}
				rulesTotal={rules.length}
				lastEvaluatedHint={lastEvaluatedHint}
			/>

			{/* Active incidents — the actionable list, severity-sorted, filterable by tag */}
			{openIncidents.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<h2 className="text-lg font-semibold">Active incidents</h2>
							<Badge variant="secondary" className="rounded-full tabular-nums">
								{visibleIncidents.length}
							</Badge>
						</div>
						{tagControls}
					</div>

					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[90px]">Severity</TableHead>
								<TableHead>Rule</TableHead>
								<TableHead>Group</TableHead>
								<TableHead>Current value</TableHead>
								<TableHead className="w-[110px]">Duration</TableHead>
								<TableHead>Last notified</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visibleIncidents.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={6}
										className="py-8 text-center text-muted-foreground text-sm"
									>
										No active incidents match the selected tags.
									</TableCell>
								</TableRow>
							) : incidentGroups ? (
								incidentGroups.map((group) => (
									<Fragment key={group.key}>
										<TagGroupHeaderRow
											label={group.label}
											count={group.count}
											noun="incident"
											colSpan={6}
										/>
										{group.items.map((incident) =>
											renderIncidentRow(incident, `${group.key}:${incident.id}`),
										)}
									</Fragment>
								))
							) : (
								visibleIncidents.map((incident) => renderIncidentRow(incident, incident.id))
							)}
						</TableBody>
					</Table>
				</div>
			)}

			{/* Slim summary strip — a secondary glance, sits beneath the incident list */}
			<div className="space-y-2">
				<div className="flex justify-end">
					<AlertSegmentedSelect<"24h" | "7d" | "30d">
						options={[
							{ value: "24h", label: "24h" },
							{ value: "7d", label: "7d" },
							{ value: "30d", label: "30d" },
						]}
						value={triggeredWindow}
						onChange={setTriggeredWindow}
						size="sm"
						aria-label="Triggered window"
					/>
				</div>
				<AlertStatStrip
					items={[
						{
							label: `Triggered (${triggeredWindow})`,
							value: triggeredInWindow,
							hint: triggeredInWindow === 1 ? "incident" : "incidents",
						},
						{ label: "Avg MTTR", value: mttr, hint: "across resolved" },
						{ label: "Rules enabled", value: enabledRules, hint: `of ${rules.length} total` },
					]}
				/>
			</div>

			{/* No-activity hint — only when nothing has happened at all */}
			{openIncidents.length === 0 && deliveryEvents.length === 0 && (
				<div className="rounded-md border border-dashed border-border/60 py-8 text-center text-muted-foreground text-sm">
					No recent notifications. Quiet is good.
				</div>
			)}

			{/* Recent Activity — compact, rule-centric preview of the full delivery log */}
			{visibleEvents.length > 0 && (
				<div className="space-y-3">
					<div>
						<h2 className="text-lg font-semibold">Recent activity</h2>
						<p className="text-muted-foreground text-sm">
							Latest notification attempts. Full history in the Settings tab.
						</p>
					</div>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[120px]">Event</TableHead>
								<TableHead>Rule</TableHead>
								<TableHead>Destination</TableHead>
								<TableHead className="w-[140px]">When</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visibleEvents.slice(0, 10).map((event) => {
								const rule = rulesById.get(event.ruleId)
								const ev = eventTypeMeta[event.eventType]

								return (
									<TableRow key={event.id}>
										<TableCell>
											<span
												className={cn(
													"flex items-center gap-1.5 text-xs font-medium",
													ev.text,
												)}
											>
												<span className={cn("size-1.5 rounded-full", ev.dot)} />
												{ev.label}
											</span>
										</TableCell>
										<TableCell className="max-w-0">
											{rule ? (
												<Link
													to="/alerts/$ruleId"
													params={{ ruleId: rule.id }}
													className="block truncate font-medium hover:underline"
												>
													{rule.name}
												</Link>
											) : (
												<span className="text-muted-foreground">–</span>
											)}
										</TableCell>
										<TableCell>
											<span className="flex min-w-0 items-center gap-2">
												<ProviderLogo
													type={event.destinationType}
													size={32}
													bare
													className="flex shrink-0 items-center"
												/>
												<span className="truncate text-muted-foreground">
													{event.destinationName}
												</span>
												{event.status === "failed" ? (
													<span className="shrink-0 text-destructive text-xs font-medium">
														Failed
													</span>
												) : event.status === "queued" ||
												  event.status === "processing" ? (
													<span className="shrink-0 text-muted-foreground/70 text-xs">
														Pending
													</span>
												) : null}
											</span>
										</TableCell>
										<TableCell className="text-muted-foreground tabular-nums">
											{event.scheduledAt ? (
												<Tooltip>
													<TooltipTrigger
														render={<span />}
														className="cursor-default"
													>
														{formatRelativeTime(event.scheduledAt)}
													</TooltipTrigger>
													<TooltipContent>
														{formatAlertDateTime(event.scheduledAt)}
													</TooltipContent>
												</Tooltip>
											) : (
												"—"
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  Main Page                                                                 */
/* -------------------------------------------------------------------------- */

function AlertsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
	const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", {
		reactivityKeys: ["alertDestinations"],
	})
	const deliveryEventsQueryAtom = MapleApiAtomClient.query("alerts", "listDeliveryEvents", {
		reactivityKeys: ["alertDeliveryEvents"],
	})

	const destinationsResult = useAtomValue(destinationsQueryAtom)
	const { result: rulesResult } = useAlertRulesList()
	const { result: incidentsResult } = useAlertIncidentsList()
	const deliveryEventsResult = useAtomValue(deliveryEventsQueryAtom)

	const createDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "createDestination"), {
		mode: "promiseExit",
	})
	const updateDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateDestination"), {
		mode: "promiseExit",
	})
	const deleteDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "deleteDestination"), {
		mode: "promiseExit",
	})
	const testDestination = useAtomSet(MapleApiAtomClient.mutation("alerts", "testDestination"), {
		mode: "promiseExit",
	})

	const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), {
		mode: "promiseExit",
	})

	const activeTab: AlertsTab = (tabValues as readonly string[]).includes(search.tab ?? "")
		? (search.tab as AlertsTab)
		: "monitor"

	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestination[])
		.orElse(() => [])
	const rules = Result.builder(rulesResult)
		.onSuccess((response) => [...response.rules] as AlertRule[])
		.orElse(() => [])
	const incidents = Result.builder(incidentsResult)
		.onSuccess((response) => [...response.incidents] as AlertIncidentDocument[])
		.orElse(() => [] as AlertIncidentDocument[])
	const deliveryEvents = Result.builder(deliveryEventsResult)
		.onSuccess((response) => [...response.events] as AlertDeliveryEvent[])
		.orElse(() => [])
	const deliveryEventGroups = useMemo(() => groupDeliveryEventsByDay(deliveryEvents), [deliveryEvents])

	const isAdmin = Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)

	const currentUserId = Result.builder(sessionResult)
		.onSuccess((session) => session.userId as string)
		.orElse(() => null)

	// "Created by" filter options — one entry per distinct rule creator, with the
	// current user surfaced as "You". Maple has no org-members endpoint, so other
	// creators are shown by their raw identifier.
	const creatorOptions = useMemo(() => {
		const options: Record<string, string> = { [ANY_CREATOR]: "Anyone" }
		for (const rule of rules) {
			if (!(rule.createdBy in options)) {
				options[rule.createdBy] = rule.createdBy === currentUserId ? "You" : rule.createdBy
			}
		}
		return options
	}, [rules, currentUserId])

	const creatorFilter = search.createdBy ?? ANY_CREATOR
	const showCreatorFilter = Object.keys(creatorOptions).length > 2

	// Tag filter + grouping, shared across the Monitor and Rules tabs via search.
	const selectedTags = useMemo(() => search.tags ?? [], [search.tags])
	const groupByTagOn = search.groupByTag ?? false
	const setSelectedTags = (tags: string[]) =>
		navigate({ search: (prev) => ({ ...prev, tags: tags.length > 0 ? tags : undefined }) })
	const setGroupByTagOn = (grouped: boolean) =>
		navigate({ search: (prev) => ({ ...prev, groupByTag: grouped ? true : undefined }) })

	const ruleTagFacets = useMemo(() => tagFacets(rules, (r) => r.tags), [rules])

	// Rules tab: build firing status from open incidents
	const firingRuleIds = useMemo(() => {
		const ids = new Set<string>()
		for (const incident of incidents) {
			if (incident.status === "open") ids.add(incident.ruleId)
		}
		return ids
	}, [incidents])

	const [searchQuery, setSearchQuery] = useState("")
	const [destinationDialogOpen, setDestinationDialogOpen] = useState(false)
	const [destinationForm, setDestinationForm] = useState<DestinationFormState>(defaultDestinationForm())
	const [editingDestination, setEditingDestination] = useState<AlertDestination | null>(null)
	const [savingDestination, setSavingDestination] = useState(false)
	const [testingDestinationId, setTestingDestinationId] = useState<AlertDestination["id"] | null>(null)
	const [deletingDestinationId, setDeletingDestinationId] = useState<AlertDestination["id"] | null>(null)

	function handleTabSelect(tab: AlertsTab) {
		navigate({ search: (prev) => ({ ...prev, tab }) })
	}

	function openDestinationDialog(destination?: AlertDestination) {
		setEditingDestination(destination ?? null)
		setDestinationForm(destination ? destinationToFormState(destination) : defaultDestinationForm())
		setDestinationDialogOpen(true)
	}

	async function handleDestinationSave() {
		setSavingDestination(true)
		const result = editingDestination
			? await updateDestination({
					params: { destinationId: editingDestination.id },
					payload: buildDestinationUpdatePayload(destinationForm) as never,
					reactivityKeys: ["alertDestinations"],
				})
			: await createDestination({
					payload: buildDestinationCreatePayload(destinationForm) as never,
					reactivityKeys: ["alertDestinations"],
				})

		if (Exit.isSuccess(result)) {
			toast.success(editingDestination ? "Destination updated" : "Destination created")
			setDestinationDialogOpen(false)
		} else {
			toast.error(getExitErrorMessage(result, "Failed to save destination"))
		}
		setSavingDestination(false)
	}

	async function handleDestinationTest(destination: AlertDestination) {
		setTestingDestinationId(destination.id)
		const result = await testDestination({
			params: { destinationId: destination.id },
			reactivityKeys: ["alertDestinations", "alertDeliveryEvents"],
		})
		if (Exit.isSuccess(result)) {
			toast.success(result.value.message)
		} else {
			toast.error(getExitErrorMessage(result, "Failed to send test notification"))
		}
		setTestingDestinationId(null)
	}

	async function handleDestinationToggle(destination: AlertDestination) {
		const form = destinationToFormState(destination)
		form.enabled = !destination.enabled
		const result = await updateDestination({
			params: { destinationId: destination.id },
			payload: buildDestinationUpdatePayload(form) as never,
			reactivityKeys: ["alertDestinations"],
		})
		if (!Exit.isSuccess(result)) {
			toast.error(getExitErrorMessage(result, "Failed to update destination"))
		}
	}

	async function handleDestinationDelete(destination: AlertDestination) {
		setDeletingDestinationId(destination.id)
		const result = await deleteDestination({
			params: { destinationId: destination.id },
			reactivityKeys: ["alertDestinations", "alertRules"],
		})
		if (Exit.isSuccess(result)) {
			toast.success("Destination deleted")
		} else {
			const failure = Option.getOrUndefined(Exit.findErrorOption(result))
			if (
				typeof failure === "object" &&
				failure !== null &&
				"_tag" in failure &&
				failure._tag === "@maple/http/errors/AlertDestinationInUseError" &&
				"ruleNames" in failure &&
				Array.isArray(failure.ruleNames)
			) {
				const ruleNames = failure.ruleNames.filter((name): name is string => typeof name === "string")
				toast.error(
					ruleNames.length > 0
						? `Remove this destination from these rules first: ${ruleNames.join(", ")}`
						: getExitErrorMessage(result, "Failed to delete destination"),
				)
			} else {
				toast.error(getExitErrorMessage(result, "Failed to delete destination"))
			}
		}
		setDeletingDestinationId(null)
	}

	async function handleRuleToggle(rule: AlertRule) {
		const result = await updateRule({
			params: { ruleId: rule.id },
			payload: buildRuleToggleRequest(rule),
			reactivityKeys: ["alertRules"],
		})
		if (!Exit.isSuccess(result)) {
			toast.error(getExitErrorMessage(result, "Failed to update rule"))
		}
	}

	const filteredRules = useMemo(() => {
		let result = rules
		if (creatorFilter !== ANY_CREATOR) {
			result = result.filter((r) => r.createdBy === creatorFilter)
		}
		const q = searchQuery.trim().toLowerCase()
		if (q) {
			result = result.filter(
				(r) =>
					r.name.toLowerCase().includes(q) ||
					r.serviceNames?.some((s) => s.toLowerCase().includes(q)) ||
					r.tags.some((t) => t.includes(q)),
			)
		}
		return [...filterByTags(result, (r) => r.tags, selectedTags)]
	}, [rules, searchQuery, creatorFilter, selectedTags])

	const ruleGroups: TagGroup<AlertRule>[] | null = useMemo(
		() => (groupByTagOn ? groupItemsByTag(filteredRules, (r) => r.tags) : null),
		[groupByTagOn, filteredRules],
	)

	// Resolve each rule's destination IDs against the destinations already loaded
	// for the page — no extra query — so the Notify column can show real channels.
	const destinationsById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])

	const renderRuleRow = (rule: AlertRule, key: string) => {
		const status: "firing" | "ok" | "disabled" = !rule.enabled
			? "disabled"
			: firingRuleIds.has(rule.id)
				? "firing"
				: "ok"
		// Dedupe by id: a rule that lists the same destination twice still
		// notifies it once, so show one mark (and keep React keys unique).
		const ruleDestinations = [...new Set(rule.destinationIds)]
			.map((id) => destinationsById.get(id))
			.filter((d): d is AlertDestination => d != null)

		return (
			<TableRow
				key={key}
				className="cursor-pointer"
				onClick={() => navigate({ to: "/alerts/$ruleId", params: { ruleId: rule.id } })}
			>
				<TableCell onClick={(e) => e.stopPropagation()}>
					<Switch
						checked={rule.enabled}
						onCheckedChange={() => handleRuleToggle(rule)}
						disabled={!isAdmin}
					/>
				</TableCell>
				<TableCell className={cn("font-medium", !rule.enabled && "text-muted-foreground")}>
					{rule.name}
					{!groupByTagOn && <TagChips tags={rule.tags} />}
				</TableCell>
				<TableCell>
					<SignalBadge signalType={rule.signalType} />
				</TableCell>
				<TableCell>
					{rule.serviceNames?.length > 0 ? (
						<div className="flex flex-wrap gap-1">
							{rule.serviceNames.map((s) => (
								<Badge key={s} variant="outline" className="text-xs">
									{s}
								</Badge>
							))}
						</div>
					) : (
						<span className="font-mono text-muted-foreground text-xs">
							{rule.groupBy && rule.groupBy.length > 0
								? `all · per ${rule.groupBy.join(" · ")}`
								: "all"}
						</span>
					)}
					{rule.excludeServiceNames?.length > 0 && (
						<div className="flex flex-wrap gap-1 mt-0.5">
							{rule.excludeServiceNames.map((s) => (
								<Badge
									key={s}
									variant="outline"
									className="text-xs text-muted-foreground line-through"
								>
									{s}
								</Badge>
							))}
						</div>
					)}
				</TableCell>
				<TableCell>
					<span className="font-mono text-xs">
						{comparatorLabels[rule.comparator]}{" "}
						{formatSignalValue(rule.signalType, rule.threshold)} / {rule.windowMinutes}min
					</span>
				</TableCell>
				<TableCell>
					<AlertSeverityBadge severity={rule.severity} />
				</TableCell>
				<TableCell onClick={(e) => e.stopPropagation()}>
					<NotifyChannels destinations={ruleDestinations} enabled={rule.enabled} />
				</TableCell>
				<TableCell>
					<div className="flex items-center gap-1.5">
						<AlertStatusBadge state={status} />
						{rule.lastEvaluationError && (
							<Tooltip>
								<TooltipTrigger
									render={<span className="inline-flex cursor-default" />}
									onClick={(e) => e.stopPropagation()}
								>
									<CircleWarningIcon size={14} className="text-destructive" />
								</TooltipTrigger>
								<TooltipContent className="max-w-[280px]">
									Last evaluation failed: {rule.lastEvaluationError}
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				</TableCell>
			</TableRow>
		)
	}

	const tabBar = (
		<Tabs value={activeTab} onValueChange={(v) => handleTabSelect(v as AlertsTab)}>
			<TabsList variant="underline">
				<TabsTrigger value="monitor">Monitor</TabsTrigger>
				<TabsTrigger value="rules">Rules</TabsTrigger>
				<TabsTrigger value="settings">Settings</TabsTrigger>
			</TabsList>
		</Tabs>
	)

	const headerActions =
		activeTab === "settings" ? (
			// Settings: the header owns the add action only once destinations exist.
			// While empty, the empty-state CTA is the single add affordance (avoids a duplicate).
			isAdmin && Result.isSuccess(destinationsResult) && destinations.length > 0 ? (
				<Button size="sm" onClick={() => openDestinationDialog()}>
					<PlusIcon size={14} />
					Add destination
				</Button>
			) : undefined
		) : (
			<Button
				size="sm"
				render={<Link to="/alerts/create" search={{ serviceName: search.serviceName }} />}
			>
				<PlusIcon size={14} />
				New rule
			</Button>
		)

	return (
		<>
			<DashboardLayout
				breadcrumbs={[{ label: "Alerts" }]}
				titleContent={
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-2xl font-semibold tracking-tight truncate">Alerts</h1>
						</div>
						<p className="text-muted-foreground">
							Monitor your services and get notified when things go wrong.
						</p>
					</div>
				}
				headerActions={headerActions}
				stickyContent={tabBar}
			>
				<div className="space-y-6">
					{/* ─── Monitor Tab ─── */}
					{activeTab === "monitor" && (
						<MonitorTab
							rules={rules}
							incidents={incidents}
							deliveryEvents={deliveryEvents}
							loading={Result.isInitial(rulesResult) || Result.isInitial(incidentsResult)}
							selectedTags={selectedTags}
							grouped={groupByTagOn}
							onSelectedTagsChange={setSelectedTags}
							onGroupedChange={setGroupByTagOn}
						/>
					)}

					{/* ─── Rules Tab ─── */}
					{activeTab === "rules" && (
						<div className="space-y-4">
							<div className="flex items-center gap-3">
								<InputGroup className="flex-1 max-w-xs">
									<InputGroupAddon>
										<MagnifierIcon />
									</InputGroupAddon>
									<InputGroupInput
										placeholder="Search rules..."
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
									/>
									{searchQuery && (
										<InputGroupAddon align="inline-end">
											<InputGroupButton
												aria-label="Clear search"
												onClick={() => setSearchQuery("")}
											>
												<XmarkIcon />
											</InputGroupButton>
										</InputGroupAddon>
									)}
								</InputGroup>
								{showCreatorFilter && (
									<Select
										items={creatorOptions}
										value={creatorFilter}
										onValueChange={(value) =>
											navigate({
												search: (prev) => ({
													...prev,
													createdBy:
														value === ANY_CREATOR ? undefined : (value as string),
												}),
											})
										}
									>
										<SelectTrigger className="w-[170px]">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{Object.entries(creatorOptions).map(([value, label]) => (
												<SelectItem key={value} value={value}>
													<span className="block max-w-[160px] truncate">
														{label}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
								<AlertTagControls
									facets={ruleTagFacets}
									selected={selectedTags}
									onSelectedChange={setSelectedTags}
									grouped={groupByTagOn}
									onGroupedChange={setGroupByTagOn}
								/>
							</div>

							{Result.isInitial(rulesResult) ? (
								<div className="space-y-3">
									<Skeleton className="h-12 w-full" />
									<Skeleton className="h-12 w-full" />
									<Skeleton className="h-12 w-full" />
								</div>
							) : !Result.isSuccess(rulesResult) ? (
								<Empty className="py-12">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<CircleWarningIcon size={18} />
										</EmptyMedia>
										<EmptyTitle>Failed to load alert rules</EmptyTitle>
										<EmptyDescription>
											Refresh the page or check your connection.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : filteredRules.length === 0 && rules.length === 0 ? (
								<Empty className="py-12">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<BellIcon size={18} />
										</EmptyMedia>
										<EmptyTitle>No alert rules</EmptyTitle>
										<EmptyDescription>
											Create a threshold rule to open incidents for latency, error rate,
											throughput, Apdex, or exact metrics.
										</EmptyDescription>
									</EmptyHeader>
									{isAdmin && (
										<Button
											size="sm"
											render={
												<Link
													to="/alerts/create"
													search={{ serviceName: search.serviceName }}
												/>
											}
										>
											<PlusIcon size={14} />
											Add rule
										</Button>
									)}
								</Empty>
							) : filteredRules.length === 0 ? (
								<Empty className="py-12">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<MagnifierIcon size={18} />
										</EmptyMedia>
										<EmptyTitle>No rules match your filters</EmptyTitle>
										<EmptyDescription>
											Try a different search term, creator, or tag.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="w-[40px]" />
											<TableHead className="min-w-[200px]">Name</TableHead>
											<TableHead className="w-[110px]">Signal</TableHead>
											<TableHead className="w-[160px]">Scope</TableHead>
											<TableHead className="w-[180px]">Condition</TableHead>
											<TableHead className="w-[100px]">Severity</TableHead>
											<TableHead className="w-[110px]">Notify</TableHead>
											<TableHead className="w-[100px]">Status</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{ruleGroups
											? ruleGroups.map((group) => (
													<Fragment key={group.key}>
														<TagGroupHeaderRow
															label={group.label}
															count={group.count}
															noun="rule"
															colSpan={8}
														/>
														{group.items.map((rule) =>
															renderRuleRow(rule, `${group.key}:${rule.id}`),
														)}
													</Fragment>
												))
											: filteredRules.map((rule) => renderRuleRow(rule, rule.id))}
									</TableBody>
								</Table>
							)}
						</div>
					)}

					{/* ─── Settings Tab ─── */}
					{activeTab === "settings" && (
						<div className="space-y-8">
							{/* Destinations section */}
							<section className="space-y-4">
								<div>
									<h2 className="text-lg font-semibold">Destinations</h2>
									<p className="text-muted-foreground text-sm">
										Destinations are reusable across rules and keep provider retries and
										failures auditable.
									</p>
								</div>

								{Result.isInitial(destinationsResult) ? (
									<div className="space-y-3">
										<Skeleton className="h-24 w-full" />
										<Skeleton className="h-24 w-full" />
									</div>
								) : !Result.isSuccess(destinationsResult) ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<CircleWarningIcon size={18} />
											</EmptyMedia>
											<EmptyTitle>Failed to load alert destinations</EmptyTitle>
											<EmptyDescription>
												Refresh the page or check your connection.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								) : destinations.length === 0 ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<FireIcon size={18} />
											</EmptyMedia>
											<EmptyTitle>No destinations configured</EmptyTitle>
											<EmptyDescription>
												Add Slack, PagerDuty, or webhook destinations before creating
												alert rules.
											</EmptyDescription>
										</EmptyHeader>
										{isAdmin && (
											<Button size="sm" onClick={() => openDestinationDialog()}>
												<PlusIcon size={14} />
												Add destination
											</Button>
										)}
									</Empty>
								) : (
									<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
										{destinations.map((destination) => (
											<DestinationCard
												key={destination.id}
												destination={destination}
												isAdmin={isAdmin}
												isTesting={testingDestinationId === destination.id}
												isDeleting={deletingDestinationId === destination.id}
												onToggle={handleDestinationToggle}
												onTest={handleDestinationTest}
												onEdit={openDestinationDialog}
												onDelete={handleDestinationDelete}
											/>
										))}
									</div>
								)}
							</section>

							<Separator />

							{/* Delivery log section */}
							<section className="space-y-4">
								<div>
									<h2 className="text-lg font-semibold">Delivery log</h2>
									<p className="text-muted-foreground text-sm">
										Every queued, retried, and completed notification attempt across alert
										destinations.
									</p>
								</div>

								{Result.isInitial(deliveryEventsResult) ? (
									<div className="space-y-2">
										<Skeleton className="h-10 w-full" />
										<Skeleton className="h-10 w-full" />
										<Skeleton className="h-10 w-full" />
									</div>
								) : !Result.isSuccess(deliveryEventsResult) ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<CircleWarningIcon size={18} />
											</EmptyMedia>
											<EmptyTitle>Failed to load delivery history</EmptyTitle>
											<EmptyDescription>
												Refresh the page or check your connection.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								) : deliveryEvents.length === 0 ? (
									<Empty className="py-12">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<TruckIcon size={18} />
											</EmptyMedia>
											<EmptyTitle>No notifications sent yet</EmptyTitle>
											<EmptyDescription>
												Once rules start triggering, delivery attempts will show up
												here.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								) : (
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="w-[150px]">Status</TableHead>
												<TableHead className="w-[128px]">Event</TableHead>
												<TableHead className="w-[240px]">Destination</TableHead>
												<TableHead>Detail</TableHead>
												<TableHead className="w-[88px] text-right">Time</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{deliveryEventGroups.map((group) => (
												<Fragment key={group.key}>
													<TableRow>
														<TableCell
															colSpan={5}
															className="bg-muted/30 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
														>
															<span className="flex items-center gap-2">
																{group.label}
																<span className="tracking-normal normal-case text-muted-foreground/55">
																	{group.events.length}{" "}
																	{group.events.length === 1
																		? "attempt"
																		: "attempts"}
																</span>
															</span>
														</TableCell>
													</TableRow>
													{group.events.map((event) => {
														const ev = eventTypeMeta[event.eventType]
														const status = deliveryStatusMeta[event.status]
														return (
															<TableRow key={event.id}>
																<TableCell>
																	<span className="flex items-center gap-1.5">
																		<Badge
																			variant={status.variant}
																			size="sm"
																		>
																			{status.label}
																		</Badge>
																		{event.attemptNumber > 1 && (
																			<span
																				className="text-warning tabular-nums text-[11px]"
																				title={`Attempt ${event.attemptNumber}`}
																			>
																				↻{event.attemptNumber}
																			</span>
																		)}
																	</span>
																</TableCell>
																<TableCell>
																	<span
																		className={cn(
																			"flex items-center gap-1.5 text-xs font-medium",
																			ev.text,
																		)}
																	>
																		<span
																			className={cn(
																				"size-1.5 rounded-full",
																				ev.dot,
																			)}
																		/>
																		{ev.label}
																	</span>
																</TableCell>
																<TableCell>
																	<span className="flex items-center gap-2">
																		<ProviderLogo
																			type={event.destinationType}
																			size={32}
																			bare
																			className="flex shrink-0 items-center"
																		/>
																		<span className="truncate font-medium">
																			{event.destinationName}
																		</span>
																	</span>
																</TableCell>
																<TableCell className="max-w-0">
																	{event.status === "failed" ? (
																		<span className="block truncate text-xs text-destructive/90">
																			{event.errorMessage ??
																				"Delivery failed"}
																			{event.responseCode != null && (
																				<span className="text-muted-foreground">
																					{" · "}
																					{event.responseCode}
																				</span>
																			)}
																		</span>
																	) : event.providerReference ? (
																		<span className="block truncate text-xs text-muted-foreground">
																			{event.providerReference}
																		</span>
																	) : null}
																</TableCell>
																<TableCell className="text-right">
																	<Tooltip>
																		<TooltipTrigger
																			render={<span />}
																			className="cursor-default text-muted-foreground tabular-nums"
																		>
																			{formatAlertTime(
																				event.scheduledAt,
																			)}
																		</TooltipTrigger>
																		<TooltipContent>
																			{formatAlertDateTime(
																				event.scheduledAt,
																			)}
																		</TooltipContent>
																	</Tooltip>
																</TableCell>
															</TableRow>
														)
													})}
												</Fragment>
											))}
										</TableBody>
									</Table>
								)}
							</section>
						</div>
					)}
				</div>
			</DashboardLayout>

			<DestinationDialog
				open={destinationDialogOpen}
				onOpenChange={setDestinationDialogOpen}
				form={destinationForm}
				onFormChange={setDestinationForm}
				isEditing={editingDestination != null}
				saving={savingDestination}
				onSave={handleDestinationSave}
			/>
		</>
	)
}
