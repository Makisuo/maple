import { useState } from "react"
import { Cause, Exit } from "effect"
import {
	CreateRailwayTargetRequest,
	RailwayConnectRequest,
	UpdateRailwayTargetRequest,
	type RailwayDiscoveredEnvironment,
	type RailwayDiscoveredProject,
	type RailwayTargetResponse,
} from "@maple/domain/http"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Switch } from "@maple/ui/components/ui/switch"
import { toast } from "sonner"

import { CircleWarningIcon, LoaderIcon, RailwayIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatRelativeTime } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { IntegrationIconPlate } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"

const RAILWAY_ACCENT = "#8B8B8B"
const REACTIVITY = ["railwayIntegrationStatus", "railwayTargets"]

/** First failure message out of a mutation exit, for inline error surfacing. */
const failureMessage = (exit: Exit.Exit<unknown, unknown>, fallback: string): string => {
	if (Exit.isSuccess(exit)) return fallback
	const first = Cause.prettyErrors(exit.cause)[0]
	return first?.message && first.message.length > 0 ? first.message : fallback
}

export function RailwayIntegrationCard() {
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("railway", "status", {
			reactivityKeys: ["railwayIntegrationStatus"],
		}),
	)

	const status = Result.builder(statusResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	if (status === null) {
		return (
			<div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card p-4 text-sm text-muted-foreground">
				<LoaderIcon size={16} className="animate-spin" />
				Loading Railway integration…
			</div>
		)
	}

	if (!status.connected) return <RailwayConnectForm />

	return <RailwayConnectedView accountName={status.accountName} tokenType={status.tokenType} lastValidationError={status.lastValidationError} />
}

function RailwayConnectForm({ reconnect = false }: { reconnect?: boolean }) {
	const [token, setToken] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const connect = useAtomSet(MapleApiAtomClient.mutation("railway", "connect"), {
		mode: "promiseExit",
	})

	async function handleConnect() {
		if (token.trim().length === 0) return
		setBusy(true)
		setError(null)
		const result = await connect({
			payload: new RailwayConnectRequest({ token: token.trim() }),
			reactivityKeys: REACTIVITY,
		})
		setBusy(false)
		if (Exit.isSuccess(result)) {
			setToken("")
			toast.success(reconnect ? "Railway token updated" : "Railway connected")
		} else {
			setError(failureMessage(result, "Failed to connect Railway"))
		}
	}

	const form = (
		<div className="flex w-full max-w-md flex-col gap-2">
			<div className="flex gap-2">
				<Input
					type="password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder="Railway API token"
					autoComplete="off"
					onKeyDown={(event) => {
						if (event.key === "Enter") void handleConnect()
					}}
				/>
				<Button onClick={handleConnect} disabled={busy || token.trim().length === 0}>
					{busy ? <LoaderIcon size={16} className="animate-spin" /> : <RailwayIcon size={16} />}
					{reconnect ? "Update token" : "Connect"}
				</Button>
			</div>
			{error ? <p className="text-xs text-destructive">{error}</p> : null}
		</div>
	)

	if (reconnect) return form

	return (
		<IntegrationEmptyState
			icon={RailwayIcon}
			accent={RAILWAY_ACCENT}
			iconClassName="text-foreground"
			title="Connect Railway"
			description="Paste a workspace or account API token from Railway → Account Settings → Tokens. Maple discovers your projects, streams service logs, and collects CPU, memory, network, and disk metrics."
			footer="The token is stored encrypted and only used to read logs, metrics, and project metadata."
		>
			{form}
		</IntegrationEmptyState>
	)
}

function RailwayConnectedView({
	accountName,
	tokenType,
	lastValidationError,
}: {
	accountName: string | null
	tokenType: "account" | "workspace" | null
	lastValidationError: string | null
}) {
	const [busy, setBusy] = useState(false)
	const [showReconnect, setShowReconnect] = useState(false)
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("railway", "disconnect"), {
		mode: "promiseExit",
	})

	async function handleDisconnect() {
		setBusy(true)
		const result = await disconnect({ reactivityKeys: REACTIVITY })
		setBusy(false)
		if (Exit.isSuccess(result)) toast.success("Railway disconnected")
		else toast.error("Failed to disconnect Railway")
	}

	return (
		<div className="space-y-4">
			{lastValidationError ? (
				<Alert variant="error">
					<CircleWarningIcon />
					<AlertDescription>
						{lastValidationError} — paste a fresh token below to resume ingestion.
					</AlertDescription>
				</Alert>
			) : null}

			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate
					icon={RailwayIcon}
					accent={RAILWAY_ACCENT}
					iconClassName="text-foreground"
				/>
				<div className="flex flex-1 flex-col gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">Railway</h3>
							<Badge variant={lastValidationError ? "warning" : "success"}>
								{lastValidationError ? "Reconnect needed" : "Connected"}
							</Badge>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							{accountName ? (
								<>
									Connected as <span className="text-foreground">{accountName}</span>
									{tokenType ? ` (${tokenType} token)` : null}.
								</>
							) : (
								<>Connected{tokenType ? ` with a ${tokenType} token` : null}.</>
							)}{" "}
							Pick the environments to ingest below.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="outline" onClick={() => setShowReconnect((value) => !value)}>
							{showReconnect ? "Cancel" : "Replace token"}
						</Button>
						<Button size="sm" variant="outline" onClick={handleDisconnect} disabled={busy}>
							{busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Disconnect
						</Button>
					</div>
					{showReconnect ? <RailwayConnectForm reconnect /> : null}
				</div>
			</div>

			<RailwayEnvironmentBoard />
		</div>
	)
}

function RailwayEnvironmentBoard() {
	const discoveryResult = useAtomValue(
		MapleApiAtomClient.query("railway", "discovery", {
			reactivityKeys: ["railwayTargets", "railwayIntegrationStatus"],
		}),
	)
	const targetsResult = useAtomValue(
		MapleApiAtomClient.query("railway", "listTargets", {
			reactivityKeys: ["railwayTargets"],
		}),
	)
	const refreshTargets = useAtomRefresh(
		MapleApiAtomClient.query("railway", "listTargets", { reactivityKeys: ["railwayTargets"] }),
	)

	const targets = Result.builder(targetsResult)
		.onSuccess((response) => response.targets)
		.orElse(() => [] as ReadonlyArray<RailwayTargetResponse>)
	const targetById = new Map(targets.map((target) => [target.id, target]))

	return Result.builder(discoveryResult)
		.onSuccess((discovery) => {
			if (discovery.projects.length === 0) {
				return (
					<div className="rounded-lg border border-border/60 bg-card p-4 text-sm text-muted-foreground">
						No Railway projects are visible with this token.
					</div>
				)
			}
			return (
				<div className="space-y-3">
					{discovery.projects.map((project) => (
						<RailwayProjectSection
							key={project.id}
							project={project}
							targetById={targetById}
							onChanged={refreshTargets}
						/>
					))}
				</div>
			)
		})
		.onInitial(() => (
			<div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card p-4 text-sm text-muted-foreground">
				<LoaderIcon size={16} className="animate-spin" />
				Discovering Railway projects…
			</div>
		))
		.orElse(() => (
			<Alert variant="error">
				<CircleWarningIcon />
				<AlertDescription>
					Failed to load Railway projects — the token may have been revoked. Try replacing it above.
				</AlertDescription>
			</Alert>
		))
}

function RailwayProjectSection({
	project,
	targetById,
	onChanged,
}: {
	project: RailwayDiscoveredProject
	targetById: Map<string, RailwayTargetResponse>
	onChanged: () => void
}) {
	return (
		<div className="rounded-lg border border-border/60 bg-card">
			<div className="border-b border-border/60 px-4 py-2.5">
				<span className="text-sm font-semibold">{project.name}</span>
				<span className="ml-2 text-xs text-muted-foreground">
					{project.environments.length} environment{project.environments.length === 1 ? "" : "s"}
				</span>
			</div>
			<div className="divide-y divide-border/60">
				{project.environments.map((environment) => (
					<RailwayEnvironmentRow
						key={environment.id}
						projectId={project.id}
						environment={environment}
						target={environment.targetId ? targetById.get(environment.targetId) : undefined}
						onChanged={onChanged}
					/>
				))}
			</div>
		</div>
	)
}

function RailwayEnvironmentRow({
	projectId,
	environment,
	target,
	onChanged,
}: {
	projectId: string
	environment: RailwayDiscoveredEnvironment
	target: RailwayTargetResponse | undefined
	onChanged: () => void
}) {
	const [busy, setBusy] = useState(false)
	const createTarget = useAtomSet(MapleApiAtomClient.mutation("railway", "createTarget"), {
		mode: "promiseExit",
	})
	const updateTarget = useAtomSet(MapleApiAtomClient.mutation("railway", "updateTarget"), {
		mode: "promiseExit",
	})
	const deleteTarget = useAtomSet(MapleApiAtomClient.mutation("railway", "deleteTarget"), {
		mode: "promiseExit",
	})

	const ingesting = target !== undefined && target.enabled

	async function handleToggleIngest(next: boolean) {
		setBusy(true)
		if (target === undefined) {
			const result = await createTarget({
				payload: new CreateRailwayTargetRequest({
					projectId,
					environmentId: environment.id,
				}),
				reactivityKeys: REACTIVITY,
			})
			if (Exit.isSuccess(result)) toast.success(`Ingesting ${environment.name}`)
			else toast.error(failureMessage(result, "Failed to enable ingestion"))
		} else {
			const result = await updateTarget({
				params: { targetId: target.id },
				payload: new UpdateRailwayTargetRequest({ enabled: next }),
				reactivityKeys: REACTIVITY,
			})
			if (!Exit.isSuccess(result)) toast.error(failureMessage(result, "Failed to update target"))
		}
		setBusy(false)
		onChanged()
	}

	async function handleToggleSignal(field: "logsEnabled" | "metricsEnabled", next: boolean) {
		if (target === undefined) return
		setBusy(true)
		const result = await updateTarget({
			params: { targetId: target.id },
			payload: new UpdateRailwayTargetRequest(
				field === "logsEnabled" ? { logsEnabled: next } : { metricsEnabled: next },
			),
			reactivityKeys: REACTIVITY,
		})
		if (!Exit.isSuccess(result)) toast.error(failureMessage(result, "Failed to update target"))
		setBusy(false)
		onChanged()
	}

	async function handleRemove() {
		if (target === undefined) return
		setBusy(true)
		const result = await deleteTarget({
			params: { targetId: target.id },
			reactivityKeys: REACTIVITY,
		})
		if (Exit.isSuccess(result)) toast.success(`Stopped ingesting ${environment.name}`)
		else toast.error(failureMessage(result, "Failed to remove target"))
		setBusy(false)
		onChanged()
	}

	return (
		<div className="flex flex-col gap-2 px-4 py-3">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm">{environment.name}</span>
						<span className="text-xs text-muted-foreground">
							{environment.services.length} service{environment.services.length === 1 ? "" : "s"}
						</span>
						{target?.lastError ? (
							<Badge variant="warning" title={target.lastError}>
								Error
							</Badge>
						) : null}
					</div>
					{target ? (
						<div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
							<span>
								Logs:{" "}
								{target.lastLogAt ? formatRelativeTime(target.lastLogAt) : "no data yet"}
							</span>
							<span>
								Metrics:{" "}
								{target.lastMetricsAt ? formatRelativeTime(target.lastMetricsAt) : "no data yet"}
							</span>
						</div>
					) : null}
					{target?.lastError ? (
						<p className="mt-0.5 truncate text-[11px] text-warning" title={target.lastError}>
							{target.lastError}
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-4">
					{ingesting ? (
						<>
							<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
								Logs
								<Switch
									checked={target!.logsEnabled}
									onCheckedChange={(next) => handleToggleSignal("logsEnabled", next)}
									disabled={busy}
								/>
							</label>
							<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
								Metrics
								<Switch
									checked={target!.metricsEnabled}
									onCheckedChange={(next) => handleToggleSignal("metricsEnabled", next)}
									disabled={busy}
								/>
							</label>
							<Button size="sm" variant="ghost" onClick={handleRemove} disabled={busy}>
								Remove
							</Button>
						</>
					) : (
						<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
							Ingest
							<Switch
								checked={ingesting}
								onCheckedChange={handleToggleIngest}
								disabled={busy}
							/>
						</label>
					)}
				</div>
			</div>
		</div>
	)
}
