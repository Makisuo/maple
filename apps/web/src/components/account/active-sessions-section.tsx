import { useState } from "react"
import { useReverification, useSession, useUser } from "@clerk/clerk-react"
import type { SessionWithActivities } from "@/components/account/account-types"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { AlertWarningIcon, ComputerIcon, MobileIcon } from "@/components/icons"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { toastAccountError } from "@/components/account/account-errors"

type LoadState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; sessions: ReadonlyArray<SessionWithActivities> }

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "3 minutes ago" from a timestamp, coarsening upwards so long-idle sessions read as days. */
function formatLastActive(date: Date): string {
	const seconds = Math.round((date.getTime() - Date.now()) / 1000)
	const magnitude = Math.abs(seconds)
	if (magnitude < 60) return relative.format(seconds, "second")
	if (magnitude < 3600) return relative.format(Math.round(seconds / 60), "minute")
	if (magnitude < 86_400) return relative.format(Math.round(seconds / 3600), "hour")
	return relative.format(Math.round(seconds / 86_400), "day")
}

function describeDevice(session: SessionWithActivities): string {
	const { browserName, browserVersion, deviceType } = session.latestActivity
	const browser = [browserName, browserVersion].filter(Boolean).join(" ")
	return [deviceType, browser].filter(Boolean).join(" · ") || "Unknown device"
}

function describeLocation(session: SessionWithActivities): string {
	const { city, country, ipAddress } = session.latestActivity
	return [city, country].filter(Boolean).join(", ") || ipAddress || "Unknown location"
}

export function ActiveSessionsSection() {
	const { user, isLoaded } = useUser()
	const { session: currentSession } = useSession()

	const [state, setState] = useState<LoadState>({ status: "loading" })
	const [pendingRevoke, setPendingRevoke] = useState<SessionWithActivities | null>(null)
	const [isRevoking, setIsRevoking] = useState(false)

	const revokeSession = useReverification((session: SessionWithActivities) => session.revoke())

	// `user.getSessions()` is imperative — Clerk exposes no hook for other-device sessions — so
	// this is the sanctioned mount-effect escape hatch rather than a `useEffect`.
	useMountEffect(() => {
		void load()
	})

	async function load() {
		if (!user) return
		try {
			const sessions = await user.getSessions()
			setState({ status: "ready", sessions })
		} catch (err) {
			setState({
				status: "error",
				message: err instanceof Error ? err.message : "Failed to load your sessions",
			})
		}
	}

	async function handleRevoke() {
		if (!pendingRevoke) return
		setIsRevoking(true)
		try {
			await revokeSession(pendingRevoke)
			setPendingRevoke(null)
			toastManager.add({ title: "Session signed out", type: "success" })
			// `revoke()` returns only the one session, so refetch rather than patching state and
			// risking a list that disagrees with Clerk about what is still active.
			await load()
		} catch (err) {
			toastAccountError(err, "Failed to sign out that session")
		} finally {
			setIsRevoking(false)
		}
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Active Sessions</CardTitle>
					<CardDescription>
						Devices currently signed in to your account. Sign out any you do not recognise.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{!isLoaded || state.status === "loading" ? (
						<div className="space-y-2">
							<Skeleton className="h-9 w-full" />
							<Skeleton className="h-9 w-full" />
						</div>
					) : state.status === "error" ? (
						<div className="flex items-center justify-between gap-4">
							<p className="text-sm text-destructive">{state.message}</p>
							<Button variant="outline" size="sm" onClick={() => void load()}>
								Retry
							</Button>
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Device</TableHead>
									<TableHead>Location</TableHead>
									<TableHead>Last active</TableHead>
									<TableHead className="w-24" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{state.sessions.map((session) => {
									const isCurrent = session.id === currentSession?.id
									const DeviceIcon = session.latestActivity.isMobile
										? MobileIcon
										: ComputerIcon

									return (
										<TableRow key={session.id}>
											<TableCell>
												<div className="flex items-center gap-2.5">
													<DeviceIcon
														size={16}
														className="shrink-0 text-muted-foreground"
													/>
													<span className="text-xs font-medium">
														{describeDevice(session)}
													</span>
													{isCurrent && (
														<Badge variant="secondary">This device</Badge>
													)}
												</div>
											</TableCell>
											<TableCell className="text-muted-foreground text-xs">
												{describeLocation(session)}
											</TableCell>
											<TableCell className="text-muted-foreground text-xs">
												{formatLastActive(session.lastActiveAt)}
											</TableCell>
											<TableCell>
												{/* Revoking the current session would sign the user out from
												    inside the page they are using; use Log out for that. */}
												{!isCurrent && (
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setPendingRevoke(session)}
													>
														Sign out
													</Button>
												)}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<AlertDialog
				open={pendingRevoke !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRevoke(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Sign out this device?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingRevoke ? describeDevice(pendingRevoke) : "This session"} will need to sign
							in again to reach Maple.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleRevoke} disabled={isRevoking}>
							{isRevoking ? "Signing out..." : "Sign out"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
