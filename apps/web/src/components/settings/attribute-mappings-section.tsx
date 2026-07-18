import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type {
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
} from "@maple/domain/http"
import type { V2AttributeMapping } from "@maple/domain/http/v2"
import { useState } from "react"
import { Exit } from "effect"
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
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@maple/ui/components/ui/card"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import {
	AlertWarningIcon,
	ArrowPathIcon,
	ArrowRightFromLineIcon,
	ArrowRightIcon,
	ArrowUpDownIcon,
	BracketsCurlyIcon,
	CopyIcon,
	CubeIcon,
	type IconComponent,
	LoaderIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { formatRelativeTime } from "@/lib/format"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	ingestAttributeMappingsListAtom,
	recommendationIssuesListAtom,
} from "@/lib/services/atoms/ingestion-atoms"
import { AttributeKeyAutocomplete } from "./attribute-key-autocomplete"

const MONO = "font-mono text-[0.92em] text-muted-foreground"

const SOURCE_CONTEXT_LABELS: Record<IngestMappingSourceContext, string> = {
	span: "Span attribute",
	resource: "Resource attribute",
}

const OPERATION_LABELS: Record<IngestMappingOperation, string> = {
	move: "Move",
	copy: "Copy",
}

// Copy is additive (keeps the source) → calm blue; Move removes the source key → amber caution.
const OPERATION_BADGE: Record<
	IngestMappingOperation,
	{ icon: IconComponent; variant: "info" | "warning"; tone: string }
> = {
	copy: { icon: CopyIcon, variant: "info", tone: "text-info" },
	move: { icon: ArrowRightFromLineIcon, variant: "warning", tone: "text-warning" },
}

const SOURCE_CONTEXT_ICON: Record<IngestMappingSourceContext, IconComponent> = {
	span: BracketsCurlyIcon,
	resource: CubeIcon,
}

export function AttributeMappingsSection() {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [togglingId, setTogglingId] = useState<IngestAttributeMappingId | null>(null)
	const [deleteConfirm, setDeleteConfirm] = useState<V2AttributeMapping | null>(null)

	const [editing, setEditing] = useState<V2AttributeMapping | null>(null)
	const [formName, setFormName] = useState("")
	const [formSourceContext, setFormSourceContext] = useState<IngestMappingSourceContext>("span")
	const [formSourceKey, setFormSourceKey] = useState("")
	const [formTargetKey, setFormTargetKey] = useState("")
	const [formOperation, setFormOperation] = useState<IngestMappingOperation>("copy")

	const listResult = useAtomValue(ingestAttributeMappingsListAtom)
	const refreshMappings = useAtomRefresh(ingestAttributeMappingsListAtom)
	// Mappings reconcile the recommendation list server-side, so refresh both after a change.
	const refreshRecommendations = useAtomRefresh(recommendationIssuesListAtom)

	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "create"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "update"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "delete"), {
		mode: "promiseExit",
	})

	const mappings = Result.builder(listResult)
		.onSuccess((response) => [...response.data])
		.orElse(() => [] as V2AttributeMapping[])

	function openAddDialog() {
		setEditing(null)
		setFormName("")
		setFormSourceContext("span")
		setFormSourceKey("")
		setFormTargetKey("")
		setFormOperation("copy")
		setDialogOpen(true)
	}

	function openEditDialog(mapping: V2AttributeMapping) {
		setEditing(mapping)
		setFormName(mapping.name)
		setFormSourceContext(mapping.source_context)
		setFormSourceKey(mapping.source_key)
		setFormTargetKey(mapping.target_key)
		setFormOperation(mapping.operation)
		setDialogOpen(true)
	}

	async function handleSave() {
		if (!formName.trim() || !formSourceKey.trim() || !formTargetKey.trim()) {
			toast.error("Name, source key, and target key are required")
			return
		}

		setIsSaving(true)
		if (editing) {
			const result = await updateMutation({
				params: { id: editing.id },
				payload: {
					name: formName.trim(),
					source_context: formSourceContext,
					source_key: formSourceKey.trim(),
					target_key: formTargetKey.trim(),
					operation: formOperation,
				},
			})
			if (Exit.isSuccess(result)) {
				toast.success("Attribute mapping updated")
				setDialogOpen(false)
				refreshMappings()
				refreshRecommendations()
			} else {
				toast.error("Failed to update attribute mapping")
			}
		} else {
			const result = await createMutation({
				payload: {
					name: formName.trim(),
					source_context: formSourceContext,
					source_key: formSourceKey.trim(),
					target_key: formTargetKey.trim(),
					operation: formOperation,
				},
			})
			if (Exit.isSuccess(result)) {
				toast.success("Attribute mapping created")
				setDialogOpen(false)
				refreshMappings()
				refreshRecommendations()
			} else {
				toast.error("Failed to create attribute mapping")
			}
		}
		setIsSaving(false)
	}

	async function handleDelete(mappingId: IngestAttributeMappingId) {
		setDeleteConfirm(null)
		const result = await deleteMutation({ params: { id: mappingId } })
		if (Exit.isSuccess(result)) {
			toast.success("Attribute mapping deleted")
			refreshMappings()
			refreshRecommendations()
		} else {
			toast.error("Failed to delete attribute mapping")
		}
	}

	async function handleToggleEnabled(mapping: V2AttributeMapping) {
		setTogglingId(mapping.id)
		const result = await updateMutation({
			params: { id: mapping.id },
			payload: {
				enabled: !mapping.enabled,
			},
		})
		if (Exit.isSuccess(result)) {
			refreshMappings()
		} else {
			toast.error("Failed to update attribute mapping")
		}
		setTogglingId(null)
	}

	const mappingCount = Result.isSuccess(listResult) ? mappings.length : null

	const PreviewOpIcon = OPERATION_BADGE[formOperation].icon
	const showPreview = formSourceKey.trim().length > 0 && formTargetKey.trim().length > 0

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						Attribute Mappings
						{mappingCount !== null && mappingCount > 0 && (
							<Badge variant="secondary" className="font-normal tabular-nums">
								{mappingCount}
							</Badge>
						)}
					</CardTitle>
					<CardDescription>
						Rename or promote span attribute keys at ingest so telemetry from different SDKs stays
						consistent. Applied only to spans received after a rule is saved.
					</CardDescription>
					<CardAction>
						<Button size="sm" onClick={openAddDialog}>
							<PlusIcon size={14} />
							Add Mapping
						</Button>
					</CardAction>
				</CardHeader>
				<CardContent>
					{Result.isInitial(listResult) ? (
						<div className="space-y-px">
							{[0, 1].map((i) => (
								<div key={i} className="flex items-center gap-4 py-3">
									<div className="flex-1 space-y-2">
										<Skeleton className="h-4 w-40" />
										<Skeleton className="h-3.5 w-64" />
									</div>
									<Skeleton className="h-5 w-9 rounded-full" />
								</div>
							))}
						</div>
					) : !Result.isSuccess(listResult) ? (
						<Empty className="py-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<AlertWarningIcon size={16} className="text-destructive" />
								</EmptyMedia>
								<EmptyTitle>Couldn't load mappings</EmptyTitle>
								<EmptyDescription>
									Something went wrong fetching your attribute mappings.
								</EmptyDescription>
							</EmptyHeader>
							<Button variant="outline" size="sm" onClick={() => refreshMappings()}>
								<ArrowPathIcon size={14} />
								Try again
							</Button>
						</Empty>
					) : mappings.length === 0 ? (
						<Empty className="py-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ArrowUpDownIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No attribute mappings yet</EmptyTitle>
								<EmptyDescription>
									Add a rule to rename or promote span attribute keys as telemetry is
									ingested.
								</EmptyDescription>
							</EmptyHeader>
							<Button size="sm" onClick={openAddDialog}>
								<PlusIcon size={14} />
								Add Mapping
							</Button>
						</Empty>
					) : (
						<div>
							{/* column header */}
							<div className="text-muted-foreground border-border/60 -mx-6 flex items-center gap-4 border-b px-6 pt-1 pb-2 text-xs">
								<div className="w-44 shrink-0">Name</div>
								<div className="flex-1">Mapping</div>
								<div className="w-24 shrink-0">Operation</div>
								<div className="w-40 shrink-0 text-right">Added</div>
							</div>

							{mappings.map((mapping) => {
								const operation = OPERATION_BADGE[mapping.operation]
								const OperationIcon = operation.icon
								return (
									<div
										key={mapping.id}
										className={cn(
											"group border-border/60 hover:bg-muted/40 -mx-6 flex items-center gap-4 border-b px-6 py-2.5 transition-colors last:border-b-0",
											!mapping.enabled && "opacity-55",
										)}
									>
										<span
											className="w-44 shrink-0 truncate text-sm font-medium"
											title={mapping.name}
										>
											{mapping.name}
										</span>

										<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
											<code className={MONO}>{mapping.source_key}</code>
											<ArrowRightIcon
												size={12}
												className="text-muted-foreground shrink-0"
											/>
											<code className="font-mono text-[0.92em] text-foreground">
												{mapping.target_key}
											</code>
											{mapping.source_context === "resource" && (
												<span className="text-muted-foreground text-xs">
													· from {SOURCE_CONTEXT_LABELS.resource.toLowerCase()}
												</span>
											)}
										</div>

										<div className="w-24 shrink-0">
											<Badge variant={operation.variant} className="gap-1">
												<OperationIcon size={11} />
												{OPERATION_LABELS[mapping.operation]}
											</Badge>
										</div>

										<div className="relative flex w-40 shrink-0 items-center justify-end gap-3">
											<Switch
												checked={mapping.enabled}
												onCheckedChange={() => handleToggleEnabled(mapping)}
												disabled={togglingId === mapping.id}
											/>
											<span
												className="text-muted-foreground w-20 text-right text-xs whitespace-nowrap tabular-nums transition-opacity group-hover:opacity-0"
												title={new Date(mapping.created_at).toLocaleString()}
											>
												{formatRelativeTime(mapping.created_at)}
											</span>
											<div className="absolute right-0 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-foreground"
													onClick={() => openEditDialog(mapping)}
													aria-label="Edit mapping"
													title="Edit"
												>
													<PencilIcon size={14} />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-destructive"
													onClick={() => setDeleteConfirm(mapping)}
													aria-label="Delete mapping"
													title="Delete"
												>
													<TrashIcon size={14} />
												</Button>
											</div>
										</div>
									</div>
								)
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Add / Edit Dialog */}
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
							<ArrowUpDownIcon size={18} />
						</div>
						<DialogTitle>
							{editing ? "Edit Attribute Mapping" : "Add Attribute Mapping"}
						</DialogTitle>
						<DialogDescription>
							The value at the source key is written to the target span attribute. An existing
							target key is never overwritten.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6 py-2">
						<div className="space-y-2">
							<Label htmlFor="mapping-name">Name</Label>
							<Input
								id="mapping-name"
								placeholder="e.g. Normalize HTTP status code"
								value={formName}
								onChange={(e) => setFormName(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Source context</Label>
							<Select
								items={SOURCE_CONTEXT_LABELS}
								value={formSourceContext}
								onValueChange={(val: string | null) =>
									setFormSourceContext((val as IngestMappingSourceContext | null) ?? "span")
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select source context">
										{(value: string | null) => {
											const ctx =
												(value as IngestMappingSourceContext | null) ??
												formSourceContext
											const Icon = SOURCE_CONTEXT_ICON[ctx]
											return (
												<span className="flex items-center gap-2">
													<Icon className="text-muted-foreground" />
													{SOURCE_CONTEXT_LABELS[ctx]}
												</span>
											)
										}}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="span">
										<span className="flex items-center gap-2">
											<BracketsCurlyIcon className="text-muted-foreground" />
											Span attribute
										</span>
									</SelectItem>
									<SelectItem value="resource">
										<span className="flex items-center gap-2">
											<CubeIcon className="text-muted-foreground" />
											Resource attribute
										</span>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="mapping-source-key">Source key</Label>
							<AttributeKeyAutocomplete
								id="mapping-source-key"
								scope={formSourceContext}
								placeholder="e.g. http.status_code"
								value={formSourceKey}
								onValueChange={setFormSourceKey}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="mapping-target-key">Target span attribute key</Label>
							<AttributeKeyAutocomplete
								id="mapping-target-key"
								scope="span"
								placeholder="e.g. http.response.status_code"
								value={formTargetKey}
								onValueChange={setFormTargetKey}
							/>
						</div>
						<div className="space-y-2">
							<Label>Operation</Label>
							<Select
								items={OPERATION_LABELS}
								value={formOperation}
								onValueChange={(val: string | null) =>
									setFormOperation((val as IngestMappingOperation | null) ?? "copy")
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select operation">
										{(value: string | null) => {
											const op =
												(value as IngestMappingOperation | null) ?? formOperation
											const meta = OPERATION_BADGE[op]
											const Icon = meta.icon
											return (
												<span className="flex items-center gap-2">
													<Icon className={meta.tone} />
													{OPERATION_LABELS[op]}
												</span>
											)
										}}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="copy">
										<span className="flex items-center gap-2">
											<CopyIcon className="text-info" />
											<span>
												Copy{" "}
												<span className="text-muted-foreground">
													— keep source key
												</span>
											</span>
										</span>
									</SelectItem>
									<SelectItem value="move">
										<span className="flex items-center gap-2">
											<ArrowRightFromLineIcon className="text-warning" />
											<span>
												Move{" "}
												<span className="text-muted-foreground">
													— remove source key
												</span>
											</span>
										</span>
									</SelectItem>
								</SelectContent>
							</Select>
							{formSourceContext === "resource" && formOperation === "move" && (
								<p className="text-muted-foreground text-xs">
									Move behaves as Copy for resource attributes — a resource attribute is
									shared across every span in a batch and is never deleted.
								</p>
							)}
						</div>

						{showPreview && (
							<div className="rounded-md border bg-muted/40 px-3 py-2.5">
								<div className="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-[0.12em] uppercase">
									Preview
								</div>
								<div className="flex flex-wrap items-center gap-1.5 text-sm">
									<code className={MONO}>{formSourceKey.trim()}</code>
									<ArrowRightIcon size={12} className="text-muted-foreground shrink-0" />
									<code className="text-foreground font-mono text-[0.92em]">
										{formTargetKey.trim()}
									</code>
									<Badge
										variant={OPERATION_BADGE[formOperation].variant}
										className="ml-1 gap-1"
									>
										<PreviewOpIcon size={11} />
										{OPERATION_LABELS[formOperation]}
									</Badge>
								</div>
							</div>
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
									{editing ? "Saving..." : "Adding..."}
								</>
							) : editing ? (
								"Save Changes"
							) : (
								"Add Mapping"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation */}
			<AlertDialog
				open={deleteConfirm !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirm(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete attribute mapping</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete{" "}
							<span className="text-foreground font-medium">{deleteConfirm?.name}</span>? This
							action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (deleteConfirm) {
									void handleDelete(deleteConfirm.id)
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
