import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import { toast } from "sonner"

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
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import {
	AlertWarningIcon,
	ArrowPathIcon,
	ArrowRightIcon,
	CheckIcon,
	CopyIcon,
	EyeIcon,
	PaperPlaneIcon,
	PulseIcon,
} from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { formatNumber } from "@/lib/format"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { maskKey } from "@/components/ingest/copyable-field"
import { ConnectInstructions, FrameworkPicker, useGuidedFramework } from "@/components/ingest/guided-setup"
import {
	sendTestEvent,
	useIngestConnection,
	type IngestConnection,
} from "@/components/ingest/use-ingest-connection"
import { AttributeMappingsSection } from "./attribute-mappings-section"
import { RecommendedMappingsSection } from "./recommended-mappings-section"

const LANE_BADGE = "w-14 shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.12em]"

/** Live ingest-health strip: green once telemetry lands, amber pulse while waiting. */
function StatusBanner({ connection }: { connection: IngestConnection }) {
	const [sending, setSending] = useState(false)
	const connected = connection.status === "connected"

	async function handleSendTest() {
		if (!connection.apiKey || sending) return
		setSending(true)
		try {
			await sendTestEvent(connection.apiKey)
			toast.success("Test event sent — watch for it to land in traces")
			connection.refresh()
		} catch {
			toast.error("Couldn't reach the ingest endpoint — double-check your API key")
		} finally {
			setSending(false)
		}
	}

	const spansPerMinute = Math.round(connection.spansPerMinute)

	return (
		<div className="bg-card flex items-center gap-3 rounded-lg border px-4 py-2.5">
			{connected ? (
				<span className="bg-severity-info size-2 shrink-0 rounded-full" />
			) : (
				<PulseIcon size={12} className="text-primary shrink-0 animate-pulse motion-reduce:animate-none" />
			)}
			<span className="text-sm font-medium whitespace-nowrap">
				{connected ? "Receiving telemetry" : "Waiting for telemetry"}
			</span>
			<span className="text-muted-foreground truncate font-mono text-xs">
				{connected
					? [
							`${connection.serviceCount} ${connection.serviceCount === 1 ? "service" : "services"}`,
							spansPerMinute > 0 ? `${formatNumber(spansPerMinute)} spans/min` : null,
						]
							.filter(Boolean)
							.join(" · ")
					: "watching for your first trace"}
			</span>
			<div className="grow" />
			{connected ? (
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground hover:text-foreground gap-1.5"
					render={<Link to="/traces" />}
				>
					Explore traces
					<ArrowRightIcon size={13} />
				</Button>
			) : (
				<Button
					variant="outline"
					size="sm"
					className="shrink-0 gap-2"
					onClick={handleSendTest}
					disabled={sending || !connection.apiKey}
				>
					<PaperPlaneIcon size={13} />
					{sending ? "Sending…" : "Send test event"}
				</Button>
			)}
		</div>
	)
}

interface CredentialRowProps {
	label: string
	badge: string
	badgeClass: string
	value: string
	masked?: boolean
	description?: string
	isVisible?: boolean
	onToggleVisibility?: () => void
	isCopied: boolean
	onCopy: () => void
	onRegenerate?: () => void
	disabled?: boolean
}

function CredentialRow({
	label,
	badge,
	badgeClass,
	value,
	masked = false,
	description,
	isVisible = false,
	onToggleVisibility,
	isCopied,
	onCopy,
	onRegenerate,
	disabled = false,
}: CredentialRowProps) {
	return (
		<div className="flex items-center gap-3 border-t px-4 py-3">
			<span className="w-[120px] shrink-0 text-sm">{label}</span>
			<span className={cn(LANE_BADGE, badgeClass)}>{badge}</span>
			<div className="flex min-w-0 grow flex-col items-start gap-0.5">
				<button
					type="button"
					onClick={onCopy}
					disabled={disabled}
					title={isCopied ? "Copied!" : "Click to copy"}
					className="group/value text-muted-foreground hover:text-foreground flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 font-mono text-xs tracking-wide transition-colors"
				>
					<span className="truncate">{masked && !isVisible ? maskKey(value) : value}</span>
					{isCopied ? (
						<CheckIcon size={12} className="text-severity-info shrink-0" />
					) : (
						<CopyIcon
							size={12}
							className="shrink-0 opacity-0 transition-opacity group-hover/value:opacity-60"
						/>
					)}
				</button>
				{description && (
					<span className="text-muted-foreground/75 text-[11px] leading-3.5">{description}</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{onToggleVisibility && (
					<Button
						variant="outline"
						size="icon-sm"
						onClick={onToggleVisibility}
						aria-label={isVisible ? "Hide key" : "Reveal key"}
						title={isVisible ? "Hide" : "Reveal"}
						disabled={disabled}
					>
						<EyeIcon size={13} className={isVisible ? "text-foreground" : "text-muted-foreground"} />
					</Button>
				)}
				<Button
					variant="outline"
					size="icon-sm"
					onClick={onCopy}
					aria-label={`Copy ${label.toLowerCase()} to clipboard`}
					title={isCopied ? "Copied!" : "Copy"}
					disabled={disabled}
				>
					{isCopied ? (
						<CheckIcon size={13} className="text-severity-info" />
					) : (
						<CopyIcon size={13} className="text-muted-foreground" />
					)}
				</Button>
				{onRegenerate && (
					<Button
						variant="outline"
						size="icon-sm"
						onClick={onRegenerate}
						aria-label={`Regenerate ${label.toLowerCase()}`}
						title="Regenerate"
						disabled={disabled}
					>
						<ArrowPathIcon size={13} className="text-destructive" />
					</Button>
				)}
			</div>
		</div>
	)
}

export function IngestionSection() {
	const [publicKeyVisible, setPublicKeyVisible] = useState(false)
	const [privateKeyVisible, setPrivateKeyVisible] = useState(false)
	const publicKeyCopy = useCopyToClipboard("Ingest key")
	const privateKeyCopy = useCopyToClipboard("Ingest key")
	const endpointCopy = useCopyToClipboard("Ingest endpoint")
	const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false)
	const [regenerateKeyType, setRegenerateKeyType] = useState<"public" | "private" | null>(null)
	const [submittingKeyType, setSubmittingKeyType] = useState<"public" | "private" | null>(null)

	const keysQueryAtom = MapleApiV2AtomClient.query("ingestKeys", "retrieve", {})
	const keysResult = useAtomValue(keysQueryAtom)
	const refreshKeys = useAtomRefresh(keysQueryAtom)

	const connection = useIngestConnection()
	const { framework, setFramework } = useGuidedFramework()

	const rerollPublicMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollPublic"), {
		mode: "promiseExit",
	})
	const rerollPrivateMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollPrivate"), {
		mode: "promiseExit",
	})

	const isBusy = useMemo(
		() => !Result.isSuccess(keysResult) || submittingKeyType !== null,
		[keysResult, submittingKeyType],
	)

	function handleCopy(keyType: "public" | "private") {
		if (!Result.isSuccess(keysResult)) return

		const key = keyType === "public" ? keysResult.value.public_key : keysResult.value.private_key
		;(keyType === "public" ? publicKeyCopy : privateKeyCopy).copy(key)
	}

	function openRegenerateDialog(keyType: "public" | "private") {
		setRegenerateKeyType(keyType)
		setRegenerateDialogOpen(true)
	}

	async function handleRegenerate() {
		if (!regenerateKeyType) return

		setSubmittingKeyType(regenerateKeyType)

		const result =
			regenerateKeyType === "public" ? await rerollPublicMutation({}) : await rerollPrivateMutation({})

		if (Exit.isSuccess(result)) {
			refreshKeys()

			toast.success(
				`${regenerateKeyType === "public" ? "Public" : "Private"} key regenerated. Previous key was revoked immediately.`,
			)
		} else {
			toast.error("Unable to complete request")
		}

		setSubmittingKeyType(null)
		setRegenerateDialogOpen(false)
		setRegenerateKeyType(null)
	}

	const publicKey = Result.builder(keysResult)
		.onSuccess((v) => v.public_key)
		.orElse(() => "Loading...")
	const privateKey = Result.builder(keysResult)
		.onSuccess((v) => v.private_key)
		.orElse(() => "Loading...")

	return (
		<>
			<div className="space-y-5">
				<StatusBanner connection={connection} />

				<div className="bg-card flex flex-col rounded-lg border">
					<div className="flex items-start gap-3 px-4 pt-4 pb-3">
						<div className="flex flex-col gap-1">
							<h3 className="text-sm font-medium">Endpoint &amp; keys</h3>
							<p className="text-muted-foreground text-xs">
								Point your OTLP exporter at the endpoint and authenticate with an ingest key.
							</p>
						</div>
						<div className="grow" />
						<a
							href="https://maple.dev/docs"
							target="_blank"
							rel="noopener noreferrer"
							className="text-muted-foreground hover:text-foreground font-mono text-[11px] whitespace-nowrap transition-colors"
						>
							Docs ↗
						</a>
					</div>
					<CredentialRow
						label="OTLP endpoint"
						badge="HTTP"
						badgeClass="text-muted-foreground"
						value={ingestUrl}
						isCopied={endpointCopy.copied}
						onCopy={() => endpointCopy.copy(ingestUrl)}
					/>
					<CredentialRow
						label="Public key"
						badge="Client"
						badgeClass="text-info"
						value={publicKey}
						masked
						description="For browser and client-side telemetry SDKs"
						isVisible={publicKeyVisible}
						onToggleVisibility={() => setPublicKeyVisible((v) => !v)}
						isCopied={publicKeyCopy.copied}
						onCopy={() => handleCopy("public")}
						onRegenerate={() => openRegenerateDialog("public")}
						disabled={isBusy}
					/>
					<CredentialRow
						label="Private key"
						badge="Server"
						badgeClass="text-warning"
						value={privateKey}
						masked
						description="For server-side ingestion and backend services"
						isVisible={privateKeyVisible}
						onToggleVisibility={() => setPrivateKeyVisible((v) => !v)}
						isCopied={privateKeyCopy.copied}
						onCopy={() => handleCopy("private")}
						onRegenerate={() => openRegenerateDialog("private")}
						disabled={isBusy}
					/>
				</div>

				<div className="bg-card flex flex-col rounded-lg border">
					<div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 pt-4 pb-3">
						<div className="flex min-w-[260px] flex-col gap-1">
							<h3 className="text-sm font-medium whitespace-nowrap">Send your first telemetry</h3>
							<p className="text-muted-foreground text-xs">
								Point your OpenTelemetry SDK at Maple, or let Claude Code wire it up for you.
							</p>
						</div>
						<div className="ml-auto">
							<FrameworkPicker compact selected={framework} onSelect={setFramework} />
						</div>
					</div>
					<ConnectInstructions framework={framework} apiKey={connection.apiKey} variant="flush" />
				</div>

				<RecommendedMappingsSection />

				<AttributeMappingsSection />
			</div>

			<AlertDialog open={regenerateDialogOpen} onOpenChange={setRegenerateDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>
							Regenerate {regenerateKeyType === "public" ? "public" : "private"} key?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This action cannot be undone. All existing integrations using this key will stop
							working immediately. You will need to update your{" "}
							{regenerateKeyType === "public" ? "client-side SDKs" : "server configurations"}{" "}
							with the new key.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={submittingKeyType !== null}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={handleRegenerate}
							disabled={submittingKeyType !== null}
						>
							Regenerate key
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
