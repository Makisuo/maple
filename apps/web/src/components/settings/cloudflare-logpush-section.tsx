import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Exit } from "effect"
import type {
	CloudflareLogpushConnectorId,
	CloudflareLogpushConnectorResponse,
	CloudflareLogpushSetupResponse,
} from "@maple/domain/http"
import {
	CreateCloudflareLogpushConnectorRequest,
	UpdateCloudflareLogpushConnectorRequest,
} from "@maple/domain/http"
import { useMemo, useState } from "react"
import { toast } from "sonner"

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
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import {
	AlertWarningIcon,
	CheckIcon,
	CopyIcon,
	DotsVerticalIcon,
	EyeIcon,
	KeyIcon,
	LoaderIcon,
	PencilIcon,
	PlusIcon,
	ShieldIcon,
	TrashIcon,
} from "@/components/icons"

type CloudflareConnector = CloudflareLogpushConnectorResponse
type CloudflareSetup = CloudflareLogpushSetupResponse

function CopyableField({
	label,
	value,
	copied,
	onCopy,
}: {
	label: string
	value: string
	copied: boolean
	onCopy: () => void
}) {
	return (
		<div className="space-y-1">
			<label className="text-muted-foreground text-xs">{label}</label>
			<InputGroup>
				<InputGroupInput readOnly value={value} className="font-mono text-xs select-all" />
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						onClick={onCopy}
						aria-label={`Copy ${label.toLowerCase()}`}
						title={copied ? "Copied!" : "Copy"}
					>
						{copied ? (
							<CheckIcon size={14} className="text-severity-info" />
						) : (
							<CopyIcon size={14} />
						)}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		</div>
	)
}

export function CloudflareLogpushSection() {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [setupDialogOpen, setSetupDialogOpen] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [deletingConnector, setDeletingConnector] = useState<CloudflareConnector | null>(null)
	const [editingConnector, setEditingConnector] = useState<CloudflareConnector | null>(null)
	const [togglingId, setTogglingId] = useState<CloudflareLogpushConnectorId | null>(null)
	const [rotatingId, setRotatingId] = useState<CloudflareLogpushConnectorId | null>(null)
	const [setupConnectorId, setSetupConnectorId] = useState<CloudflareLogpushConnectorId | null>(null)
	const [setupConnectorName, setSetupConnectorName] = useState<string>("")
	const [setupOverride, setSetupOverride] = useState<CloudflareSetup | null>(null)
	const [copiedField, setCopiedField] = useState<string | null>(null)
	const [formName, setFormName] = useState("")
	const [formZoneName, setFormZoneName] = useState("")
	const [formServiceName, setFormServiceName] = useState("")
	const [formEnabled, setFormEnabled] = useState(true)

	const listQueryAtom = MapleApiAtomClient.query("cloudflareLogpush", "list", {})
	const listResult = useAtomValue(listQueryAtom)
	const refreshConnectors = useAtomRefresh(listQueryAtom)

	const setupQueryAtom = setupConnectorId
		? MapleApiAtomClient.query("cloudflareLogpush", "getSetup", {
				params: { connectorId: setupConnectorId },
			})
		: disabledResultAtom<CloudflareLogpushSetupResponse>()
	const setupResult = useAtomValue(setupQueryAtom)

	const createMutation = useAtomSet(MapleApiAtomClient.mutation("cloudflareLogpush", "create"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiAtomClient.mutation("cloudflareLogpush", "update"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("cloudflareLogpush", "delete"), {
		mode: "promiseExit",
	})
	const rotateMutation = useAtomSet(MapleApiAtomClient.mutation("cloudflareLogpush", "rotateSecret"), {
		mode: "promiseExit",
	})

	const connectors = Result.builder(listResult)
		.onSuccess((response) => [...response.connectors] as CloudflareConnector[])
		.orElse(() => [])

	const setup = useMemo(() => {
		if (setupOverride && setupOverride.connectorId === setupConnectorId) {
			return setupOverride
		}

		return Result.builder(setupResult)
			.onSuccess((response) => response)
			.orElse(() => null)
	}, [setupConnectorId, setupOverride, setupResult])

	async function copyToClipboard(value: string, fieldKey: string, label: string) {
		try {
			await navigator.clipboard.writeText(value)
			setCopiedField(fieldKey)
			toast.success(`${label} copied to clipboard`)
			setTimeout(() => {
				setCopiedField((current) => (current === fieldKey ? null : current))
			}, 2000)
		} catch {
			toast.error(`Failed to copy ${label.toLowerCase()}`)
		}
	}

	function resetForm() {
		setFormName("")
		setFormZoneName("")
		setFormServiceName("")
		setFormEnabled(true)
	}

	function openAddDialog() {
		setEditingConnector(null)
		resetForm()
		setDialogOpen(true)
	}

	function openEditDialog(connector: CloudflareConnector) {
		setEditingConnector(connector)
		setFormName(connector.name)
		setFormZoneName(connector.zoneName)
		setFormServiceName(connector.serviceName)
		setFormEnabled(connector.enabled)
		setDialogOpen(true)
	}

	function openSetupDialog(connector: CloudflareConnector, nextSetup?: CloudflareSetup) {
		setSetupConnectorId(connector.id)
		setSetupConnectorName(connector.name)
		setSetupOverride(nextSetup ?? null)
		setCopiedField(null)
		setSetupDialogOpen(true)
	}

	async function handleSave() {
		if (!formName.trim() || !formZoneName.trim()) {
			toast.error("Name and zone name are required")
			return
		}

		setIsSaving(true)

		if (editingConnector) {
			const result = await updateMutation({
				params: { connectorId: editingConnector.id },
				payload: new UpdateCloudflareLogpushConnectorRequest({
					name: formName.trim(),
					zoneName: formZoneName.trim(),
					serviceName: formServiceName.trim() || null,
					enabled: formEnabled,
				}),
			})

			if (Exit.isSuccess(result)) {
				toast.success("Cloudflare connector updated")
				setDialogOpen(false)
				refreshConnectors()
			} else {
				toast.error("Failed to update Cloudflare connector")
			}
		} else {
			const result = await createMutation({
				payload: new CreateCloudflareLogpushConnectorRequest({
					name: formName.trim(),
					zoneName: formZoneName.trim(),
					serviceName: formServiceName.trim() || null,
					enabled: formEnabled,
				}),
			})

			if (Exit.isSuccess(result)) {
				toast.success("Cloudflare connector created")
				setDialogOpen(false)
				refreshConnectors()
				openSetupDialog(result.value.connector, result.value.setup)
			} else {
				toast.error("Failed to create Cloudflare connector")
			}
		}

		setIsSaving(false)
	}

	async function handleDelete() {
		if (!deletingConnector) return

		const connector = deletingConnector
		setDeletingConnector(null)

		const result = await deleteMutation({
			params: { connectorId: connector.id },
		})

		if (Exit.isSuccess(result)) {
			toast.success("Cloudflare connector deleted")
			refreshConnectors()
			if (setupConnectorId === connector.id) {
				setSetupDialogOpen(false)
				setSetupConnectorId(null)
				setSetupOverride(null)
			}
		} else {
			toast.error("Failed to delete Cloudflare connector")
		}
	}

	async function handleToggle(connector: CloudflareConnector) {
		setTogglingId(connector.id)
		const result = await updateMutation({
			params: { connectorId: connector.id },
			payload: new UpdateCloudflareLogpushConnectorRequest({
				enabled: !connector.enabled,
			}),
		})
		if (Exit.isSuccess(result)) {
			refreshConnectors()
		} else {
			toast.error("Failed to update Cloudflare connector")
		}
		setTogglingId(null)
	}

	async function handleRotateSecret(connector: CloudflareConnector) {
		setRotatingId(connector.id)
		const result = await rotateMutation({
			params: { connectorId: connector.id },
		})
		if (Exit.isSuccess(result)) {
			toast.success("Cloudflare secret rotated")
			refreshConnectors()
			openSetupDialog(connector, result.value)
		} else {
			toast.error("Failed to rotate Cloudflare secret")
		}
		setRotatingId(null)
	}

	return (
		<>
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-sm">
						Receive Cloudflare HTTP request logs over HTTPS and map them into Maple logs.
					</p>
					<Button size="sm" className="shrink-0" onClick={openAddDialog}>
						<PlusIcon size={14} />
						Add Connector
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
						Failed to load Cloudflare connectors.
					</div>
				) : connectors.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ShieldIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No Cloudflare connectors</EmptyTitle>
							<EmptyDescription>
								Add a connector to generate the endpoint URL, secret, and Cloudflare Logpush
								setup instructions.
							</EmptyDescription>
						</EmptyHeader>
						<Button size="sm" onClick={openAddDialog}>
							<PlusIcon size={14} />
							Add Connector
						</Button>
					</Empty>
				) : (
					<div className="divide-y">
						{connectors.map((connector) => (
							<div key={connector.id} className="flex items-center gap-3 px-1 py-3">
								<div
									className={cn(
										"size-2 shrink-0 rounded-full",
										connector.enabled ? "bg-severity-info" : "bg-muted-foreground/30",
									)}
								/>

								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">{connector.name}</span>
										<Badge variant="outline" className="shrink-0">
											{connector.zoneName}
										</Badge>
									</div>
									<div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 text-xs">
										{connector.serviceName && (
											<span className="font-mono">{connector.serviceName}</span>
										)}
										<span>
											{connector.lastReceivedAt
												? `Last delivery ${formatRelativeTime(connector.lastReceivedAt)}`
												: "No deliveries yet"}
										</span>
									</div>
									{connector.lastError && (
										<div className="mt-1.5 flex items-center gap-1.5 text-xs text-severity-warn">
											<AlertWarningIcon size={12} className="shrink-0" />
											<span className="truncate">{connector.lastError}</span>
										</div>
									)}
								</div>

								<Switch
									checked={connector.enabled}
									onCheckedChange={() => handleToggle(connector)}
									disabled={togglingId === connector.id}
								/>

								<Button
									variant="outline"
									size="sm"
									onClick={() => openSetupDialog(connector)}
								>
									<EyeIcon size={14} />
									Setup
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
										<DropdownMenuItem onClick={() => openEditDialog(connector)}>
											<PencilIcon size={14} />
											Edit
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => handleRotateSecret(connector)}
											disabled={rotatingId === connector.id}
										>
											<KeyIcon size={14} />
											Rotate Secret
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setDeletingConnector(connector)}
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

			{/* Create / Edit Dialog */}
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{editingConnector ? "Edit Cloudflare Connector" : "Add Cloudflare Connector"}
						</DialogTitle>
						<DialogDescription>
							Maple will generate the HTTPS endpoint, secret, and Cloudflare Logpush
							configuration values for you.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="cf-name">Name</Label>
							<Input
								id="cf-name"
								value={formName}
								onChange={(event) => setFormName(event.target.value)}
								placeholder="Production edge requests"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="cf-zone">Zone Name</Label>
							<Input
								id="cf-zone"
								value={formZoneName}
								onChange={(event) => setFormZoneName(event.target.value)}
								placeholder="example.com"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="cf-service">Service Name</Label>
							<Input
								id="cf-service"
								value={formServiceName}
								onChange={(event) => setFormServiceName(event.target.value)}
								placeholder="cloudflare/example.com"
							/>
							<p className="text-muted-foreground text-xs">
								Defaults to <code>cloudflare/&lt;zone&gt;</code>.
							</p>
						</div>

						<div className="flex items-center justify-between rounded-md border px-3 py-2">
							<div>
								<p className="text-sm font-medium">Enabled</p>
								<p className="text-muted-foreground text-xs">
									Disabled connectors reject Cloudflare deliveries immediately.
								</p>
							</div>
							<Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
						</div>
					</div>

					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
							Cancel
						</Button>
						<Button onClick={handleSave} disabled={isSaving}>
							{isSaving && <LoaderIcon size={14} className="animate-spin" />}
							{editingConnector ? "Save Changes" : "Create Connector"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Setup Dialog */}
			<Dialog
				open={setupDialogOpen}
				onOpenChange={(open) => {
					setSetupDialogOpen(open)
					if (!open) {
						setSetupOverride(null)
					}
				}}
			>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>Cloudflare Setup</DialogTitle>
						<DialogDescription>
							{setupConnectorName
								? `Configuration details for ${setupConnectorName}.`
								: "Cloudflare Logpush configuration details."}
						</DialogDescription>
					</DialogHeader>

					{!setup && Result.isInitial(setupResult) ? (
						<div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
							<LoaderIcon size={14} className="animate-spin" />
							Loading setup details…
						</div>
					) : !setup ? (
						<div className="text-muted-foreground py-6 text-sm">
							Failed to load setup details.
						</div>
					) : (
						<div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
							<CopyableField
								label="destination_conf"
								value={setup.destinationConf}
								copied={copiedField === "destination"}
								onCopy={() =>
									copyToClipboard(setup.destinationConf, "destination", "destination_conf")
								}
							/>

							<Separator />

							<div className="grid gap-4 sm:grid-cols-3">
								<div className="rounded-md border p-3">
									<p className="text-muted-foreground text-xs">Dataset</p>
									<p className="text-sm font-medium">Traces</p>
								</div>
								<div className="rounded-md border p-3">
									<p className="text-muted-foreground text-xs">Output Type</p>
									<p className="text-sm font-medium uppercase">
										{setup.recommendedOutputType}
									</p>
								</div>
								<div className="rounded-md border p-3">
									<p className="text-muted-foreground text-xs">Timestamp Format</p>
									<p className="text-sm font-medium uppercase">
										{setup.recommendedTimestampFormat}
									</p>
								</div>
							</div>

							<div className="space-y-2">
								<h4 className="text-sm font-medium">Cloudflare Dashboard Steps</h4>
								<ol className="space-y-2 text-sm">
									{setup.cloudflareSetupSteps.map((step, index) => (
										<li key={step} className="flex gap-2">
											<span className="text-muted-foreground min-w-5">
												{index + 1}.
											</span>
											<span>{step}</span>
										</li>
									))}
								</ol>
							</div>

							<div className="space-y-2">
								<h4 className="text-sm font-medium">Required Fields</h4>
								<div className="flex flex-wrap gap-2">
									{setup.recommendedFieldNames.map((field) => (
										<Badge
											key={field}
											variant="outline"
											className="font-mono text-[11px]"
										>
											{field}
										</Badge>
									))}
								</div>
							</div>

							<div className="space-y-2 rounded-md border border-severity-warn/30 bg-severity-warn/10 p-3">
								<p className="text-sm font-medium">Validation</p>
								<p className="text-sm">{setup.validationNote}</p>
								<p className="text-sm">
									Cloudflare must be able to reach a public HTTPS endpoint. Localhost only
									works if you expose Maple through a tunnel.
								</p>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation */}
			<AlertDialog
				open={deletingConnector !== null}
				onOpenChange={(open) => !open && setDeletingConnector(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Delete Cloudflare connector?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the connector immediately. Existing Cloudflare jobs using its secret
							will fail until they are reconfigured.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleDelete}>
							Delete connector
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
