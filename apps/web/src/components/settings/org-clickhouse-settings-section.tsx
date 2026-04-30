import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useEffect, useMemo, useState } from "react"
import { Exit, Option } from "effect"
import { toast } from "sonner"
import { formatBackendError } from "@/lib/error-messages"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Badge } from "@maple/ui/components/ui/badge"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
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
import {
	AlertWarningIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
	LoaderIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { OrgClickHouseSettingsUpsertRequest } from "@maple/domain/http"

function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
	if (Exit.isSuccess(exit)) return fallback
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	const formatted = formatBackendError(failure ?? exit)
	return formatted.description || formatted.title || fallback
}

function formatSyncDate(value: string | null): string {
	if (!value) return "Never"
	try {
		return new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(new Date(value))
	} catch {
		return value
	}
}

function shortRevision(rev: string | null): string {
	if (!rev) return "—"
	return rev.length > 10 ? rev.slice(0, 10) : rev
}

interface OrgClickHouseSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

export function OrgClickHouseSettingsSection({
	isAdmin,
	hasEntitlement,
}: OrgClickHouseSettingsSectionProps) {
	const [chUrl, setChUrl] = useState("")
	const [chUser, setChUser] = useState("default")
	const [chPassword, setChPassword] = useState("")
	const [chDatabase, setChDatabase] = useState("default")
	const [isSaving, setIsSaving] = useState(false)
	const [isApplying, setIsApplying] = useState(false)
	const [isRefreshingDiff, setIsRefreshingDiff] = useState(false)
	const [disableOpen, setDisableOpen] = useState(false)
	const [isDisabling, setIsDisabling] = useState(false)
	const [expandedDrifts, setExpandedDrifts] = useState<ReadonlySet<string>>(new Set())

	const settingsQueryAtom = MapleApiAtomClient.query("orgClickHouseSettings", "get", {})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const diffQueryAtom = MapleApiAtomClient.query("orgClickHouseSettings", "schemaDiff", {})
	const diffResult = useAtomValue(diffQueryAtom)
	const refreshDiff = useAtomRefresh(diffQueryAtom)

	const upsertMutation = useAtomSet(MapleApiAtomClient.mutation("orgClickHouseSettings", "upsert"), {
		mode: "promiseExit",
	})
	const applyMutation = useAtomSet(
		MapleApiAtomClient.mutation("orgClickHouseSettings", "applySchema"),
		{ mode: "promiseExit" },
	)
	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("orgClickHouseSettings", "delete"), {
		mode: "promiseExit",
	})

	const settings = Result.builder(settingsResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const diff = Result.builder(diffResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const configured = settings?.configured === true
	const isBusy = isSaving || isApplying || isRefreshingDiff || isDisabling

	useEffect(() => {
		if (settings?.chUrl != null) setChUrl(settings.chUrl)
		if (settings?.chUser != null) setChUser(settings.chUser)
		if (settings?.chDatabase != null) setChDatabase(settings.chDatabase)
	}, [settings?.chUrl, settings?.chUser, settings?.chDatabase])

	const isValidUrl = useMemo(() => {
		const trimmed = chUrl.trim()
		if (trimmed.length === 0) return false
		try {
			const url = new URL(trimmed)
			return url.protocol === "https:" || url.protocol === "http:"
		} catch {
			return false
		}
	}, [chUrl])

	const statusBadge = useMemo(() => {
		if (!configured) return <Badge variant="secondary">Default Maple Tinybird</Badge>
		if (settings?.syncStatus === "error") return <Badge variant="destructive">Needs attention</Badge>
		return <Badge variant="outline">Connected</Badge>
	}, [configured, settings?.syncStatus])

	const diffSummary = useMemo(() => {
		if (!diff) return null
		const counts = { up_to_date: 0, missing: 0, drifted: 0 }
		for (const entry of diff.entries) counts[entry.status]++
		return counts
	}, [diff])

	async function handleSave() {
		setIsSaving(true)
		const result = await upsertMutation({
			payload: new OrgClickHouseSettingsUpsertRequest({
				url: chUrl,
				user: chUser,
				password: chPassword,
				database: chDatabase,
			}),
		})
		setIsSaving(false)

		if (Exit.isSuccess(result)) {
			setChPassword("")
			refreshSettings()
			refreshDiff()
			toast.success("ClickHouse connection saved")
			return
		}
		toast.error(getExitErrorMessage(result, "Failed to save settings"))
	}

	async function handleApply() {
		setIsApplying(true)
		const result = await applyMutation({})
		setIsApplying(false)

		if (Exit.isSuccess(result)) {
			refreshSettings()
			refreshDiff()
			const value = result.value
			const appliedCount = value.applied.length
			const skippedCount = value.skipped.length
			if (appliedCount === 0 && skippedCount === 0) {
				toast.success("Schema is already up to date")
			} else if (skippedCount === 0) {
				toast.success(`Applied ${appliedCount} schema item${appliedCount === 1 ? "" : "s"}`)
			} else {
				toast.warning(
					`Applied ${appliedCount}, skipped ${skippedCount} drifted item${skippedCount === 1 ? "" : "s"}`,
				)
			}
			return
		}
		toast.error(getExitErrorMessage(result, "Failed to apply schema"))
	}

	async function handleRefreshDiff() {
		setIsRefreshingDiff(true)
		refreshDiff()
		// Atom refresh is fire-and-forget; tiny delay so the spinner is visible on
		// fast re-runs and we don't end the busy state before the new request lands.
		await new Promise((resolve) => setTimeout(resolve, 300))
		setIsRefreshingDiff(false)
	}

	async function handleDisable() {
		setIsDisabling(true)
		const result = await deleteMutation({})
		setIsDisabling(false)
		setDisableOpen(false)

		if (Exit.isSuccess(result)) {
			setChUrl("")
			setChPassword("")
			refreshSettings()
			refreshDiff()
			toast.success("BYO ClickHouse disabled")
			return
		}
		toast.error(getExitErrorMessage(result, "Failed to disable BYO ClickHouse"))
	}

	function toggleDriftRow(name: string) {
		setExpandedDrifts((prev) => {
			const next = new Set(prev)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})
	}

	if (!isAdmin || !hasEntitlement) return null

	return (
		<>
			<div className="max-w-2xl space-y-6">
				<Card>
					<CardHeader>
						<div className="flex items-center justify-between gap-3">
							<div className="space-y-1">
								<CardTitle>Bring your own ClickHouse</CardTitle>
								<CardDescription>
									Route this organization&apos;s read queries through your own ClickHouse
									server. Save the connection first, then review the schema diff and apply
									the bundled snapshot to your cluster.
								</CardDescription>
							</div>
							{Result.isInitial(settingsResult) ? (
								<Skeleton className="h-6 w-36" />
							) : (
								statusBadge
							)}
						</div>
					</CardHeader>
					<CardContent className="space-y-5">
						{!Result.isSuccess(settingsResult) && !Result.isInitial(settingsResult) ? (
							<p className="text-sm text-muted-foreground">Failed to load settings.</p>
						) : (
							<>
								<div className="grid gap-2">
									<Label htmlFor="ch-url">ClickHouse URL</Label>
									<Input
										id="ch-url"
										placeholder="https://your-clickhouse.example.com:8123"
										value={chUrl}
										onChange={(event) => setChUrl(event.target.value)}
										disabled={isBusy}
									/>
									<p className="text-muted-foreground text-xs">
										HTTP interface URL (port 8123 by default).
									</p>
								</div>

								<div className="grid gap-2 sm:grid-cols-2">
									<div className="grid gap-2">
										<Label htmlFor="ch-user">User</Label>
										<Input
											id="ch-user"
											value={chUser}
											onChange={(event) => setChUser(event.target.value)}
											disabled={isBusy}
										/>
									</div>
									<div className="grid gap-2">
										<Label htmlFor="ch-database">Database</Label>
										<Input
											id="ch-database"
											value={chDatabase}
											onChange={(event) => setChDatabase(event.target.value)}
											disabled={isBusy}
										/>
									</div>
								</div>

								<div className="grid gap-2">
									<Label htmlFor="ch-password">Password</Label>
									<Input
										id="ch-password"
										type="password"
										placeholder={
											configured ? "Leave blank to keep the current password" : "Optional"
										}
										value={chPassword}
										onChange={(event) => setChPassword(event.target.value)}
										disabled={isBusy}
									/>
									<p className="text-muted-foreground text-xs">
										Leave blank for unauthenticated CH instances or to keep the existing
										password.
									</p>
								</div>

								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => void handleSave()}
										disabled={
											isBusy ||
											!isValidUrl ||
											chUser.trim().length === 0 ||
											chDatabase.trim().length === 0
										}
									>
										{isSaving
											? "Saving..."
											: configured
												? "Update connection"
												: "Save connection"}
									</Button>
									<Button
										variant="destructive"
										onClick={() => setDisableOpen(true)}
										disabled={isBusy || !configured}
									>
										Disable BYO
									</Button>
								</div>
							</>
						)}
					</CardContent>
				</Card>

				{configured ? (
					<Card>
						<CardHeader>
							<div className="flex items-center justify-between gap-3">
								<div className="space-y-1">
									<CardTitle>Schema</CardTitle>
									<CardDescription>
										Compare your cluster against Maple&apos;s bundled schema snapshot. Apply
										creates missing tables and views; drifted ones are skipped — resolve
										those manually before applying.
									</CardDescription>
								</div>
							</div>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="grid grid-cols-2 gap-3 rounded-lg border px-4 py-3 text-sm sm:grid-cols-4">
								<div>
									<p className="text-muted-foreground text-xs">Last applied</p>
									<p>{formatSyncDate(settings?.lastSyncAt ?? null)}</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">Applied version</p>
									<p className="font-mono text-xs">
										{shortRevision(settings?.schemaVersion ?? null)}
									</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">Expected version</p>
									<p className="font-mono text-xs">
										{shortRevision(diff?.expectedSchemaVersion ?? null)}
									</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">Drift</p>
									<p>
										{diffSummary
											? `${diffSummary.up_to_date} ok · ${diffSummary.missing} missing · ${diffSummary.drifted} drift`
											: "—"}
									</p>
								</div>
							</div>

							{Result.isInitial(diffResult) ? (
								<div className="space-y-2">
									<Skeleton className="h-9 w-full" />
									<Skeleton className="h-9 w-full" />
									<Skeleton className="h-9 w-full" />
								</div>
							) : !Result.isSuccess(diffResult) ? (
								<div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
									Failed to introspect ClickHouse —{" "}
									{getExitErrorMessage(
										diffResult as unknown as Exit.Exit<unknown, unknown>,
										"check that credentials are valid",
									)}
								</div>
							) : diff && diff.entries.length > 0 ? (
								<div className="divide-y rounded-md border">
									{diff.entries.map((entry) => {
										const isExpanded = expandedDrifts.has(entry.name)
										const isDrifted = entry.status === "drifted"
										return (
											<div key={entry.name} className="px-3 py-2 text-sm">
												<button
													type="button"
													className={
														"flex w-full items-center gap-2 text-left " +
														(isDrifted ? "cursor-pointer" : "cursor-default")
													}
													onClick={() => isDrifted && toggleDriftRow(entry.name)}
												>
													{entry.status === "up_to_date" ? (
														<CircleCheckIcon
															size={14}
															className="text-severity-ok shrink-0"
														/>
													) : entry.status === "missing" ? (
														<CircleXmarkIcon
															size={14}
															className="text-destructive shrink-0"
														/>
													) : (
														<CircleWarningIcon
															size={14}
															className="text-severity-warn shrink-0"
														/>
													)}
													<span className="font-mono text-xs">{entry.name}</span>
													<span className="text-muted-foreground text-xs">
														{entry.kind === "materialized_view" ? "MV" : "table"}
													</span>
													<span className="ml-auto text-xs">
														{entry.status === "up_to_date"
															? "Up to date"
															: entry.status === "missing"
																? "Missing — will be created"
																: `Drift: ${entry.columnDrifts.length} mismatch${entry.columnDrifts.length === 1 ? "" : "es"}`}
													</span>
													{isDrifted ? (
														isExpanded ? (
															<ChevronDownIcon size={12} />
														) : (
															<ChevronRightIcon size={12} />
														)
													) : null}
												</button>
												{isDrifted && isExpanded ? (
													<ul className="mt-2 ml-6 space-y-1 font-mono text-xs">
														{entry.columnDrifts.map((drift, idx) => (
															<li key={`${entry.name}-${idx}`} className="text-muted-foreground">
																{drift.kind === "missing"
																	? `– missing column \`${drift.column}\` (expected ${drift.expectedType})`
																	: drift.kind === "extra"
																		? `– extra column \`${drift.column}\` (${drift.actualType})`
																		: `– type mismatch on \`${drift.column}\`: expected ${drift.expectedType}, got ${drift.actualType}`}
															</li>
														))}
													</ul>
												) : null}
											</div>
										)
									})}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">No tables in the schema.</p>
							)}

							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									onClick={() => void handleRefreshDiff()}
									disabled={isBusy}
								>
									{isRefreshingDiff ? (
										<>
											<LoaderIcon size={12} className="mr-1 animate-spin" />
											Refreshing...
										</>
									) : (
										"Refresh diff"
									)}
								</Button>
								<Button
									onClick={() => void handleApply()}
									disabled={
										isBusy ||
										!diff ||
										(diffSummary?.missing === 0 && diffSummary?.drifted === 0)
									}
								>
									{isApplying ? (
										<>
											<LoaderIcon size={12} className="mr-1 animate-spin" />
											Applying...
										</>
									) : diffSummary && diffSummary.missing > 0 ? (
										`Apply schema (${diffSummary.missing} missing${diffSummary.drifted > 0 ? `, ${diffSummary.drifted} skipped` : ""})`
									) : (
										"Apply schema"
									)}
								</Button>
							</div>
						</CardContent>
					</Card>
				) : null}
			</div>

			<AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
				<AlertDialogContent>
					<AlertDialogMedia>
						<AlertWarningIcon className="text-severity-warn" size={20} />
					</AlertDialogMedia>
					<AlertDialogHeader>
						<AlertDialogTitle>Disable BYO ClickHouse?</AlertDialogTitle>
						<AlertDialogDescription>
							This org will fall back to the default Maple-managed Tinybird Cloud. Tables in
							your ClickHouse cluster are NOT touched — disable just removes Maple&apos;s
							pointer to it.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisabling}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault()
								void handleDisable()
							}}
							disabled={isDisabling}
						>
							{isDisabling ? "Disabling..." : "Disable"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
