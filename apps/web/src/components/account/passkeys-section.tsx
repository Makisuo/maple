import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import type { Passkey } from "@/components/account/account-types"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
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
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import {
	AlertWarningIcon,
	DotsVerticalIcon,
	FingerprintIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"

/**
 * `@clerk/shared/webauthn` exports `isWebAuthnSupported()`, but it is not a declared dependency
 * of this app. The presence of `PublicKeyCredential` is the same check.
 */
const isWebAuthnSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })

export function PasskeysSection() {
	const { user, isLoaded } = useUser()

	const [isBusy, setIsBusy] = useState(false)
	const [renaming, setRenaming] = useState<{ passkey: Passkey; name: string } | null>(null)
	const [pendingRemoval, setPendingRemoval] = useState<Passkey | null>(null)

	const createPasskey = useReverification(() => user?.createPasskey())
	const deletePasskey = useReverification((passkey: Passkey) => passkey.delete())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const supported = isWebAuthnSupported()
	const passkeys = user.passkeys

	async function handleCreate() {
		setIsBusy(true)
		try {
			// `createPasskey()` takes no name — Clerk derives one from the authenticator, and it is
			// renamed afterwards if the user wants something clearer.
			await createPasskey()
			toastManager.add({ title: "Passkey added", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to add a passkey")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleRename() {
		if (!renaming) return
		const name = renaming.name.trim()
		if (name.length === 0) return
		setIsBusy(true)
		try {
			await renaming.passkey.update({ name })
			setRenaming(null)
			toastManager.add({ title: "Passkey renamed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to rename passkey")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleRemove() {
		if (!pendingRemoval) return
		setIsBusy(true)
		try {
			await deletePasskey(pendingRemoval)
			setPendingRemoval(null)
			toastManager.add({ title: "Passkey removed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to remove passkey")
		} finally {
			setIsBusy(false)
		}
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader className="flex flex-row items-center justify-between">
					<div className="space-y-1.5">
						<CardTitle>Passkeys</CardTitle>
						<CardDescription>
							Sign in with Touch ID, Windows Hello, a phone or a hardware key instead of a
							password.
						</CardDescription>
					</div>
					<Button size="sm" onClick={handleCreate} disabled={isBusy || !supported}>
						<PlusIcon size={14} />
						Add passkey
					</Button>
				</CardHeader>
				<CardContent>
					{!supported ? (
						<p className="text-sm text-muted-foreground">
							This browser does not support passkeys. Open Maple in a recent version of Chrome,
							Safari, Edge or Firefox over HTTPS to register one.
						</p>
					) : passkeys.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<FingerprintIcon size={20} />
								</EmptyMedia>
								<EmptyTitle>No passkeys</EmptyTitle>
								<EmptyDescription>
									Add one to sign in without typing a password.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Added</TableHead>
									<TableHead>Last used</TableHead>
									<TableHead className="w-10" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{passkeys.map((passkey) => (
									<TableRow key={passkey.id}>
										<TableCell>
											<div className="flex items-center gap-2.5">
												<FingerprintIcon
													size={16}
													className="shrink-0 text-muted-foreground"
												/>
												<span className="text-xs font-medium">
													{passkey.name ?? "Unnamed passkey"}
												</span>
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground text-xs">
											{dateFormat.format(passkey.createdAt)}
										</TableCell>
										<TableCell className="text-muted-foreground text-xs">
											{passkey.lastUsedAt
												? dateFormat.format(passkey.lastUsedAt)
												: "Never"}
										</TableCell>
										<TableCell>
											<DropdownMenu>
												<DropdownMenuTrigger
													render={
														<Button
															variant="ghost"
															size="icon"
															className="size-7"
														/>
													}
												>
													<DotsVerticalIcon size={14} />
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														disabled={isBusy}
														onClick={() =>
															setRenaming({
																passkey,
																name: passkey.name ?? "",
															})
														}
													>
														<PencilIcon size={14} />
														Rename
													</DropdownMenuItem>
													<DropdownMenuItem
														variant="destructive"
														disabled={isBusy}
														onClick={() => setPendingRemoval(passkey)}
													>
														<TrashIcon size={14} />
														Remove
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Dialog
				open={renaming !== null}
				onOpenChange={(open) => {
					if (!open) setRenaming(null)
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Rename passkey</DialogTitle>
						<DialogDescription>
							Give it a name you will recognise, like "MacBook Touch ID".
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<div className="space-y-1.5">
							<Label htmlFor="passkey-name">Name</Label>
							<Input
								id="passkey-name"
								value={renaming?.name ?? ""}
								onChange={(e) =>
									setRenaming(renaming ? { ...renaming, name: e.target.value } : null)
								}
								disabled={isBusy}
								autoComplete="off"
							/>
						</div>
					</DialogPanel>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRenaming(null)} disabled={isBusy}>
							Cancel
						</Button>
						<Button
							onClick={handleRename}
							disabled={isBusy || (renaming?.name.trim().length ?? 0) === 0}
						>
							{isBusy ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRemoval(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Remove passkey?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingRemoval?.name ?? "This passkey"} can no longer be used to sign in. The
							credential stays on your device until you delete it there too.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleRemove} disabled={isBusy}>
							{isBusy ? "Removing..." : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
