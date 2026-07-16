import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	CreateScrapeTargetRequest,
	ScrapeIntervalSeconds,
	UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import type {
	ScrapeAuthType,
	ScrapeTargetCheckResponse,
	ScrapeTargetChecksListResponse,
	ScrapeTargetId,
	ScrapeTargetResponse,
} from "@maple/domain/http"
import { useState, type KeyboardEvent, type ReactNode } from "react"
import { Exit, Schema } from "effect"
import { toast } from "sonner"

import { useScrapeTargetChecks } from "@/hooks/use-scrape-target-checks"

import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"
import {
	BellIcon,
	BoltIcon,
	ChartBarIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
	DotsVerticalIcon,
	ExternalLinkIcon,
	FireIcon,
	HistoryIcon,
	LoaderIcon,
	PencilIcon,
	PlusIcon,
	PulseIcon,
	TrashIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatDuration, formatNumber, formatRelativeTime } from "@/lib/format"
import { diagnoseScrapeError } from "@/lib/scrape-error-diagnosis"
import { catalogEntry } from "../integrations/integration-catalog"
import { IntegrationEmptyState } from "../integrations/integration-empty-state"

type ScrapeTarget = ScrapeTargetResponse
type ScrapeTargetCheck = ScrapeTargetCheckResponse
type ScrapeTargetChecksResult = Result.Result<ScrapeTargetChecksListResponse, unknown>

const AUTH_TYPE_LABELS: Record<ScrapeAuthType, string> = {
	none: "None",
	bearer: "Bearer Token",
	basic: "Basic Auth",
	token: "Service Token",
	planetscale_oauth: "PlanetScale OAuth",
}

const asScrapeIntervalSeconds = Schema.decodeUnknownSync(ScrapeIntervalSeconds)

function formatDurationSeconds(value: number | null): string {
	if (value == null) return "-"
	return formatDuration(value * 1000)
}

function formatOptionalCount(value: number | null): string {
	if (value == null) return "-"
	return formatNumber(Math.round(value))
}

function formatDateTime(value: string): string {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

function hostnameFromUrl(value: string): string {
	try {
		return new URL(value).host
	} catch {
		return value
	}
}

function labelEntries(labelsJson: string | null): Array<[string, string]> {
	if (!labelsJson) return []
	try {
		const parsed = JSON.parse(labelsJson) as unknown
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
		return Object.entries(parsed).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		)
	} catch {
		return []
	}
}

function checksFromResult(result: ScrapeTargetChecksResult): ScrapeTargetCheck[] {
	return Result.builder(result)
		.onSuccess((response) => [...response.checks] as ScrapeTargetCheck[])
		.orElse(() => [])
}

function scheduledStatus(
	target: ScrapeTarget,
	latestCheck: ScrapeTargetCheck | null,
	isLoading: boolean,
	checksUnavailable: boolean,
) {
	if (!target.enabled) {
		return {
			label: "Disabled",
			detail: "Collector skips this target",
			dotClass: "bg-muted-foreground/30",
			badgeVariant: "outline" as const,
		}
	}
	if (isLoading) {
		return {
			label: "Checking",
			detail: "Loading scheduled history",
			dotClass: "bg-muted-foreground/40",
			badgeVariant: "outline" as const,
		}
	}
	if (checksUnavailable) {
		return {
			label: "Unavailable",
			detail: "Failed to load scheduled checks",
			dotClass: "bg-muted-foreground/40",
			badgeVariant: "outline" as const,
		}
	}
	if (!latestCheck) {
		return {
			label: "No checks",
			detail: "No scheduled scrape observed",
			dotClass: "bg-severity-warn",
			badgeVariant: "warning" as const,
		}
	}
	if (latestCheck.success) {
		return {
			label: "Up",
			detail: `Scheduled ${formatRelativeTime(latestCheck.timestamp)}`,
			dotClass: "bg-severity-info",
			badgeVariant: "success" as const,
		}
	}
	return {
		label: "Down",
		detail: `Scheduled ${formatRelativeTime(latestCheck.timestamp)}`,
		dotClass: "bg-destructive",
		badgeVariant: "error" as const,
	}
}

const COPY = {
	description: "Scrape Prometheus exporters and inspect scheduled scrape health.",
	emptyTitle: "No scrape targets",
	emptyDescription: "Add a Prometheus exporter endpoint to start scraping metrics.",
	features: [
		{
			icon: ChartBarIcon,
			title: "Metrics explorer",
			description: "Scraped metrics land alongside your OTel metrics, ready to chart.",
		},
		{
			icon: BellIcon,
			title: "Dashboards & alerts",
			description: "Build dashboard widgets and threshold alerts on any scraped metric.",
		},
		{
			icon: PulseIcon,
			title: "Scrape health",
			description: "Every run is checked on a schedule, with per-target history.",
		},
	],
} as const

/**
 * Prometheus scrape-target manager. PlanetScale metrics collection is fully
 * managed by its integration and never surfaces here — this section only
 * lists and edits user-created prometheus targets.
 */
export function ScrapeTargetsSection({
	sourceFilter = "prometheus",
}: {
	sourceFilter?: "prometheus"
} = {}) {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [togglingId, setTogglingId] = useState<ScrapeTargetId | null>(null)
	const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<ScrapeTarget | null>(null)
	const [probingId, setProbingId] = useState<ScrapeTargetId | null>(null)
	const [selectedTargetId, setSelectedTargetId] = useState<ScrapeTargetId | null>(null)

	const [editingTarget, setEditingTarget] = useState<ScrapeTarget | null>(null)
	const [formName, setFormName] = useState("")
	const [formServiceName, setFormServiceName] = useState("")
	const [formUrl, setFormUrl] = useState("")
	const [formInterval, setFormInterval] = useState("15")
	const [formAuthType, setFormAuthType] = useState<ScrapeAuthType>("none")
	const [formAuthToken, setFormAuthToken] = useState("")
	const [formAuthUsername, setFormAuthUsername] = useState("")
	const [formAuthPassword, setFormAuthPassword] = useState("")

	const listQueryAtom = MapleApiAtomClient.query("scrapeTargets", "list", {
		reactivityKeys: ["scrapeTargets"],
	})
	const listResult = useAtomValue(listQueryAtom)
	const refreshTargets = useAtomRefresh(listQueryAtom)

	const createMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "create"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "update"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "delete"), {
		mode: "promiseExit",
	})
	const probeMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "probe"), {
		mode: "promiseExit",
	})

	const targets = Result.builder(listResult)
		.onSuccess((response) => [...response.targets] as ScrapeTarget[])
		.orElse(() => [])
		.filter((target) => target.targetType === sourceFilter)
	const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null
	const copy = COPY
	// When empty, the centered empty state owns the primary action — hide the toolbar row.
	const isEmpty = Result.isSuccess(listResult) && targets.length === 0
	const emptyEntry = catalogEntry(sourceFilter)

	async function handleProbe(target: ScrapeTarget) {
		setProbingId(target.id)
		const result = await probeMutation({
			params: { targetId: target.id },
			reactivityKeys: ["scrapeTargets"],
		})
		if (Exit.isSuccess(result)) {
			if (result.value.success) {
				toast.success("Connection successful")
			} else {
				toast.error(`Connection failed: ${result.value.lastScrapeError}`)
			}
		} else {
			toast.error("Failed to test connection")
		}
		setProbingId(null)
	}

	function openAddDialog() {
		setEditingTarget(null)
		setFormName("")
		setFormServiceName("")
		setFormUrl("")
		setFormInterval("15")
		setFormAuthType("none")
		setFormAuthToken("")
		setFormAuthUsername("")
		setFormAuthPassword("")
		setDialogOpen(true)
	}

	function openEditDialog(target: ScrapeTarget) {
		setEditingTarget(target)
		setFormName(target.name)
		setFormServiceName(target.serviceName ?? "")
		setFormUrl(target.url)
		setFormInterval(String(target.scrapeIntervalSeconds))
		setFormAuthType(target.authType)
		setFormAuthToken("")
		setFormAuthUsername("")
		setFormAuthPassword("")
		setDialogOpen(true)
	}

	function buildAuthCredentials(): string | null {
		if (formAuthType === "bearer") {
			if (!formAuthToken.trim()) return null
			return JSON.stringify({ token: formAuthToken.trim() })
		}
		if (formAuthType === "basic") {
			if (!formAuthUsername.trim() && !formAuthPassword.trim()) return null
			return JSON.stringify({
				username: formAuthUsername.trim(),
				password: formAuthPassword.trim(),
			})
		}
		return null
	}

	async function handleSave() {
		if (!formName.trim() || !formUrl.trim()) {
			toast.error("Name and URL are required")
			return
		}

		let parsedInterval: ScrapeIntervalSeconds
		try {
			parsedInterval = asScrapeIntervalSeconds(Number.parseInt(formInterval, 10) || 15)
		} catch {
			toast.error("Scrape interval must be an integer from 5 to 300 seconds")
			return
		}

		const authCredentials = buildAuthCredentials()

		setIsSaving(true)

		if (editingTarget) {
			const result = await updateMutation({
				params: { targetId: editingTarget.id },
				payload: new UpdateScrapeTargetRequest({
					name: formName.trim(),
					scrapeIntervalSeconds: parsedInterval,
					serviceName: formServiceName.trim() || null,
					url: formUrl.trim(),
					authType: formAuthType,
					...(authCredentials !== null ? { authCredentials } : {}),
				}),
				reactivityKeys: ["scrapeTargets"],
			})
			if (Exit.isSuccess(result)) {
				toast.success("Scrape target updated")
				setDialogOpen(false)
			} else {
				toast.error("Failed to update scrape target")
			}
		} else {
			const result = await createMutation({
				payload: new CreateScrapeTargetRequest({
					name: formName.trim(),
					scrapeIntervalSeconds: parsedInterval,
					serviceName: formServiceName.trim() || null,
					url: formUrl.trim(),
					authType: formAuthType,
					...(authCredentials !== null ? { authCredentials } : {}),
				}),
				reactivityKeys: ["scrapeTargets"],
			})
			if (Exit.isSuccess(result)) {
				toast.success("Scrape target created")
				setDialogOpen(false)
				setSelectedTargetId(result.value.id)
			} else {
				toast.error("Failed to create scrape target")
			}
		}
		setIsSaving(false)
	}

	async function handleDelete(targetId: ScrapeTargetId) {
		setDeleteConfirmTarget(null)
		const result = await deleteMutation({
			params: { targetId },
			reactivityKeys: ["scrapeTargets"],
		})
		if (Exit.isSuccess(result)) {
			toast.success("Scrape target deleted")
			if (selectedTargetId === targetId) setSelectedTargetId(null)
		} else {
			toast.error("Failed to delete scrape target")
		}
	}

	async function handleToggleEnabled(target: ScrapeTarget) {
		setTogglingId(target.id)
		const result = await updateMutation({
			params: { targetId: target.id },
			payload: new UpdateScrapeTargetRequest({
				enabled: !target.enabled,
			}),
			reactivityKeys: ["scrapeTargets"],
		})
		if (!Exit.isSuccess(result)) {
			toast.error("Failed to update scrape target")
		}
		setTogglingId(null)
	}

	return (
		<>
			<div className="space-y-4">
				{!isEmpty && (
					<div className="flex items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm">{copy.description}</p>
						<Button size="sm" className="shrink-0" onClick={openAddDialog}>
							<PlusIcon size={14} />
							Add Target
						</Button>
					</div>
				)}

				{Result.isInitial(listResult) ? (
					<div className="space-y-2">
						<Skeleton className="h-[60px] w-full" />
						<Skeleton className="h-[60px] w-full" />
						<Skeleton className="h-[60px] w-full" />
					</div>
				) : !Result.isSuccess(listResult) ? (
					<div className="text-muted-foreground flex flex-col items-center gap-3 py-8 text-center text-sm">
						Failed to load scrape targets.
						<Button variant="outline" size="sm" onClick={() => refreshTargets()}>
							Try again
						</Button>
					</div>
				) : targets.length === 0 ? (
					<IntegrationEmptyState
						icon={emptyEntry?.icon ?? FireIcon}
						accent={emptyEntry?.accent ?? "#E6522C"}
						iconClassName={emptyEntry?.iconClassName}
						title={copy.emptyTitle}
						description={copy.emptyDescription}
						features={copy.features}
					>
						<Button onClick={openAddDialog}>
							<PlusIcon size={16} />
							Add Target
						</Button>
					</IntegrationEmptyState>
				) : (
					<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{targets.map((target) => (
								<ScrapeTargetRow
									key={target.id}
									target={target}
									selected={target.id === selectedTarget?.id}
									toggling={togglingId === target.id}
									probing={probingId === target.id}
									onSelect={setSelectedTargetId}
									onProbe={handleProbe}
									onToggle={handleToggleEnabled}
									onEdit={openEditDialog}
									onDelete={setDeleteConfirmTarget}
								/>
							))}
						</div>
						{selectedTarget ? (
							<ScrapeTargetDetails
								target={selectedTarget}
								probing={probingId === selectedTarget.id}
								toggling={togglingId === selectedTarget.id}
								onProbe={handleProbe}
								onToggle={handleToggleEnabled}
								onEdit={openEditDialog}
								onDelete={setDeleteConfirmTarget}
							/>
						) : (
							<div className="hidden rounded-lg border bg-card p-4 lg:block">
								<div className="text-muted-foreground flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-xs">
									<CircleInfoIcon size={18} />
									<span>Click a target to inspect scheduled checks.</span>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{editingTarget ? "Edit Scrape Target" : "Add Scrape Target"}
						</DialogTitle>
						<DialogDescription>
							{editingTarget
								? "Update the scrape target configuration."
								: "Enter the URL of a Prometheus exporter endpoint. Maple will periodically scrape this endpoint for metrics."}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6 py-2">
						<div className="space-y-2">
							<Label htmlFor="scrape-name">Name</Label>
							<Input
								id="scrape-name"
								placeholder="e.g. Node Exporter"
								value={formName}
								onChange={(e) => setFormName(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="scrape-service-name">Service Name</Label>
							<Input
								id="scrape-service-name"
								placeholder="e.g. my-api-server"
								value={formServiceName}
								onChange={(e) => setFormServiceName(e.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								Metrics will appear under this service name. Defaults to the target name if
								empty.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="scrape-url">URL</Label>
							<Input
								id="scrape-url"
								placeholder="e.g. https://myapp.com:9090/metrics"
								value={formUrl}
								onChange={(e) => setFormUrl(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="scrape-interval">Scrape Interval (seconds)</Label>
							<Input
								id="scrape-interval"
								type="number"
								min={5}
								max={300}
								value={formInterval}
								onChange={(e) => setFormInterval(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Authentication</Label>
							<Select
								items={{ none: "None", bearer: "Bearer Token", basic: "Basic Auth" }}
								value={formAuthType}
								onValueChange={(val: string | null) => {
									setFormAuthType((val as ScrapeAuthType | null) ?? "none")
									setFormAuthToken("")
									setFormAuthUsername("")
									setFormAuthPassword("")
								}}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select auth type" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">None</SelectItem>
									<SelectItem value="bearer">Bearer Token</SelectItem>
									<SelectItem value="basic">Basic Auth</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{formAuthType === "bearer" && (
							<div className="space-y-2">
								<Label htmlFor="scrape-auth-token">Bearer Token</Label>
								<Input
									id="scrape-auth-token"
									type="password"
									placeholder={
										editingTarget?.hasCredentials && editingTarget.authType === "bearer"
											? "Leave blank to keep existing"
											: "Enter bearer token"
									}
									value={formAuthToken}
									onChange={(e) => setFormAuthToken(e.target.value)}
								/>
							</div>
						)}
						{formAuthType === "basic" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="scrape-auth-username">Username</Label>
									<Input
										id="scrape-auth-username"
										placeholder={
											editingTarget?.hasCredentials &&
											editingTarget.authType === "basic"
												? "Leave blank to keep existing"
												: "Enter username"
										}
										value={formAuthUsername}
										onChange={(e) => setFormAuthUsername(e.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="scrape-auth-password">Password</Label>
									<Input
										id="scrape-auth-password"
										type="password"
										placeholder={
											editingTarget?.hasCredentials &&
											editingTarget.authType === "basic"
												? "Leave blank to keep existing"
												: "Enter password"
										}
										value={formAuthPassword}
										onChange={(e) => setFormAuthPassword(e.target.value)}
									/>
								</div>
							</>
						)}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
							Cancel
						</Button>
						<Button onClick={handleSave} disabled={isSaving}>
							{isSaving ? (
								<>
									<LoaderIcon size={14} className="animate-spin" />
									{editingTarget ? "Saving..." : "Adding..."}
								</>
							) : editingTarget ? (
								"Save Changes"
							) : (
								"Add Target"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={deleteConfirmTarget !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirmTarget(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete scrape target</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete{" "}
							<span className="font-medium text-foreground">{deleteConfirmTarget?.name}</span>?
							This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (deleteConfirmTarget) {
									void handleDelete(deleteConfirmTarget.id)
								}
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

function ScrapeTargetRow({
	target,
	selected,
	toggling,
	probing,
	onSelect,
	onProbe,
	onToggle,
	onEdit,
	onDelete,
}: {
	target: ScrapeTarget
	selected: boolean
	toggling: boolean
	probing: boolean
	onSelect: (targetId: ScrapeTargetId) => void
	onProbe: (target: ScrapeTarget) => void
	onToggle: (target: ScrapeTarget) => void
	onEdit: (target: ScrapeTarget) => void
	onDelete: (target: ScrapeTarget) => void
}) {
	const { result: latestCheckResult } = useScrapeTargetChecks(target.id, 1)
	const latestCheck = checksFromResult(latestCheckResult).at(0) ?? null
	const status = scheduledStatus(
		target,
		latestCheck,
		Result.isInitial(latestCheckResult),
		Result.isFailure(latestCheckResult),
	)

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			onSelect(target.id)
		}
	}

	return (
		<div
			role="button"
			tabIndex={0}
			aria-pressed={selected}
			onClick={() => onSelect(target.id)}
			onKeyDown={handleKeyDown}
			className={cn(
				"flex cursor-pointer items-center gap-3 px-3 py-3 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50",
				selected && "bg-muted/60",
			)}
		>
			<div className={cn("size-2 shrink-0 rounded-full", status.dotClass)} />

			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-medium">{target.name}</span>
					<Badge variant={status.badgeVariant} className="shrink-0">
						{status.label}
					</Badge>
					{target.serviceName && (
						<Badge variant="outline" className="shrink-0">
							{target.serviceName}
						</Badge>
					)}
					{target.authType !== "none" && (
						<Badge variant="outline" className="shrink-0">
							{AUTH_TYPE_LABELS[target.authType] ?? target.authType}
						</Badge>
					)}
				</div>
				<div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					<span className="max-w-[280px] truncate font-mono">{hostnameFromUrl(target.url)}</span>
					<span>{target.scrapeIntervalSeconds}s interval</span>
					<span>{status.detail}</span>
					{target.lastScrapeAt && (
						<span>Last scrape {formatRelativeTime(target.lastScrapeAt)}</span>
					)}
				</div>
				{latestCheck?.message && !latestCheck.success && (
					<Tooltip>
						<TooltipTrigger
							render={<div />}
							className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive"
						>
							<CircleXmarkIcon size={12} className="shrink-0" />
							<span className="truncate">{latestCheck.message}</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs font-mono text-xs">
							{latestCheck.message}
						</TooltipContent>
					</Tooltip>
				)}
				{target.lastScrapeError && (
					<Tooltip>
						<TooltipTrigger
							render={<div />}
							className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
						>
							<CircleInfoIcon size={12} className="shrink-0" />
							<span className="truncate">Last scrape: {target.lastScrapeError}</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs font-mono text-xs">
							{target.lastScrapeError}
						</TooltipContent>
					</Tooltip>
				)}
			</div>

			<div onClick={(event) => event.stopPropagation()}>
				<Switch
					checked={target.enabled}
					onCheckedChange={() => onToggle(target)}
					disabled={toggling}
				/>
			</div>

			<Button
				variant="outline"
				size="sm"
				onClick={(event) => {
					event.stopPropagation()
					onProbe(target)
				}}
				disabled={probing}
			>
				{probing ? <LoaderIcon size={14} className="animate-spin" /> : <BoltIcon size={14} />}
				Test
			</Button>

			<div onClick={(event) => event.stopPropagation()}>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								className="text-muted-foreground hover:text-foreground shrink-0"
							/>
						}
					>
						<DotsVerticalIcon size={14} />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{/* Managed targets are edited/removed through the owning integration card. */}
						<DropdownMenuItem disabled={target.managedBy != null} onClick={() => onEdit(target)}>
							<PencilIcon size={14} />
							Edit
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							disabled={target.managedBy != null}
							onClick={() => onDelete(target)}
						>
							<TrashIcon size={14} />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	)
}

function ScrapeTargetDetails({
	target,
	probing,
	toggling,
	onProbe,
	onToggle,
	onEdit,
	onDelete,
}: {
	target: ScrapeTarget
	probing: boolean
	toggling: boolean
	onProbe: (target: ScrapeTarget) => void
	onToggle: (target: ScrapeTarget) => void
	onEdit: (target: ScrapeTarget) => void
	onDelete: (target: ScrapeTarget) => void
}) {
	const { result: checksResult } = useScrapeTargetChecks(target.id, 20)
	const checks = checksFromResult(checksResult)
	const latestCheck = checks.at(0) ?? null
	const status = scheduledStatus(
		target,
		latestCheck,
		Result.isInitial(checksResult),
		Result.isFailure(checksResult),
	)
	const labels = labelEntries(target.labelsJson)

	// Diagnose the freshest failure: the latest failed check, falling back to the
	// target-level rollup error. Healthy targets show no banner.
	const failureMessage =
		latestCheck && !latestCheck.success ? latestCheck.message : target.lastScrapeError
	const diagnosis = diagnoseScrapeError(failureMessage, target.targetType)

	return (
		<aside className="rounded-lg border bg-card">
			<div className="space-y-3 border-b p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<div className={cn("size-2 rounded-full", status.dotClass)} />
							<h3 className="truncate text-sm font-semibold">{target.name}</h3>
						</div>
						<p className="text-muted-foreground mt-1 truncate font-mono text-xs">{target.url}</p>
					</div>
					<Badge variant={status.badgeVariant}>{status.label}</Badge>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => onProbe(target)} disabled={probing}>
						{probing ? <LoaderIcon size={14} className="animate-spin" /> : <BoltIcon size={14} />}
						Test
					</Button>
					{/* Managed targets are edited/removed through the owning integration card. */}
					<Button
						variant="outline"
						size="sm"
						onClick={() => onEdit(target)}
						disabled={target.managedBy != null}
					>
						<PencilIcon size={14} />
						Edit
					</Button>
					<Button variant="ghost" size="sm" onClick={() => onToggle(target)} disabled={toggling}>
						{target.enabled ? "Disable" : "Enable"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive"
						onClick={() => onDelete(target)}
						disabled={target.managedBy != null}
					>
						<TrashIcon size={14} />
						Delete
					</Button>
				</div>
			</div>

			<div className="space-y-5 p-4">
				{diagnosis && (
					<Alert variant={diagnosis.severity}>
						<CircleWarningIcon size={16} />
						<AlertTitle>{diagnosis.title}</AlertTitle>
						<AlertDescription>
							<p>{diagnosis.summary}</p>
							<div className="space-y-1">
								<p className="font-medium text-foreground">How to fix</p>
								<ul className="list-disc space-y-0.5 pl-4">
									{diagnosis.fixes.map((fix) => (
										<li key={fix}>{fix}</li>
									))}
								</ul>
							</div>
							{failureMessage && (
								<p className="font-mono text-[0.7rem] text-muted-foreground/80">
									{failureMessage}
								</p>
							)}
						</AlertDescription>
					</Alert>
				)}

				<section className="space-y-2">
					<div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
						<PulseIcon size={13} />
						Scheduled Scrape
					</div>
					<div className="grid grid-cols-2 gap-2 text-xs">
						<MetricBox label="Interval" value={`${target.scrapeIntervalSeconds}s`} />
						<MetricBox
							label="Duration"
							value={latestCheck ? formatDurationSeconds(latestCheck.durationSeconds) : "-"}
						/>
						<MetricBox
							label="Samples"
							value={latestCheck ? formatOptionalCount(latestCheck.samplesScraped) : "-"}
						/>
						<MetricBox
							label="Post relabel"
							value={
								latestCheck
									? formatOptionalCount(latestCheck.samplesPostMetricRelabeling)
									: "-"
							}
						/>
					</div>
				</section>

				<section className="space-y-2">
					<div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
						<ExternalLinkIcon size={13} />
						Target
					</div>
					<div className="divide-y rounded-md border bg-background/35 text-xs">
						<DetailRow label="Service" value={target.serviceName ?? target.name} />
						<DetailRow label="Instance" value={hostnameFromUrl(target.url)} />
						<DetailRow
							label="Auth"
							value={AUTH_TYPE_LABELS[target.authType] ?? target.authType}
						/>
						<DetailRow label="Target ID" value={<span className="font-mono">{target.id}</span>} />
						<DetailRow label="Created" value={formatDateTime(target.createdAt)} />
						<DetailRow label="Updated" value={formatDateTime(target.updatedAt)} />
					</div>
					{labels.length > 0 && (
						<div className="flex flex-wrap gap-1.5 pt-1">
							{labels.map(([key, value]) => (
								<Badge key={key} variant="outline" className="max-w-full">
									<span className="truncate font-mono">
										{key}={value}
									</span>
								</Badge>
							))}
						</div>
					)}
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
							<HistoryIcon size={13} />
							Check History
						</div>
						{latestCheck && (
							<span className="text-muted-foreground text-xs">
								Latest {formatRelativeTime(latestCheck.timestamp)}
							</span>
						)}
					</div>
					<ChecksTable result={checksResult} checks={checks} />
				</section>
			</div>
		</aside>
	)
}

function MetricBox({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border bg-background/35 px-3 py-2">
			<div className="text-muted-foreground text-[0.65rem] uppercase">{label}</div>
			<div className="mt-1 font-mono text-sm">{value}</div>
		</div>
	)
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 px-3 py-2">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-right">{value}</span>
		</div>
	)
}

function ChecksTable({ result, checks }: { result: ScrapeTargetChecksResult; checks: ScrapeTargetCheck[] }) {
	if (Result.isInitial(result)) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-8 w-full" />
				<Skeleton className="h-8 w-full" />
				<Skeleton className="h-8 w-full" />
			</div>
		)
	}
	if (!Result.isSuccess(result)) {
		return (
			<div className="rounded-md border bg-background/35 px-3 py-6 text-center text-xs text-muted-foreground">
				Failed to load scheduled checks.
			</div>
		)
	}
	if (checks.length === 0) {
		return (
			<div className="rounded-md border bg-background/35 px-3 py-6 text-center text-xs text-muted-foreground">
				No scheduled checks recorded yet.
			</div>
		)
	}

	return (
		<div className="overflow-hidden rounded-md border bg-background/35">
			<div className="grid grid-cols-[minmax(100px,1fr)_64px_70px_72px] gap-2 border-b px-3 py-2 text-[0.65rem] uppercase text-muted-foreground">
				<span>Time</span>
				<span>State</span>
				<span>Duration</span>
				<span>Samples</span>
			</div>
			<div className="divide-y">
				{checks.map((check) => (
					<div
						key={`${check.timestamp}-${check.subTargetKey ?? ""}`}
						className="grid grid-cols-[minmax(100px,1fr)_64px_70px_72px] items-center gap-2 px-3 py-2 text-xs"
					>
						<div className="min-w-0">
							<div className="truncate font-mono">{formatDateTime(check.timestamp)}</div>
							{check.message && (
								<Tooltip>
									<TooltipTrigger
										render={<div />}
										className="text-muted-foreground mt-0.5 cursor-default truncate"
									>
										{check.message}
									</TooltipTrigger>
									<TooltipContent className="max-w-xs font-mono text-xs">
										{check.message}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
						<div className="flex items-center gap-1.5">
							{check.success ? (
								<CircleCheckIcon size={12} className="text-success-foreground" />
							) : (
								<CircleXmarkIcon size={12} className="text-destructive" />
							)}
							<span>{check.success ? "up" : "down"}</span>
						</div>
						<span className="font-mono">{formatDurationSeconds(check.durationSeconds)}</span>
						<span className="font-mono">{formatOptionalCount(check.samplesScraped)}</span>
					</div>
				))}
			</div>
		</div>
	)
}
