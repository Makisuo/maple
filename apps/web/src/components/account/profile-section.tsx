import { useRef, useState, type DragEvent } from "react"
import { useClerk, useReverification, useUser } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"

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
import { AlertWarningIcon, UploadIcon } from "@/components/icons"
import { UserAvatar, userInitials } from "@/components/dashboard/user-avatar"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"

const MAX_AVATAR_BYTES = 10 * 1024 * 1024 // 10 MB
const ACCEPTED_AVATAR_TYPES = "image/png,image/jpeg,image/webp,image/gif"

/**
 * Edits to the name fields are held as a draft tagged with the user id they were typed against.
 * Reading through the tag rather than syncing state in an effect means a user switch (or a name
 * changed in another tab) resets the form on the very next render, with no effect to schedule.
 */
interface NameDraft {
	userId: string
	firstName: string
	lastName: string
}

export function ProfileSection() {
	const { user, isLoaded } = useUser()
	const { signOut } = useClerk()

	const [draft, setDraft] = useState<NameDraft | null>(null)
	const [isSavingName, setIsSavingName] = useState(false)
	const [isSavingAvatar, setIsSavingAvatar] = useState(false)
	const [isDragging, setIsDragging] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")
	const [isDeleting, setIsDeleting] = useState(false)

	const deleteAccount = useReverification(() => user?.delete())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const savedFirstName = user.firstName ?? ""
	const savedLastName = user.lastName ?? ""
	const isCurrentDraft = draft?.userId === user.id
	const firstName = isCurrentDraft ? draft.firstName : savedFirstName
	const lastName = isCurrentDraft ? draft.lastName : savedLastName

	const trimmedFirst = firstName.trim()
	const trimmedLast = lastName.trim()
	const nameDirty = trimmedFirst !== savedFirstName || trimmedLast !== savedLastName

	const displayName = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "You"
	const email = user.primaryEmailAddress?.emailAddress ?? ""
	// A user has no unique display name to type back, so the primary email is the confirm string.
	const confirmMatches = email.length > 0 && confirmText.trim() === email

	function updateDraft(patch: Partial<Omit<NameDraft, "userId">>) {
		if (!user) return
		setDraft({ userId: user.id, firstName, lastName, ...patch })
	}

	async function handleSaveName() {
		if (!user || !nameDirty) return
		setIsSavingName(true)
		try {
			await user.update({ firstName: trimmedFirst, lastName: trimmedLast })
			setDraft(null)
			toastManager.add({ title: "Profile updated", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to update profile")
		} finally {
			setIsSavingName(false)
		}
	}

	async function handleAvatarSelect(file: File | undefined | null) {
		if (!user || isSavingAvatar || !file) return
		if (!file.type.startsWith("image/")) {
			toastManager.add({ title: "Please choose an image file", type: "error" })
			return
		}
		if (file.size > MAX_AVATAR_BYTES) {
			toastManager.add({ title: "Image must be 10 MB or smaller", type: "error" })
			return
		}
		setIsSavingAvatar(true)
		try {
			await user.setProfileImage({ file })
			toastManager.add({ title: "Profile picture updated", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to update profile picture")
		} finally {
			setIsSavingAvatar(false)
			if (fileInputRef.current) fileInputRef.current.value = ""
		}
	}

	async function handleRemoveAvatar() {
		if (!user || isSavingAvatar) return
		setIsSavingAvatar(true)
		try {
			await user.setProfileImage({ file: null })
			toastManager.add({ title: "Profile picture removed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to remove profile picture")
		} finally {
			setIsSavingAvatar(false)
		}
	}

	function openFilePicker() {
		if (isSavingAvatar) return
		fileInputRef.current?.click()
	}

	function handleDrop(e: DragEvent<HTMLDivElement>) {
		e.preventDefault()
		setIsDragging(false)
		if (isSavingAvatar) return
		void handleAvatarSelect(e.dataTransfer.files?.[0])
	}

	async function handleDelete() {
		if (!user || !confirmMatches) return
		setIsDeleting(true)
		try {
			await deleteAccount()
			// The session is gone with the user, so sign out rather than leaving a dead session
			// behind; `afterSignOutUrl` on ClerkProvider takes it to the sign-in page.
			await signOut()
		} catch (err) {
			setIsDeleting(false)
			toastAccountError(err, "Failed to delete account")
		}
	}

	function handleDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Profile</CardTitle>
					<CardDescription>
						Your name and picture as they appear to other members of your organizations.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4 max-w-md">
						<div className="space-y-1.5">
							<Label>Profile picture</Label>
							<div className="flex items-center gap-4">
								<div
									role="button"
									tabIndex={isSavingAvatar ? -1 : 0}
									aria-label="Change profile picture"
									aria-disabled={isSavingAvatar}
									onClick={openFilePicker}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											openFilePicker()
										}
									}}
									onDragOver={(e) => {
										e.preventDefault()
										if (!isSavingAvatar) setIsDragging(true)
									}}
									onDragLeave={() => setIsDragging(false)}
									onDrop={handleDrop}
									className={`relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed p-1 outline-none transition-colors ${
										isSavingAvatar
											? "cursor-not-allowed opacity-60"
											: "cursor-pointer hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
									} ${isDragging ? "border-primary ring-2 ring-primary" : "border-border"}`}
								>
									<UserAvatar
										name={displayName}
										initials={userInitials(displayName)}
										imageUrl={user.hasImage ? user.imageUrl : undefined}
										className="size-full rounded-md text-sm"
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
											disabled={isSavingAvatar}
										>
											<UploadIcon size={14} className="mr-1.5" />
											{isSavingAvatar ? "Uploading..." : "Change picture"}
										</Button>
										{user.hasImage && (
											<Button
												variant="ghost"
												size="sm"
												onClick={handleRemoveAvatar}
												disabled={isSavingAvatar}
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
								accept={ACCEPTED_AVATAR_TYPES}
								className="hidden"
								onChange={(e) => void handleAvatarSelect(e.target.files?.[0])}
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="account-first-name">First name</Label>
								<Input
									id="account-first-name"
									value={firstName}
									onChange={(e) => updateDraft({ firstName: e.target.value })}
									disabled={isSavingName}
									autoComplete="given-name"
									placeholder="First name"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="account-last-name">Last name</Label>
								<Input
									id="account-last-name"
									value={lastName}
									onChange={(e) => updateDraft({ lastName: e.target.value })}
									disabled={isSavingName}
									autoComplete="family-name"
									placeholder="Last name"
								/>
							</div>
						</div>
						<div className="flex justify-end">
							<Button size="sm" onClick={handleSaveName} disabled={!nameDirty || isSavingName}>
								{isSavingName ? "Saving..." : "Save"}
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			{user.deleteSelfEnabled && (
				<Card className="border-destructive/40">
					<CardHeader>
						<CardTitle className="text-destructive">Danger Zone</CardTitle>
						<CardDescription>
							Permanently delete your Maple account. You are removed from every organization you
							belong to. Organizations you own, and the telemetry in them, are not deleted —
							hand them over or delete them first.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex items-center justify-between gap-4">
							<div className="text-xs text-muted-foreground">
								Delete {email || "your account"} and sign out everywhere.
							</div>
							<Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
								Delete account
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			<AlertDialog open={deleteOpen} onOpenChange={handleDialogChange}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Delete your account?</AlertDialogTitle>
						<AlertDialogDescription>
							Your profile, sign-in methods and organization memberships are permanently
							deleted, and every session is signed out. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{/* AlertDialog has no panel slot, so a body between header and footer pads itself —
					    same as the members and attribute-mapping dialogs. */}
					<div className="space-y-2 px-6 py-2">
						<Label htmlFor="account-delete-confirm" className="text-xs">
							Type <span className="font-mono font-semibold">{email}</span> to confirm.
						</Label>
						<Input
							id="account-delete-confirm"
							value={confirmText}
							onChange={(e) => setConfirmText(e.target.value)}
							placeholder={email}
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
							{isDeleting ? "Deleting..." : "Delete account"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
