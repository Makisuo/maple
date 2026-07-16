import { Exit, Option } from "effect"
import { Fragment, useState, type Dispatch, type SetStateAction } from "react"
import { toast } from "sonner"

import type { AlertDeliveryEventDocument, AlertDestinationDocument } from "@maple/domain/http"

import { DestinationCard } from "@/components/alerts/destination-card"
import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { ProviderLogo } from "@/components/alerts/destination-provider"
import { CircleWarningIcon, FireIcon, PlusIcon, TruckIcon } from "@/components/icons"
import {
	buildDestinationCreatePayload,
	buildDestinationUpdatePayload,
	defaultDestinationForm,
	deliveryStatusMeta,
	destinationToFormState,
	eventTypeMeta,
	formatAlertDateTime,
	formatAlertTime,
	getExitErrorMessage,
	groupDeliveryEventsByDay,
	type DestinationFormState,
} from "@/lib/alerts/form-utils"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"

/**
 * Destination CRUD state + handlers, lifted into a hook so the route header's
 * "Add destination" button and the settings tab (edit/delete/test/empty-state
 * CTA + dialog) share one dialog instance.
 */
export interface DestinationManager {
	dialogOpen: boolean
	setDialogOpen: (open: boolean) => void
	form: DestinationFormState
	setForm: Dispatch<SetStateAction<DestinationFormState>>
	isEditing: boolean
	saving: boolean
	testingId: AlertDestinationDocument["id"] | null
	deletingId: AlertDestinationDocument["id"] | null
	openDialog: (destination?: AlertDestinationDocument) => void
	save: () => Promise<void>
	test: (destination: AlertDestinationDocument) => Promise<void>
	toggle: (destination: AlertDestinationDocument) => Promise<void>
	remove: (destination: AlertDestinationDocument) => Promise<void>
}

export function useDestinationManager(): DestinationManager {
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

	const [dialogOpen, setDialogOpen] = useState(false)
	const [form, setForm] = useState<DestinationFormState>(defaultDestinationForm())
	const [editing, setEditing] = useState<AlertDestinationDocument | null>(null)
	const [saving, setSaving] = useState(false)
	const [testingId, setTestingId] = useState<AlertDestinationDocument["id"] | null>(null)
	const [deletingId, setDeletingId] = useState<AlertDestinationDocument["id"] | null>(null)

	function openDialog(destination?: AlertDestinationDocument) {
		setEditing(destination ?? null)
		setForm(destination ? destinationToFormState(destination) : defaultDestinationForm())
		setDialogOpen(true)
	}

	async function save() {
		setSaving(true)
		const result = editing
			? await updateDestination({
					params: { destinationId: editing.id },
					payload: buildDestinationUpdatePayload(form) as never,
					reactivityKeys: ["alertDestinations"],
				})
			: await createDestination({
					payload: buildDestinationCreatePayload(form) as never,
					reactivityKeys: ["alertDestinations"],
				})

		if (Exit.isSuccess(result)) {
			toast.success(editing ? "Destination updated" : "Destination created")
			setDialogOpen(false)
		} else {
			toast.error(getExitErrorMessage(result, "Failed to save destination"))
		}
		setSaving(false)
	}

	async function test(destination: AlertDestinationDocument) {
		setTestingId(destination.id)
		const result = await testDestination({
			params: { destinationId: destination.id },
			reactivityKeys: ["alertDestinations", "alertDeliveryEvents"],
		})
		if (Exit.isSuccess(result)) {
			toast.success(result.value.message)
		} else {
			toast.error(getExitErrorMessage(result, "Failed to send test notification"))
		}
		setTestingId(null)
	}

	async function toggle(destination: AlertDestinationDocument) {
		const nextForm = destinationToFormState(destination)
		nextForm.enabled = !destination.enabled
		const result = await updateDestination({
			params: { destinationId: destination.id },
			payload: buildDestinationUpdatePayload(nextForm) as never,
			reactivityKeys: ["alertDestinations"],
		})
		if (!Exit.isSuccess(result)) {
			toast.error(getExitErrorMessage(result, "Failed to update destination"))
		}
	}

	async function remove(destination: AlertDestinationDocument) {
		setDeletingId(destination.id)
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
		setDeletingId(null)
	}

	return {
		dialogOpen,
		setDialogOpen,
		form,
		setForm,
		isEditing: editing != null,
		saving,
		testingId,
		deletingId,
		openDialog,
		save,
		test,
		toggle,
		remove,
	}
}

/**
 * Settings tab: the destinations grid + delivery log, plus the shared
 * destination dialog. The manager is created by the route so the page header's
 * "Add destination" action drives the same dialog.
 */
export function AlertsSettingsTab({ manager, isAdmin }: { manager: DestinationManager; isAdmin: boolean }) {
	const { result: destinationsResult } = useAlertDestinationsList()
	const deliveryEventsResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listDeliveryEvents", { reactivityKeys: ["alertDeliveryEvents"] }),
	)

	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
		.orElse(() => [])
	const deliveryEvents = Result.builder(deliveryEventsResult)
		.onSuccess((response) => [...response.events] as AlertDeliveryEventDocument[])
		.orElse(() => [])
	const deliveryEventGroups = groupDeliveryEventsByDay(deliveryEvents)

	return (
		<>
			<div className="space-y-8">
				{/* Destinations section */}
				<section className="space-y-4">
					<div>
						<h2 className="text-lg font-semibold">Destinations</h2>
						<p className="text-muted-foreground text-sm">
							Destinations are reusable across rules and keep provider retries and failures
							auditable.
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
								<EmptyDescription>Refresh the page or check your connection.</EmptyDescription>
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
									Add Slack, PagerDuty, or webhook destinations before creating alert rules.
								</EmptyDescription>
							</EmptyHeader>
							{isAdmin && (
								<Button size="sm" onClick={() => manager.openDialog()}>
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
									isTesting={manager.testingId === destination.id}
									isDeleting={manager.deletingId === destination.id}
									onToggle={manager.toggle}
									onTest={manager.test}
									onEdit={manager.openDialog}
									onDelete={manager.remove}
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
							Every queued, retried, and completed notification attempt across alert destinations.
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
								<EmptyDescription>Refresh the page or check your connection.</EmptyDescription>
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
									Once rules start triggering, delivery attempts will show up here.
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
														{group.events.length === 1 ? "attempt" : "attempts"}
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
															<Badge variant={status.variant} size="sm">
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
																className={cn("size-1.5 rounded-full", ev.dot)}
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
																{event.errorMessage ?? "Delivery failed"}
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
																{formatAlertTime(event.scheduledAt)}
															</TooltipTrigger>
															<TooltipContent>
																{formatAlertDateTime(event.scheduledAt)}
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

			<DestinationDialog
				open={manager.dialogOpen}
				onOpenChange={manager.setDialogOpen}
				form={manager.form}
				onFormChange={manager.setForm}
				isEditing={manager.isEditing}
				saving={manager.saving}
				onSave={manager.save}
			/>
		</>
	)
}
