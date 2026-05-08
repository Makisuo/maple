import { useAtomSet } from "@/lib/effect-atom"
import { useEffect, useState } from "react"
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
import { AlertWarningIcon, UserIcon } from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

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
					<EmptyDescription>Select or create an organization to manage its settings.</EmptyDescription>
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

	async function handleDelete() {
		if (!organization || !confirmMatches) return
		setIsDeleting(true)
		const result = await deleteMutation({})
		if (Exit.isSuccess(result)) {
			const remaining = (userMemberships?.data ?? []).filter((m) => m.organization.id !== organization.id)
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
							? "Update the name of your organization. The change is visible to all members."
							: "Only org admins can change these settings."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-3 max-w-md">
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
						associated data. Telemetry already sent to Maple will age out per its retention policy.
						This cannot be undone.
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
							All dashboards, alerts, API keys, ingest keys, and integrations for this org will be
							permanently deleted. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor="org-delete-confirm" className="text-xs">
							Type <span className="font-mono font-semibold">{organization.name}</span> to confirm.
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
