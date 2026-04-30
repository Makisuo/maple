import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { AlertWarningIcon, LoaderIcon } from "@/components/icons"
import { formatLatency, formatNumber } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { OrgTinybirdSettingsUpsertRequest } from "@maple/domain/http"

function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
	if (Exit.isSuccess(exit)) return fallback

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	const formatted = formatBackendError(failure ?? exit)
	return formatted.description || formatted.title || fallback
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000_000) {
		return `${(bytes / 1_000_000_000).toFixed(2)} GB`
	}
	if (bytes >= 1_000_000) {
		return `${(bytes / 1_000_000).toFixed(2)} MB`
	}
	if (bytes >= 1_000) {
		return `${(bytes / 1_000).toFixed(1)} KB`
	}
	return `${bytes} B`
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

function formatDeploymentStatus(value: string | null | undefined): string {
	if (!value) return "Unknown"

	switch (value) {
		case "pending":
		case "deploying":
			return "Deploying"
		case "data_ready":
			return "Ready"
		case "live":
		case "succeeded":
			return "Live"
		case "failed":
		case "error":
		case "deleted":
		case "deleting":
			return "Failed"
		default:
			// Any intermediate Tinybird status (e.g. creating_schema, populating) is
			// still part of the deploy pipeline — show "Deploying" rather than leak
			// the raw backend string.
			return "Deploying"
	}
}

interface OrgTinybirdSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

const DEFAULT_LOGS_RETENTION_DAYS = 90
const DEFAULT_TRACES_RETENTION_DAYS = 90
const DEFAULT_METRICS_RETENTION_DAYS = 365

type RetentionParse =
	| { readonly kind: "empty" }
	| { readonly kind: "valid"; readonly value: number }
	| { readonly kind: "invalid" }

function parseRetentionInput(raw: string): RetentionParse {
	const trimmed = raw.trim()
	if (trimmed.length === 0) return { kind: "empty" }
	const parsed = Number(trimmed)
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) return { kind: "invalid" }
	return { kind: "valid", value: parsed }
}

const retentionOrNull = (parsed: RetentionParse): number | null =>
	parsed.kind === "valid" ? parsed.value : null

type Backend = "tinybird" | "clickhouse"

export function OrgTinybirdSettingsSection({ isAdmin, hasEntitlement }: OrgTinybirdSettingsSectionProps) {
	const [backend, setBackend] = useState<Backend>("tinybird")
	const [host, setHost] = useState("")
	const [token, setToken] = useState("")
	const [chUrl, setChUrl] = useState("")
	const [chUser, setChUser] = useState("default")
	const [chPassword, setChPassword] = useState("")
	const [chDatabase, setChDatabase] = useState("default")
	const [logsRetention, setLogsRetention] = useState("")
	const [tracesRetention, setTracesRetention] = useState("")
	const [metricsRetention, setMetricsRetention] = useState("")
	const [isSaving, setIsSaving] = useState(false)
	const [isResyncing, setIsResyncing] = useState(false)
	const [disableOpen, setDisableOpen] = useState(false)
	const [isDisabling, setIsDisabling] = useState(false)

	const settingsQueryAtom = MapleApiAtomClient.query("orgTinybirdSettings", "get", {})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const deploymentStatusAtom = MapleApiAtomClient.query("orgTinybirdSettings", "deploymentStatus", {})
	const deploymentStatusResult = useAtomValue(deploymentStatusAtom)
	const refreshDeploymentStatus = useAtomRefresh(deploymentStatusAtom)

	const instanceHealthAtom = MapleApiAtomClient.query("orgTinybirdSettings", "instanceHealth", {})
	const instanceHealthResult = useAtomValue(instanceHealthAtom)

	const upsertMutation = useAtomSet(MapleApiAtomClient.mutation("orgTinybirdSettings", "upsert"), {
		mode: "promiseExit",
	})
	const resyncMutation = useAtomSet(MapleApiAtomClient.mutation("orgTinybirdSettings", "resync"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("orgTinybirdSettings", "delete"), {
		mode: "promiseExit",
	})

	const settings = Result.builder(settingsResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const deploymentStatus = Result.builder(deploymentStatusResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const instanceHealth = Result.builder(instanceHealthResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const isDeploying = deploymentStatus?.hasRun === true && deploymentStatus?.isTerminal === false
	const isBusy = isSaving || isResyncing || isDisabling || isDeploying
	const configured = settings?.configured === true
	const hasSavedToken = configured || settings?.draftHost != null
	const activeHost = settings?.activeHost ?? null
	const draftHost = settings?.draftHost ?? null
	const deploymentState = deploymentStatus?.deploymentStatus ?? deploymentStatus?.status ?? null
	const deploymentId = deploymentStatus?.deploymentId ?? null
	const deploymentLabel = formatDeploymentStatus(deploymentState)
	const hasKnownDeployment = deploymentStatus?.hasRun === true
	const deploymentFailed =
		deploymentStatus?.runStatus === "failed" ||
		deploymentState === "failed" ||
		deploymentState === "error" ||
		deploymentState === "deleted" ||
		deploymentState === "deleting"
	const deploymentError = deploymentFailed
		? (deploymentStatus?.errorMessage ?? settings?.lastSyncError ?? null)
		: null

	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

	const startPolling = useCallback(() => {
		if (pollRef.current) return
		pollRef.current = setInterval(() => {
			refreshDeploymentStatus()
		}, 3000)
	}, [refreshDeploymentStatus])

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current)
			pollRef.current = null
		}
	}, [])

	useEffect(() => {
		if (isDeploying) {
			startPolling()
		} else if (pollRef.current) {
			stopPolling()
			refreshSettings()
		}
		return stopPolling
	}, [isDeploying, startPolling, stopPolling, refreshSettings])

	const isValidHost = useMemo(() => {
		const trimmed = host.trim()
		if (trimmed.length === 0) return false
		try {
			const url = new URL(trimmed)
			return url.protocol === "https:" || url.protocol === "http:"
		} catch {
			return false
		}
	}, [host])

	useEffect(() => {
		const nextHost = settings?.draftHost ?? settings?.activeHost ?? ""
		if (nextHost.length > 0) {
			setHost(nextHost)
		} else if (settings?.configured === false) {
			setHost("")
		}
	}, [settings?.activeHost, settings?.configured, settings?.draftHost])

	// Hydrate the backend selector + ClickHouse fields from the saved row when
	// the backend is "clickhouse" — there's no draft state for CH (no sync
	// workflow) so the active row IS the source of truth.
	useEffect(() => {
		if (settings?.backend != null) {
			setBackend(settings.backend)
		}
		if (settings?.chUrl != null) setChUrl(settings.chUrl)
		if (settings?.chUser != null) setChUser(settings.chUser)
		if (settings?.chDatabase != null) setChDatabase(settings.chDatabase)
	}, [settings?.backend, settings?.chUrl, settings?.chUser, settings?.chDatabase])

	useEffect(() => {
		setLogsRetention(settings?.logsRetentionDays != null ? String(settings.logsRetentionDays) : "")
		setTracesRetention(settings?.tracesRetentionDays != null ? String(settings.tracesRetentionDays) : "")
		setMetricsRetention(
			settings?.metricsRetentionDays != null ? String(settings.metricsRetentionDays) : "",
		)
	}, [settings?.logsRetentionDays, settings?.tracesRetentionDays, settings?.metricsRetentionDays])

	const parsedLogsRetention = useMemo(() => parseRetentionInput(logsRetention), [logsRetention])
	const parsedTracesRetention = useMemo(() => parseRetentionInput(tracesRetention), [tracesRetention])
	const parsedMetricsRetention = useMemo(() => parseRetentionInput(metricsRetention), [metricsRetention])
	const retentionInvalid =
		parsedLogsRetention.kind === "invalid" ||
		parsedTracesRetention.kind === "invalid" ||
		parsedMetricsRetention.kind === "invalid"

	const statusBadge = useMemo(() => {
		if (isDeploying) {
			return (
				<Badge variant="secondary">
					<LoaderIcon size={12} className="mr-1 animate-spin" />
					Deploying
				</Badge>
			)
		}
		if (settings?.syncStatus === "error") {
			return <Badge variant="destructive">Needs attention</Badge>
		}
		if (!configured) {
			return <Badge variant="secondary">Default Maple Tinybird</Badge>
		}
		if (settings?.syncStatus === "out_of_sync") {
			return <Badge variant="secondary">Out of sync</Badge>
		}
		if (settings?.syncStatus === "active") {
			return <Badge variant="outline">Connected</Badge>
		}

		return <Badge variant="destructive">Needs attention</Badge>
	}, [configured, isDeploying, settings?.syncStatus])

	async function handleSave() {
		if (backend === "tinybird" && retentionInvalid) {
			toast.error("Retention values must be integers between 1 and 3650")
			return
		}
		setIsSaving(true)
		const result = await upsertMutation({
			payload:
				backend === "clickhouse"
					? new OrgTinybirdSettingsUpsertRequest({
							backend: "clickhouse",
							url: chUrl,
							user: chUser,
							password: chPassword,
							database: chDatabase,
						})
					: new OrgTinybirdSettingsUpsertRequest({
							backend: "tinybird",
							host,
							token,
							logsRetentionDays: retentionOrNull(parsedLogsRetention),
							tracesRetentionDays: retentionOrNull(parsedTracesRetention),
							metricsRetentionDays: retentionOrNull(parsedMetricsRetention),
						}),
		})
		setIsSaving(false)

		if (Exit.isSuccess(result)) {
			setToken("")
			setChPassword("")
			refreshSettings()
			refreshDeploymentStatus()
			toast.success(
				backend === "clickhouse"
					? "ClickHouse connection saved"
					: configured
						? "Tinybird sync started"
						: "Tinybird connection saved and sync started",
			)
			return
		}

		toast.error(getExitErrorMessage(result, "Failed to save settings"))
	}

	async function handleResync() {
		setIsResyncing(true)
		const result = await resyncMutation({})
		setIsResyncing(false)

		if (Exit.isSuccess(result)) {
			refreshSettings()
			refreshDeploymentStatus()
			toast.success("Tinybird resync started")
			return
		}

		toast.error(getExitErrorMessage(result, "Failed to sync Tinybird project"))
	}

	async function handleDisable() {
		setIsDisabling(true)
		const result = await deleteMutation({})
		setIsDisabling(false)
		setDisableOpen(false)

		if (Exit.isSuccess(result)) {
			setHost("")
			setToken("")
			refreshSettings()
			toast.success("BYO Tinybird disabled")
			return
		}

		toast.error(getExitErrorMessage(result, "Failed to disable BYO Tinybird"))
	}

	if (!isAdmin || !hasEntitlement) {
		return null
	}

	return (
		<>
			<div className="max-w-2xl space-y-6">
				<Card>
					<CardHeader>
						<div className="flex items-center justify-between gap-3">
							<div className="space-y-1">
								<CardTitle>Bring your own backend</CardTitle>
								<CardDescription>
									Route this organization&apos;s read queries through its own Tinybird
									workspace or ClickHouse server. Tinybird mode keeps Maple&apos;s project
									definition synced for you; ClickHouse mode expects you to apply the schema
									yourself via the <code className="font-mono">clickhouse:schema:apply</code>{" "}
									CLI.
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
									<Label>Backend</Label>
									<div className="flex gap-2">
										<Button
											type="button"
											size="sm"
											variant={backend === "tinybird" ? "default" : "outline"}
											onClick={() => setBackend("tinybird")}
											disabled={isBusy}
										>
											Tinybird
										</Button>
										<Button
											type="button"
											size="sm"
											variant={backend === "clickhouse" ? "default" : "outline"}
											onClick={() => setBackend("clickhouse")}
											disabled={isBusy}
										>
											ClickHouse
										</Button>
									</div>
									{configured && settings?.backend != null && settings.backend !== backend ? (
										<p className="text-muted-foreground text-xs">
											You&apos;re currently configured for{" "}
											{settings.backend === "clickhouse" ? "ClickHouse" : "Tinybird"}. Saving
											will replace it with the new backend.
										</p>
									) : null}
								</div>

								{backend === "clickhouse" ? (
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
													configured && settings?.backend === "clickhouse"
														? "Leave blank to keep the current password"
														: "Optional"
												}
												value={chPassword}
												onChange={(event) => setChPassword(event.target.value)}
												disabled={isBusy}
											/>
											<p className="text-muted-foreground text-xs">
												Leave blank for unauthenticated CH instances or to keep the
												existing password.
											</p>
										</div>
									</>
								) : null}

								{backend === "tinybird" ? (
								<>
								<div className="grid gap-2">
									<Label htmlFor="tinybird-host">Tinybird host</Label>
									<Input
										id="tinybird-host"
										placeholder="https://api.tinybird.co"
										value={host}
										onChange={(event) => setHost(event.target.value)}
										disabled={isBusy}
									/>
									{host.trim().length > 0 && !isValidHost ? (
										<p className="text-destructive text-xs">
											Enter a valid URL (e.g. https://api.tinybird.co)
										</p>
									) : null}
								</div>

								<div className="grid gap-2">
									<Label htmlFor="tinybird-token">Tinybird token</Label>
									<Input
										id="tinybird-token"
										type="password"
										placeholder={
											configured ? "Leave blank to keep the current token" : "tbp_..."
										}
										value={token}
										onChange={(event) => setToken(event.target.value)}
										disabled={isBusy}
									/>
									<p className="text-muted-foreground text-xs">
										The token is write-only. Leave it blank to keep the saved draft or
										active token.
									</p>
								</div>

								<div className="grid gap-3 rounded-lg border px-4 py-3">
									<div className="space-y-1">
										<p className="text-sm font-medium">Raw data retention</p>
										<p className="text-muted-foreground text-xs">
											Override the TTL Maple applies to raw ingest tables in your
											Tinybird project. Leave a field blank to use Maple&apos;s default.
											Changes trigger a redeploy on save.
										</p>
									</div>
									<div className="grid gap-3 sm:grid-cols-3">
										<div className="grid gap-1.5">
											<Label htmlFor="tinybird-logs-retention" className="text-xs">
												Logs (days)
											</Label>
											<Input
												id="tinybird-logs-retention"
												type="number"
												min={1}
												max={3650}
												inputMode="numeric"
												placeholder={String(DEFAULT_LOGS_RETENTION_DAYS)}
												value={logsRetention}
												onChange={(event) => setLogsRetention(event.target.value)}
												disabled={isBusy}
												aria-invalid={parsedLogsRetention.kind === "invalid"}
											/>
										</div>
										<div className="grid gap-1.5">
											<Label htmlFor="tinybird-traces-retention" className="text-xs">
												Traces (days)
											</Label>
											<Input
												id="tinybird-traces-retention"
												type="number"
												min={1}
												max={3650}
												inputMode="numeric"
												placeholder={String(DEFAULT_TRACES_RETENTION_DAYS)}
												value={tracesRetention}
												onChange={(event) => setTracesRetention(event.target.value)}
												disabled={isBusy}
												aria-invalid={parsedTracesRetention.kind === "invalid"}
											/>
										</div>
										<div className="grid gap-1.5">
											<Label htmlFor="tinybird-metrics-retention" className="text-xs">
												Metrics (days)
											</Label>
											<Input
												id="tinybird-metrics-retention"
												type="number"
												min={1}
												max={3650}
												inputMode="numeric"
												placeholder={String(DEFAULT_METRICS_RETENTION_DAYS)}
												value={metricsRetention}
												onChange={(event) => setMetricsRetention(event.target.value)}
												disabled={isBusy}
												aria-invalid={parsedMetricsRetention.kind === "invalid"}
											/>
										</div>
									</div>
									{retentionInvalid ? (
										<p className="text-destructive text-xs">
											Retention values must be whole numbers between 1 and 3650 days.
										</p>
									) : null}
								</div>

								<div className="rounded-lg border px-4 py-3 text-sm">
									<div className="flex items-center justify-between gap-3">
										<span className="text-muted-foreground">Active target</span>
										<span className="font-mono text-xs">
											{activeHost ?? "Maple-managed Tinybird"}
										</span>
									</div>
									{draftHost ? (
										<div className="mt-2 flex items-center justify-between gap-3">
											<span className="text-muted-foreground">Draft target</span>
											<span className="font-mono text-xs">{draftHost}</span>
										</div>
									) : null}
									<div className="mt-2 flex items-center justify-between gap-3">
										<span className="text-muted-foreground">Last sync</span>
										<span>{formatSyncDate(settings?.lastSyncAt ?? null)}</span>
									</div>
									<div className="mt-2 flex items-center justify-between gap-3">
										<span className="text-muted-foreground">Project revision</span>
										<span className="font-mono text-xs">
											{settings?.projectRevision ?? "Not configured"}
										</span>
									</div>
									<div className="mt-2 flex items-center justify-between gap-3">
										<span className="text-muted-foreground">Deployment</span>
										{hasKnownDeployment ? (
											<span className="flex items-center gap-2 text-xs">
												{isDeploying ? (
													<LoaderIcon size={12} className="animate-spin" />
												) : null}
												{deploymentId ? (
													<span className="font-mono">#{deploymentId}</span>
												) : null}
												<span>{deploymentLabel}</span>
											</span>
										) : (
											<span>No deployments yet</span>
										)}
									</div>
									{settings?.syncStatus === "out_of_sync" ? (
										<div className="mt-3 rounded-md border border-severity-warn/30 bg-severity-warn/10 px-3 py-2 text-severity-warn">
											Maple&apos;s Tinybird project definition changed since this org
											last synced. Resync the project to keep BYO queries working.
										</div>
									) : null}
									{deploymentError ? (
										<div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-destructive">
											{deploymentError}
										</div>
									) : null}
								</div>
								</>
								) : null}

								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => void handleSave()}
										disabled={(() => {
											if (isBusy) return true
											if (backend === "clickhouse") {
												return (
													chUrl.trim().length === 0 ||
													chUser.trim().length === 0 ||
													chDatabase.trim().length === 0
												)
											}
											return (
												!isValidHost ||
												retentionInvalid ||
												(!hasSavedToken && token.trim().length === 0)
											)
										})()}
									>
										{isSaving
											? "Saving..."
											: configured
												? "Update connection"
												: "Save connection"}
									</Button>
									{backend === "tinybird" ? (
										<Button
											variant="outline"
											onClick={() => void handleResync()}
											disabled={isBusy || !configured}
										>
											{isResyncing ? "Syncing..." : "Resync project"}
										</Button>
									) : null}
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

				{configured && settings?.backend !== "clickhouse" ? (
					<Card>
						<CardHeader>
							<div className="flex items-center justify-between gap-3">
								<CardTitle>Instance Health</CardTitle>
								{Result.isInitial(instanceHealthResult) ? (
									<Skeleton className="h-5 w-24" />
								) : instanceHealth?.workspaceName ? (
									<span className="text-muted-foreground text-sm font-mono">
										{instanceHealth.workspaceName}
									</span>
								) : null}
							</div>
						</CardHeader>
						<CardContent className="space-y-4">
							{Result.isInitial(instanceHealthResult) ? (
								<div className="space-y-3">
									<Skeleton className="h-4 w-full" />
									<Skeleton className="h-4 w-3/4" />
									<Skeleton className="h-4 w-1/2" />
								</div>
							) : !instanceHealth ? (
								<p className="text-sm text-muted-foreground">
									Failed to load instance health.
								</p>
							) : (
								<>
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<div className="rounded-lg border px-3 py-2">
											<p className="text-muted-foreground text-xs">Storage</p>
											<p className="text-lg font-semibold">
												{formatBytes(instanceHealth.totalBytes)}
											</p>
										</div>
										<div className="rounded-lg border px-3 py-2">
											<p className="text-muted-foreground text-xs">Total rows</p>
											<p className="text-lg font-semibold">
												{formatNumber(instanceHealth.totalRows)}
											</p>
										</div>
									</div>

									{instanceHealth.datasources.length > 0 ? (
										<div className="rounded-lg border">
											<table className="w-full text-sm">
												<thead>
													<tr className="border-b text-muted-foreground">
														<th className="px-3 py-2 text-left font-medium">
															Datasource
														</th>
														<th className="px-3 py-2 text-right font-medium">
															Rows
														</th>
														<th className="px-3 py-2 text-right font-medium">
															Size
														</th>
													</tr>
												</thead>
												<tbody>
													{instanceHealth.datasources.map((ds) => (
														<tr
															key={ds.name}
															className="border-b last:border-b-0"
														>
															<td className="px-3 py-2 font-mono text-xs">
																{ds.name}
															</td>
															<td className="px-3 py-2 text-right">
																{formatNumber(ds.rowCount)}
															</td>
															<td className="px-3 py-2 text-right">
																{formatBytes(ds.bytes)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									) : null}

									<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
										<div className="rounded-lg border px-3 py-2">
											<p className="text-muted-foreground text-xs">Errors (24h)</p>
											<p className="text-lg font-semibold">
												{instanceHealth.recentErrorCount}
											</p>
										</div>
										<div className="rounded-lg border px-3 py-2">
											<p className="text-muted-foreground text-xs">Avg latency (24h)</p>
											<p className="text-lg font-semibold">
												{instanceHealth.avgQueryLatencyMs != null
													? formatLatency(instanceHealth.avgQueryLatencyMs)
													: "-"}
											</p>
										</div>
									</div>
								</>
							)}
						</CardContent>
					</Card>
				) : null}
			</div>

			<AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Disable BYO Tinybird?</AlertDialogTitle>
						<AlertDialogDescription>
							This organization will stop using its own Tinybird project immediately and fall
							back to Maple-managed Tinybird for reads.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisabling}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => void handleDisable()}
							disabled={isDisabling}
						>
							{isDisabling ? "Disabling..." : "Disable BYO"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
