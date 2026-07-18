import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useMemo, useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
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
import { Badge } from "@maple/ui/components/ui/badge"
import { Separator } from "@maple/ui/components/ui/separator"
import { AlertWarningIcon, ArrowPathIcon, CheckIcon, CopyIcon, EyeIcon, ShieldIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { maskKey } from "@/components/ingest/copyable-field"
import { GuidedSetup } from "@/components/ingest/guided-setup"
import { IngestStatusPanel } from "@/components/ingest/connection-status"
import { useIngestConnection } from "@/components/ingest/use-ingest-connection"
import { AttributeMappingsSection } from "./attribute-mappings-section"
import { RecommendedMappingsSection } from "./recommended-mappings-section"

interface ApiKeyRowProps {
	type: "public" | "private"
	label: string
	description: string
	keyValue: string
	isVisible: boolean
	onToggleVisibility: () => void
	isCopied: boolean
	onCopy: () => void
	onRegenerate: () => void
	disabled: boolean
}

function ApiKeyRow({
	type,
	label,
	description,
	keyValue,
	isVisible,
	onToggleVisibility,
	isCopied,
	onCopy,
	onRegenerate,
	disabled,
}: ApiKeyRowProps) {
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<Badge variant={type === "private" ? "outline" : "secondary"}>
					{type === "private" && <ShieldIcon size={12} />}
					{label}
				</Badge>
				<span className="text-muted-foreground text-xs">{description}</span>
			</div>

			<InputGroup>
				<InputGroupInput
					readOnly
					value={isVisible ? keyValue : maskKey(keyValue)}
					className="font-mono text-xs tracking-wide select-all"
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						onClick={onToggleVisibility}
						aria-label={isVisible ? "Hide key" : "Reveal key"}
						title={isVisible ? "Hide" : "Reveal"}
						disabled={disabled}
					>
						<EyeIcon size={14} className={isVisible ? "text-foreground" : undefined} />
					</InputGroupButton>

					<InputGroupButton
						onClick={onCopy}
						aria-label="Copy key to clipboard"
						title={isCopied ? "Copied!" : "Copy"}
						disabled={disabled}
					>
						{isCopied ? (
							<CheckIcon size={14} className="text-severity-info" />
						) : (
							<CopyIcon size={14} />
						)}
					</InputGroupButton>

					<InputGroupButton
						onClick={onRegenerate}
						aria-label="Regenerate key"
						title="Regenerate"
						className="text-destructive hover:text-destructive"
						disabled={disabled}
					>
						<ArrowPathIcon size={14} />
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
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
			<div className="space-y-4">
				<Card>
					<CardHeader>
						<CardTitle>Send your first telemetry</CardTitle>
						<CardDescription>
							Point your OpenTelemetry SDK at Maple, or let Claude Code wire it up for you.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<GuidedSetup apiKey={connection.apiKey} />
						<IngestStatusPanel connection={connection} onTestSent={connection.refresh} />
					</CardContent>
				</Card>

				<div className="grid grid-cols-2 gap-4">
					<Card>
						<CardHeader>
							<CardTitle>Ingest Endpoint</CardTitle>
							<CardDescription>
								Send telemetry data to this endpoint using OTLP.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-3">
							<InputGroup>
								<InputGroupInput
									readOnly
									value={ingestUrl}
									className="font-mono text-xs tracking-wide select-all"
								/>
								<InputGroupAddon align="inline-end">
									<InputGroupButton
										onClick={() => endpointCopy.copy(ingestUrl)}
										aria-label="Copy endpoint to clipboard"
										title={endpointCopy.copied ? "Copied!" : "Copy"}
									>
										{endpointCopy.copied ? (
											<CheckIcon size={14} className="text-severity-info" />
										) : (
											<CopyIcon size={14} />
										)}
									</InputGroupButton>
								</InputGroupAddon>
							</InputGroup>
							<p className="text-muted-foreground text-xs">
								Learn how to send telemetry data in the{" "}
								<a
									href="https://maple.dev/docs"
									target="_blank"
									rel="noopener noreferrer"
									className="text-foreground underline underline-offset-2 hover:no-underline"
								>
									documentation
								</a>
								.
							</p>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Ingest Keys</CardTitle>
							<CardDescription>
								Use these keys to authenticate ingestion requests.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<ApiKeyRow
								type="public"
								label="Public"
								description="For browser and client-side telemetry SDKs"
								keyValue={publicKey}
								isVisible={publicKeyVisible}
								onToggleVisibility={() => setPublicKeyVisible((v) => !v)}
								isCopied={publicKeyCopy.copied}
								onCopy={() => handleCopy("public")}
								onRegenerate={() => openRegenerateDialog("public")}
								disabled={isBusy}
							/>
							<Separator />
							<ApiKeyRow
								type="private"
								label="Private"
								description="For server-side ingestion and backend services"
								keyValue={privateKey}
								isVisible={privateKeyVisible}
								onToggleVisibility={() => setPrivateKeyVisible((v) => !v)}
								isCopied={privateKeyCopy.copied}
								onCopy={() => handleCopy("private")}
								onRegenerate={() => openRegenerateDialog("private")}
								disabled={isBusy}
							/>
						</CardContent>
					</Card>
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
