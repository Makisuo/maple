import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import type { EmailAddress } from "@/components/account/account-types"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import {
	AlertWarningIcon,
	CircleCheckIcon,
	DotsVerticalIcon,
	EnvelopeIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { CodeField } from "@/components/account/code-field"

/**
 * The add flow is a two-step dialog: create the address, then verify the emailed code. The
 * pending `EmailAddress` is carried in state between the steps because that resource —
 * not the user — is what `attemptVerification` is called on.
 */
type AddState =
	| { step: "closed" }
	| { step: "email"; value: string }
	| { step: "code"; address: EmailAddress; code: string }

export function EmailAddressesSection() {
	const { user, isLoaded } = useUser()

	const [add, setAdd] = useState<AddState>({ step: "closed" })
	const [isBusy, setIsBusy] = useState(false)
	const [pendingRemoval, setPendingRemoval] = useState<EmailAddress | null>(null)

	const createEmailAddress = useReverification((email: string) => user?.createEmailAddress({ email }))
	const destroyEmailAddress = useReverification((address: EmailAddress) => address.destroy())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const emails = user.emailAddresses
	const verifiedCount = emails.filter((e) => e.verification.status === "verified").length

	async function handleCreate() {
		if (add.step !== "email") return
		const email = add.value.trim()
		if (email.length === 0) return
		setIsBusy(true)
		try {
			const address = await createEmailAddress(email)
			if (!address) return
			await address.prepareVerification({ strategy: "email_code" })
			setAdd({ step: "code", address, code: "" })
		} catch (err) {
			toastAccountError(err, "Failed to add email address")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleVerify(code: string) {
		if (add.step !== "code" || code.length < 6) return
		setIsBusy(true)
		try {
			await add.address.attemptVerification({ code })
			setAdd({ step: "closed" })
			toastManager.add({ title: "Email address verified", type: "success" })
		} catch (err) {
			toastAccountError(err, "That code did not match")
		} finally {
			setIsBusy(false)
		}
	}

	/** Re-open the code step for an address added earlier but never verified. */
	async function handleResendVerification(address: EmailAddress) {
		setIsBusy(true)
		try {
			await address.prepareVerification({ strategy: "email_code" })
			setAdd({ step: "code", address, code: "" })
		} catch (err) {
			toastAccountError(err, "Failed to send a verification code")
		} finally {
			setIsBusy(false)
		}
	}

	/**
	 * Primary is a property of the *user*, not of the address — Clerk has no
	 * `emailAddress.setPrimary()`.
	 */
	async function handleSetPrimary(address: EmailAddress) {
		if (!user) return
		setIsBusy(true)
		try {
			await user.update({ primaryEmailAddressId: address.id })
			toastManager.add({ title: `${address.emailAddress} is now your primary email`, type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to change your primary email")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleRemove() {
		if (!pendingRemoval) return
		setIsBusy(true)
		try {
			await destroyEmailAddress(pendingRemoval)
			setPendingRemoval(null)
			toastManager.add({ title: "Email address removed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to remove email address")
		} finally {
			setIsBusy(false)
		}
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader className="flex flex-row items-center justify-between">
					<div className="space-y-1.5">
						<CardTitle>Email Addresses</CardTitle>
						<CardDescription>
							Your primary address receives sign-in codes, alerts and digests. Others can be
							used to sign in.
						</CardDescription>
					</div>
					<Button size="sm" onClick={() => setAdd({ step: "email", value: "" })}>
						<PlusIcon size={14} />
						Add
					</Button>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="w-10" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{emails.map((address) => {
								const isPrimary = address.id === user.primaryEmailAddressId
								const isVerified = address.verification.status === "verified"
								// Clerk requires at least one verified address, so the last one is undeletable.
								const canRemove = !isPrimary && !(isVerified && verifiedCount === 1)

								return (
									<TableRow key={address.id}>
										<TableCell className="font-medium text-xs">
											{address.emailAddress}
										</TableCell>
										<TableCell>
											<div className="flex items-center gap-1.5">
												{isPrimary && <Badge variant="secondary">Primary</Badge>}
												{isVerified ? (
													<Badge variant="outline" className="gap-1">
														<CircleCheckIcon size={12} />
														Verified
													</Badge>
												) : (
													<Badge
														variant="outline"
														className="text-muted-foreground"
													>
														Unverified
													</Badge>
												)}
											</div>
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
													{!isVerified && (
														<DropdownMenuItem
															disabled={isBusy}
															onClick={() =>
																void handleResendVerification(address)
															}
														>
															<EnvelopeIcon size={14} />
															Verify
														</DropdownMenuItem>
													)}
													{!isPrimary && isVerified && (
														<DropdownMenuItem
															disabled={isBusy}
															onClick={() => void handleSetPrimary(address)}
														>
															<CircleCheckIcon size={14} />
															Set as primary
														</DropdownMenuItem>
													)}
													<DropdownMenuItem
														variant="destructive"
														disabled={isBusy || !canRemove}
														onClick={() => setPendingRemoval(address)}
													>
														<TrashIcon size={14} />
														Remove
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Dialog
				open={add.step !== "closed"}
				onOpenChange={(open) => {
					if (!open) setAdd({ step: "closed" })
				}}
			>
				<DialogContent>
					{add.step === "code" ? (
						<>
							<DialogHeader>
								<DialogTitle>Verify {add.address.emailAddress}</DialogTitle>
								<DialogDescription>
									Enter the six-digit code we just emailed to that address.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<CodeField
									value={add.code}
									onValueChange={(code) => setAdd({ ...add, code })}
									onValueComplete={(code) => void handleVerify(code)}
									label="Verification code"
								/>
							</DialogPanel>
							<DialogFooter>
								<Button
									variant="outline"
									onClick={() => setAdd({ step: "closed" })}
									disabled={isBusy}
								>
									Cancel
								</Button>
								<Button
									onClick={() => void handleVerify(add.code)}
									disabled={isBusy || add.code.length < 6}
								>
									{isBusy ? "Verifying..." : "Verify"}
								</Button>
							</DialogFooter>
						</>
					) : (
						<>
							<DialogHeader>
								<DialogTitle>Add an email address</DialogTitle>
								<DialogDescription>
									We will send a six-digit code to confirm you own it.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<div className="space-y-1.5">
									<Label htmlFor="account-new-email">Email address</Label>
									<Input
										id="account-new-email"
										type="email"
										autoComplete="email"
										placeholder="you@example.com"
										value={add.step === "email" ? add.value : ""}
										onChange={(e) => setAdd({ step: "email", value: e.target.value })}
										disabled={isBusy}
									/>
								</div>
							</DialogPanel>
							<DialogFooter>
								<Button
									variant="outline"
									onClick={() => setAdd({ step: "closed" })}
									disabled={isBusy}
								>
									Cancel
								</Button>
								<Button
									onClick={handleCreate}
									disabled={isBusy || add.step !== "email" || add.value.trim().length === 0}
								>
									{isBusy ? "Sending..." : "Send code"}
								</Button>
							</DialogFooter>
						</>
					)}
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
						<AlertDialogTitle>Remove email address?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingRemoval?.emailAddress} can no longer be used to sign in or receive
							notifications from Maple.
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
