import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
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
import { AlertWarningIcon, CircleCheckIcon, ShieldIcon } from "@/components/icons"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { CodeField } from "@/components/account/code-field"
import { QrCode } from "@/components/account/qr-code"

/**
 * Enrollment is a three-step dialog. `uri`/`secret` come back from `createTOTP()` and are only
 * valid for that one attempt; `backupCodes` come back from `verifyTOTP()` and are never
 * retrievable again, which is why they get their own terminal step rather than a toast.
 */
type EnrollState =
	| { step: "closed" }
	| { step: "scan"; uri: string; secret: string }
	| { step: "verify"; uri: string; secret: string; code: string }
	| { step: "codes"; codes: ReadonlyArray<string> }

export function TwoFactorSection() {
	const { user, isLoaded } = useUser()

	const [enroll, setEnroll] = useState<EnrollState>({ step: "closed" })
	const [isBusy, setIsBusy] = useState(false)
	const [disableOpen, setDisableOpen] = useState(false)

	const createTOTP = useReverification(() => user?.createTOTP())
	const disableTOTP = useReverification(() => user?.disableTOTP())
	const createBackupCode = useReverification(() => user?.createBackupCode())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const { totpEnabled, backupCodeEnabled } = user

	async function handleStartEnrollment() {
		setIsBusy(true)
		try {
			const totp = await createTOTP()
			if (!totp?.uri || !totp.secret) {
				toastManager.add({ title: "Clerk did not return a setup key", type: "error" })
				return
			}
			setEnroll({ step: "scan", uri: totp.uri, secret: totp.secret })
		} catch (err) {
			toastAccountError(err, "Failed to start two-factor setup")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleVerify(code: string) {
		if (enroll.step !== "verify" || !user || code.length < 6) return
		setIsBusy(true)
		try {
			const result = await user.verifyTOTP({ code })
			// Backup codes are minted alongside the first second factor and shown exactly once.
			// If Clerk returns none (backup codes disabled instance-wide), close out instead of
			// showing an empty list.
			const codes = result.backupCodes ?? []
			if (codes.length > 0) {
				setEnroll({ step: "codes", codes })
			} else {
				setEnroll({ step: "closed" })
			}
			toastManager.add({ title: "Two-factor authentication enabled", type: "success" })
		} catch (err) {
			toastAccountError(err, "That code did not match")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleRegenerateBackupCodes() {
		setIsBusy(true)
		try {
			const result = await createBackupCode()
			if (!result) return
			setEnroll({ step: "codes", codes: result.codes })
			toastManager.add({ title: "New backup codes generated", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to generate backup codes")
		} finally {
			setIsBusy(false)
		}
	}

	async function handleDisable() {
		setIsBusy(true)
		try {
			await disableTOTP()
			setDisableOpen(false)
			toastManager.add({ title: "Two-factor authentication disabled", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to disable two-factor authentication")
		} finally {
			setIsBusy(false)
		}
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2">
						<CardTitle>Authenticator App</CardTitle>
						{totpEnabled ? (
							<Badge variant="outline" className="gap-1">
								<CircleCheckIcon size={12} />
								Enabled
							</Badge>
						) : (
							<Badge variant="outline" className="text-muted-foreground">
								Not set up
							</Badge>
						)}
					</div>
					<CardDescription>
						Require a six-digit code from an authenticator app — 1Password, Authy, Google
						Authenticator — in addition to your password when you sign in.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{totpEnabled ? (
						<div className="flex items-center justify-between gap-4">
							<p className="text-xs text-muted-foreground">
								Your authenticator app is registered for this account.
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setDisableOpen(true)}
								disabled={isBusy}
							>
								Remove
							</Button>
						</div>
					) : (
						<Button size="sm" onClick={handleStartEnrollment} disabled={isBusy}>
							<ShieldIcon size={14} className="mr-1.5" />
							{isBusy ? "Preparing..." : "Set up authenticator"}
						</Button>
					)}
				</CardContent>
			</Card>

			{totpEnabled && (
				<Card>
					<CardHeader>
						<div className="flex items-center gap-2">
							<CardTitle>Backup Codes</CardTitle>
							{backupCodeEnabled && <Badge variant="secondary">Active</Badge>}
						</div>
						<CardDescription>
							Single-use codes for signing in when you cannot reach your authenticator.
							Generating a new set invalidates the old one.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button
							variant="outline"
							size="sm"
							onClick={handleRegenerateBackupCodes}
							disabled={isBusy}
						>
							{isBusy
								? "Generating..."
								: backupCodeEnabled
									? "Regenerate codes"
									: "Generate codes"}
						</Button>
					</CardContent>
				</Card>
			)}

			<Dialog
				open={enroll.step !== "closed"}
				onOpenChange={(open) => {
					if (!open) setEnroll({ step: "closed" })
				}}
			>
				<DialogContent>
					{enroll.step === "scan" && (
						<>
							<DialogHeader>
								<DialogTitle>Scan this code</DialogTitle>
								<DialogDescription>
									Open your authenticator app and scan the code, or enter the setup key by
									hand.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<div className="flex flex-col items-center gap-4">
									<div className="rounded-md border border-border bg-background p-3">
										<QrCode value={enroll.uri} className="size-44" />
									</div>
									<div className="w-full">
										<CopyableField
											value={enroll.secret}
											label="Setup key"
											copyLabel="Setup key"
										/>
									</div>
								</div>
							</DialogPanel>
							<DialogFooter>
								<Button variant="outline" onClick={() => setEnroll({ step: "closed" })}>
									Cancel
								</Button>
								<Button
									onClick={() =>
										setEnroll({
											step: "verify",
											uri: enroll.uri,
											secret: enroll.secret,
											code: "",
										})
									}
								>
									Continue
								</Button>
							</DialogFooter>
						</>
					)}

					{enroll.step === "verify" && (
						<>
							<DialogHeader>
								<DialogTitle>Enter the code</DialogTitle>
								<DialogDescription>
									Type the six-digit code your authenticator app is showing now.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<CodeField
									value={enroll.code}
									onValueChange={(code) => setEnroll({ ...enroll, code })}
									onValueComplete={(code) => void handleVerify(code)}
									label="Authenticator code"
								/>
							</DialogPanel>
							<DialogFooter>
								<Button
									variant="outline"
									disabled={isBusy}
									onClick={() =>
										setEnroll({
											step: "scan",
											uri: enroll.uri,
											secret: enroll.secret,
										})
									}
								>
									Back
								</Button>
								<Button
									onClick={() => void handleVerify(enroll.code)}
									disabled={isBusy || enroll.code.length < 6}
								>
									{isBusy ? "Verifying..." : "Verify"}
								</Button>
							</DialogFooter>
						</>
					)}

					{enroll.step === "codes" && (
						<>
							<DialogHeader>
								<DialogTitle>Save your backup codes</DialogTitle>
								<DialogDescription>
									Each code works once. This is the only time they are shown — store them
									somewhere safe before closing.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<div className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
									{enroll.codes.map((code) => (
										<span key={code}>{code}</span>
									))}
								</div>
							</DialogPanel>
							<DialogFooter>
								<CopyButton
									value={enroll.codes.join("\n")}
									label="Backup codes"
									idleLabel="Copy all"
									variant="outline"
								/>
								<Button onClick={() => setEnroll({ step: "closed" })}>I saved them</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>

			<AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Remove two-factor authentication?</AlertDialogTitle>
						<AlertDialogDescription>
							Your account will be protected by your password alone, and your backup codes stop
							working.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleDisable} disabled={isBusy}>
							{isBusy ? "Removing..." : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
