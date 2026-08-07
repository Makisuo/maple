import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import type { ExternalAccount, OAuthStrategy } from "@/components/account/account-types"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
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
import { cn } from "@maple/ui/lib/utils"
import { AlertWarningIcon, GithubIcon, GoogleIcon, type IconComponent } from "@/components/icons"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"

interface Provider {
	strategy: OAuthStrategy
	/** The `provider` value Clerk stamps on an `ExternalAccount`. */
	id: string
	label: string
	icon: IconComponent
}

const PROVIDERS: ReadonlyArray<Provider> = [
	{ strategy: "oauth_google", id: "google", label: "Google", icon: GoogleIcon },
	{ strategy: "oauth_github", id: "github", label: "GitHub", icon: GithubIcon },
]

export function ConnectedAccountsSection() {
	const { user, isLoaded } = useUser()

	const [busyProvider, setBusyProvider] = useState<string | null>(null)
	const [pendingRemoval, setPendingRemoval] = useState<{
		account: ExternalAccount
		label: string
	} | null>(null)

	const destroyExternalAccount = useReverification((account: ExternalAccount) => account.destroy())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	/**
	 * Linking cannot happen in a dialog: `createExternalAccount` hands back a redirect URL that
	 * the browser has to visit so the provider can run its own consent screen. Coming back to
	 * `/account?tab=connections` is what makes the new row appear.
	 */
	async function handleConnect(provider: Provider) {
		if (!user) return
		setBusyProvider(provider.id)
		try {
			const account = await user.createExternalAccount({
				strategy: provider.strategy,
				redirectUrl: "/account?tab=connections",
			})
			const redirect = account.verification?.externalVerificationRedirectURL
			if (!redirect) {
				toastManager.add({ title: `${provider.label} did not return a sign-in URL`, type: "error" })
				setBusyProvider(null)
				return
			}
			window.location.href = redirect.toString()
		} catch (err) {
			toastAccountError(err, `Failed to connect ${provider.label}`)
			setBusyProvider(null)
		}
	}

	/** An account that came back unverified needs the provider round trip run again. */
	async function handleRetry(provider: Provider, account: ExternalAccount) {
		setBusyProvider(provider.id)
		try {
			const reauthorized = await account.reauthorize({ redirectUrl: "/account?tab=connections" })
			const redirect = reauthorized.verification?.externalVerificationRedirectURL
			if (!redirect) {
				toastManager.add({ title: `${provider.label} did not return a sign-in URL`, type: "error" })
				setBusyProvider(null)
				return
			}
			window.location.href = redirect.toString()
		} catch (err) {
			toastAccountError(err, `Failed to reconnect ${provider.label}`)
			setBusyProvider(null)
		}
	}

	async function handleDisconnect() {
		if (!pendingRemoval) return
		setBusyProvider(pendingRemoval.account.provider)
		try {
			await destroyExternalAccount(pendingRemoval.account)
			setPendingRemoval(null)
			toastManager.add({ title: `${pendingRemoval.label} disconnected`, type: "success" })
		} catch (err) {
			toastAccountError(err, `Failed to disconnect ${pendingRemoval.label}`)
		} finally {
			setBusyProvider(null)
		}
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Connected Accounts</CardTitle>
					<CardDescription>
						Sign in to Maple with a provider you already use. Disconnecting one removes it as a
						sign-in method.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="max-w-xl space-y-1.5">
						{PROVIDERS.map((provider) => {
							const account = user.externalAccounts.find((a) => a.provider === provider.id)
							const isVerified = account?.verification?.status === "verified"
							const isBusy = busyProvider === provider.id

							return (
								<div
									key={provider.id}
									className={cn(
										"flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors",
										isVerified ? "border-primary/20 bg-primary/[0.02]" : "border-border",
									)}
								>
									<div className="flex min-w-0 items-center gap-3">
										<div className="text-muted-foreground">
											<provider.icon size={18} />
										</div>
										<div className="min-w-0">
											<div className="flex items-center gap-1.5">
												<p className="text-sm font-medium">{provider.label}</p>
												{account && !isVerified && (
													<Badge
														variant="outline"
														className="text-muted-foreground"
													>
														Incomplete
													</Badge>
												)}
											</div>
											<p className="truncate text-muted-foreground text-xs">
												{account
													? account.emailAddress || account.username || "Connected"
													: `Connect your ${provider.label} account`}
											</p>
										</div>
									</div>
									{account ? (
										<div className="flex shrink-0 items-center gap-2">
											{!isVerified && (
												<Button
													variant="outline"
													size="sm"
													disabled={isBusy}
													onClick={() => void handleRetry(provider, account)}
												>
													Retry
												</Button>
											)}
											<Button
												variant="ghost"
												size="sm"
												disabled={isBusy}
												onClick={() =>
													setPendingRemoval({ account, label: provider.label })
												}
											>
												Disconnect
											</Button>
										</div>
									) : (
										<Button
											variant="outline"
											size="sm"
											className="shrink-0"
											disabled={isBusy}
											onClick={() => void handleConnect(provider)}
										>
											{isBusy ? "Redirecting..." : "Connect"}
										</Button>
									)}
								</div>
							)
						})}
					</div>
				</CardContent>
			</Card>

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
						<AlertDialogTitle>Disconnect {pendingRemoval?.label}?</AlertDialogTitle>
						<AlertDialogDescription>
							You will no longer be able to sign in to Maple with {pendingRemoval?.label}. Make
							sure you still have a password, a passkey or another connected account first.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busyProvider !== null}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={handleDisconnect}
							disabled={busyProvider !== null}
						>
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
