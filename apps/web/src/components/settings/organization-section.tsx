import { useAtomSet } from "@/lib/effect-atom"
import { useEffect, useRef, useState, type DragEvent } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useAuth, useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { Exit } from "effect"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { AlertWarningIcon, UploadIcon, UserIcon } from "@/components/icons"
import { OrgAvatar } from "@/components/dashboard/org-switcher-menu"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const MAX_LOGO_BYTES = 10 * 1024 * 1024 // 10 MB
const ACCEPTED_LOGO_TYPES = "image/png,image/jpeg,image/webp,image/gif"

export function OrganizationSection() {
	const { orgRole } = useAuth()
	const { organization, isLoaded } = useOrganization()
	const { setActive, userMemberships } = useOrganizationList({
		userMemberships: { infinite: true },
	})
	const navigate = useNavigate()

	const isAdmin = orgRole === "org:admin"

	const [name, setName] = useState("")
	const [isSavingName, setIsSavingName] = useState(false)
	const [isSavingLogo, setIsSavingLogo] = useState(false)
	const [isDragging, setIsDragging] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")
	const [isDeleting, setIsDeleting] = useState(false)

	useEffect(() => {
		setName(organization?.name ?? "")
	}, [organization?.id, organization?.name])

	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("organizations", "delete"), {
		mode: "promiseExit",
	})

	if (!isLoaded) {
		return (
			<div className="space-y-6">
				<Card>
					<CardHeader>
						<Skeleton className="h-5 w-32" />
						<Skeleton className="h-4 w-64" />
					</CardHeader>
					<CardContent>
						<Skeleton className="h-9 w-full" />
					</CardContent>
				</Card>
			</div>
		)
	}

	if (!organization) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia>
						<UserIcon size={20} />
					</EmptyMedia>
					<EmptyTitle>No organization</EmptyTitle>
					<EmptyDescription>
						Select or create an organization to manage its settings.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	const trimmedName = name.trim()
	const nameDirty = trimmedName.length > 0 && trimmedName !== organization.name
	const confirmMatches = confirmText.trim() === organization.name

	async function handleRename() {
		if (!organization || !nameDirty) return
		setIsSavingName(true)
		try {
			await organization.update({ name: trimmedName })
			toast.success("Organization renamed")
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to rename organization"
			toast.error(message)
		} finally {
			setIsSavingName(false)
		}
	}

	async function handleLogoSelect(file: File | undefined | null) {
		if (!organization || !isAdmin || isSavingLogo || !file) return
		if (!file.type.startsWith("image/")) {
			toast.error("Please choose an image file")
			return
		}
		if (file.size > MAX_LOGO_BYTES) {
			toast.error("Image must be 10 MB or smaller")
			return
		}
		setIsSavingLogo(true)
		try {
			await organization.setLogo({ file })
			toast.success("Organization logo updated")
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to update logo"
			toast.error(message)
		} finally {
			setIsSavingLogo(false)
			if (fileInputRef.current) fileInputRef.current.value = ""
		}
	}

	async function handleRemoveLogo() {
		if (!organization || !isAdmin || isSavingLogo) return
		setIsSavingLogo(true)
		try {
			await organization.setLogo({ file: null })
			toast.success("Organization logo removed")
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to remove logo"
			toast.error(message)
		} finally {
			setIsSavingLogo(false)
		}
	}

	function openFilePicker() {
		if (!isAdmin || isSavingLogo) return
		fileInputRef.current?.click()
	}

	function handleDrop(e: DragEvent<HTMLDivElement>) {
		e.preventDefault()
		setIsDragging(false)
		if (!isAdmin || isSavingLogo) return
		void handleLogoSelect(e.dataTransfer.files?.[0])
	}

	async function handleDelete() {
		if (!organization || !confirmMatches) return
		setIsDeleting(true)
		const result = await deleteMutation({})
		if (Exit.isSuccess(result)) {
			const remaining = (userMemberships?.data ?? []).filter(
				(m) => m.organization.id !== organization.id,
			)
			const next = remaining[0]?.organization.id ?? null
			try {
				if (setActive) await setActive({ organization: next })
			} catch {
				// fall through to navigation; Clerk session will refresh on next load
			}
			toast.success("Organization deleted")
			setIsDeleting(false)
			setDeleteOpen(false)
			setConfirmText("")
			navigate({ to: "/" })
			return
		}
		setIsDeleting(false)
		toast.error("Failed to delete organization")
	}

	function handleDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>General</CardTitle>
					<CardDescription>
						{isAdmin
							? "Update your organization's logo and name. Changes are visible to all members."
							: "Only org admins can change these settings."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4 max-w-md">
						<div className="space-y-1.5">
							<Label>Logo</Label>
							<div className="flex items-center gap-4">
								<div
									role="button"
									tabIndex={isAdmin && !isSavingLogo ? 0 : -1}
									aria-label="Change organization logo"
									aria-disabled={!isAdmin || isSavingLogo}
									onClick={openFilePicker}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											openFilePicker()
										}
									}}
									onDragOver={(e) => {
										e.preventDefault()
										if (isAdmin && !isSavingLogo) setIsDragging(true)
									}}
									onDragLeave={() => setIsDragging(false)}
									onDrop={handleDrop}
									className={`relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed p-1 outline-none transition-colors ${
										isAdmin && !isSavingLogo
											? "cursor-pointer hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
											: "cursor-not-allowed opacity-60"
									} ${isDragging ? "border-primary ring-2 ring-primary" : "border-border"}`}
								>
									<OrgAvatar
										name={organization.name}
										imageUrl={organization.imageUrl}
										className="size-full"
										fit="contain"
									/>
									{isDragging && (
										<div className="absolute inset-0 flex items-center justify-center rounded-md bg-primary/10 text-center text-[10px] font-medium text-primary">
											Drop image
										</div>
									)}
								</div>
								<div className="space-y-1.5">
									<div className="flex items-center gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={openFilePicker}
											disabled={!isAdmin || isSavingLogo}
										>
											<UploadIcon size={14} className="mr-1.5" />
											{isSavingLogo ? "Uploading..." : "Change logo"}
										</Button>
										{organization.hasImage && (
											<Button
												variant="ghost"
												size="sm"
												onClick={handleRemoveLogo}
												disabled={!isAdmin || isSavingLogo}
											>
												Remove
											</Button>
										)}
									</div>
									<p className="text-xs text-muted-foreground">
										Drop an image or click to upload. PNG, JPG, WEBP or GIF, up to 10 MB.
									</p>
								</div>
							</div>
							<input
								ref={fileInputRef}
								type="file"
								accept={ACCEPTED_LOGO_TYPES}
								className="hidden"
								onChange={(e) => void handleLogoSelect(e.target.files?.[0])}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="org-name">Name</Label>
							<Input
								id="org-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								disabled={!isAdmin || isSavingName}
								placeholder="Organization name"
							/>
						</div>
						<div className="flex justify-end">
							<Button
								size="sm"
								onClick={handleRename}
								disabled={!isAdmin || !nameDirty || isSavingName}
							>
								{isSavingName ? "Saving..." : "Save"}
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			<Card className="border-destructive/40">
				<CardHeader>
					<CardTitle className="text-destructive">Danger Zone</CardTitle>
					<CardDescription>
						Permanently delete this organization, its dashboards, alerts, API keys, and all
						associated data. Telemetry already sent to Maple will age out per its retention
						policy. This cannot be undone.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-center justify-between gap-4">
						<div className="text-xs text-muted-foreground">
							{isAdmin
								? `Delete "${organization.name}" and remove every member's access.`
								: "Only org admins can delete the organization."}
						</div>
						<Button
							variant="destructive"
							size="sm"
							disabled={!isAdmin}
							onClick={() => setDeleteOpen(true)}
						>
							Delete organization
						</Button>
					</div>
				</CardContent>
			</Card>

			<AlertDialog open={deleteOpen} onOpenChange={handleDialogChange}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Delete organization?</AlertDialogTitle>
						<AlertDialogDescription>
							All dashboards, alerts, API keys, ingest keys, and integrations for this org will
							be permanently deleted. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor="org-delete-confirm" className="text-xs">
							Type <span className="font-mono font-semibold">{organization.name}</span> to
							confirm.
						</Label>
						<Input
							id="org-delete-confirm"
							value={confirmText}
							onChange={(e) => setConfirmText(e.target.value)}
							placeholder={organization.name}
							autoComplete="off"
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={handleDelete}
							disabled={isDeleting || !confirmMatches}
						>
							{isDeleting ? "Deleting..." : "Delete organization"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
