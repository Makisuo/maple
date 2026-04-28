import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	CreateScrapeTargetRequest,
	ScrapeIntervalSeconds,
	UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import type { ScrapeAuthType, ScrapeTargetId, ScrapeTargetResponse } from "@maple/domain/http"
import { useState } from "react"
import { Exit, Schema } from "effect"
import { toast } from "sonner"

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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import {
	CircleXmarkIcon,
	DotsVerticalIcon,
	FireIcon,
	LoaderIcon,
	PencilIcon,
	PlusIcon,
	PulseIcon,
	TrashIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"

type ScrapeTarget = ScrapeTargetResponse

const AUTH_TYPE_LABELS: Record<ScrapeAuthType, string> = {
	none: "None",
	bearer: "Bearer Token",
	basic: "Basic Auth",
}

const asScrapeIntervalSeconds = Schema.decodeUnknownSync(ScrapeIntervalSeconds)

export function ScrapeTargetsSection() {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [togglingId, setTogglingId] = useState<ScrapeTargetId | null>(null)
	const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<ScrapeTarget | null>(null)
	const [probingId, setProbingId] = useState<ScrapeTargetId | null>(null)

	const [editingTarget, setEditingTarget] = useState<ScrapeTarget | null>(null)
	const [formName, setFormName] = useState("")
	const [formServiceName, setFormServiceName] = useState("")
	const [formUrl, setFormUrl] = useState("")
	const [formInterval, setFormInterval] = useState("15")
	const [formAuthType, setFormAuthType] = useState<ScrapeAuthType>("none")
	const [formAuthToken, setFormAuthToken] = useState("")
	const [formAuthUsername, setFormAuthUsername] = useState("")
	const [formAuthPassword, setFormAuthPassword] = useState("")

	const listQueryAtom = MapleApiAtomClient.query("scrapeTargets", "list", {})
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

	async function handleProbe(target: ScrapeTarget) {
		setProbingId(target.id)
		const result = await probeMutation({ params: { targetId: target.id } })
		if (Exit.isSuccess(result)) {
			refreshTargets()
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
			if (!formAuthToken.trim()) {
				if (editingTarget?.hasCredentials && editingTarget.authType === "bearer") {
					return null
				}
				return null
			}
			return JSON.stringify({ token: formAuthToken.trim() })
		}
		if (formAuthType === "basic") {
			if (!formAuthUsername.trim() && !formAuthPassword.trim()) {
				if (editingTarget?.hasCredentials && editingTarget.authType === "basic") {
					return null
				}
				return null
			}
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

		setIsSaving(true)
		const authCredentials = buildAuthCredentials()
		const parsedInterval = asScrapeIntervalSeconds(Number.parseInt(formInterval, 10) || 15)

		if (editingTarget) {
			const result = await updateMutation({
				params: { targetId: editingTarget.id },
				payload: new UpdateScrapeTargetRequest({
					name: formName.trim(),
					url: formUrl.trim(),
					scrapeIntervalSeconds: parsedInterval,
					serviceName: formServiceName.trim() || null,
					authType: formAuthType,
					...(authCredentials !== null ? { authCredentials } : {}),
				}),
			})
			if (Exit.isSuccess(result)) {
				toast.success("Scrape target updated")
				setDialogOpen(false)
				refreshTargets()
			} else {
				toast.error("Failed to update scrape target")
			}
		} else {
			const result = await createMutation({
				payload: new CreateScrapeTargetRequest({
					name: formName.trim(),
					url: formUrl.trim(),
					scrapeIntervalSeconds: parsedInterval,
					serviceName: formServiceName.trim() || null,
					authType: formAuthType,
					...(authCredentials !== null ? { authCredentials } : {}),
				}),
			})
			if (Exit.isSuccess(result)) {
				toast.success("Scrape target created")
				setDialogOpen(false)
				refreshTargets()
			} else {
				toast.error("Failed to create scrape target")
			}
		}
		setIsSaving(false)
	}

	async function handleDelete(targetId: ScrapeTargetId) {
		setDeleteConfirmTarget(null)
		const result = await deleteMutation({ params: { targetId } })
		if (Exit.isSuccess(result)) {
			toast.success("Scrape target deleted")
			refreshTargets()
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
		})
		if (Exit.isSuccess(result)) {
			refreshTargets()
		} else {
			toast.error("Failed to update scrape target")
		}
		setTogglingId(null)
	}

	return (
		<>
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-sm">
						Scrape metrics from Prometheus exporter endpoints.
					</p>
					<Button size="sm" className="shrink-0" onClick={openAddDialog}>
						<PlusIcon size={14} />
						Add Target
					</Button>
				</div>

				{Result.isInitial(listResult) ? (
					<div className="space-y-2">
						<Skeleton className="h-[60px] w-full" />
						<Skeleton className="h-[60px] w-full" />
						<Skeleton className="h-[60px] w-full" />
					</div>
				) : !Result.isSuccess(listResult) ? (
					<div className="text-muted-foreground py-8 text-center text-sm">
						Failed to load scrape targets.
					</div>
				) : targets.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<FireIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No scrape targets</EmptyTitle>
							<EmptyDescription>
								Add a Prometheus exporter endpoint to start scraping metrics.
							</EmptyDescription>
						</EmptyHeader>
						<Button size="sm" onClick={openAddDialog}>
							<PlusIcon size={14} />
							Add Target
						</Button>
					</Empty>
				) : (
					<div className="divide-y">
						{targets.map((target) => (
							<div key={target.id} className="flex items-center gap-3 px-1 py-3">
								<div
									className={cn(
										"size-2 shrink-0 rounded-full",
										!target.enabled
											? "bg-muted-foreground/30"
											: target.lastScrapeError
												? "bg-destructive"
												: target.lastScrapeAt
													? "bg-severity-info"
													: "bg-severity-warn",
									)}
								/>

								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">{target.name}</span>
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
									<div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 text-xs">
										<span className="max-w-[300px] truncate font-mono">{target.url}</span>
										<span>{target.scrapeIntervalSeconds}s interval</span>
										{target.lastScrapeAt && (
											<span>
												Last scraped {formatRelativeTime(target.lastScrapeAt)}
											</span>
										)}
									</div>
									{target.lastScrapeError && (
										<div className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
											<CircleXmarkIcon size={12} className="shrink-0" />
											<span className="truncate">{target.lastScrapeError}</span>
										</div>
									)}
								</div>

								<Switch
									checked={target.enabled}
									onCheckedChange={() => handleToggleEnabled(target)}
									disabled={togglingId === target.id}
								/>

								<Button
									variant="outline"
									size="sm"
									onClick={() => handleProbe(target)}
									disabled={probingId === target.id}
								>
									{probingId === target.id ? (
										<LoaderIcon size={14} className="animate-spin" />
									) : (
										<PulseIcon size={14} />
									)}
									Test
								</Button>

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
										<DropdownMenuItem onClick={() => openEditDialog(target)}>
											<PencilIcon size={14} />
											Edit
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setDeleteConfirmTarget(target)}
										>
											<TrashIcon size={14} />
											Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Add / Edit Dialog */}
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
					<div className="space-y-4 py-2">
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

			{/* Delete Confirmation */}
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
							onClick={() => {
								if (deleteConfirmTarget) {
									void handleDelete(deleteConfirmTarget.id)
								}
							}}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
