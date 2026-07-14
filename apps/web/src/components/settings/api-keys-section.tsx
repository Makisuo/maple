import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useState, type ReactNode } from "react"
import { Exit } from "effect"
import type { ApiKeyId, ApiKeyResponse } from "@maple/domain/http"
import { toast } from "sonner"
import { cn } from "@maple/ui/lib/utils"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Badge } from "@maple/ui/components/ui/badge"
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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	AlertWarningIcon,
	ArrowPathIcon,
	CopyIcon,
	DotsVerticalIcon,
	KeyIcon,
	PlusIcon,
	SquareTerminalIcon,
	TrashIcon,
} from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { CreateApiKeyDialog } from "./create-api-key-dialog"
import { RollApiKeyDialog } from "./roll-api-key-dialog"

type ApiKey = ApiKeyResponse

function formatDate(timestamp: number | null): string {
	if (!timestamp) return "Never"
	try {
		return new Date(timestamp).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		})
	} catch {
		return "Unknown"
	}
}

function formatRelative(timestamp: number | null): string | null {
	if (!timestamp) return null
	const diff = Date.now() - timestamp
	const sec = Math.max(0, Math.floor(diff / 1000))
	if (sec < 60) return "just now"
	const min = Math.floor(sec / 60)
	if (min < 60) return `${min}m ago`
	const hr = Math.floor(min / 60)
	if (hr < 24) return `${hr}h ago`
	const days = Math.floor(hr / 24)
	if (days < 30) return `${days}d ago`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo ago`
	const years = Math.floor(months / 12)
	return `${years}y ago`
}

export function ApiKeysSection() {
	const [createOpen, setCreateOpen] = useState(false)
	const [revokeOpen, setRevokeOpen] = useState(false)
	const [revokingKeyId, setRevokingKeyId] = useState<ApiKeyId | null>(null)
	const [isRevoking, setIsRevoking] = useState(false)
	const [rollOpen, setRollOpen] = useState(false)
	const [rollingKey, setRollingKey] = useState<ApiKeyResponse | null>(null)

	const listQueryAtom = MapleApiAtomClient.query("apiKeys", "list", {})
	const listResult = useAtomValue(listQueryAtom)
	const refreshKeys = useAtomRefresh(listQueryAtom)

	const revokeMutation = useAtomSet(MapleApiAtomClient.mutation("apiKeys", "revoke"), {
		mode: "promiseExit",
	})

	const keys = Result.builder(listResult)
		.onSuccess((response) => response.keys)
		.orElse(() => [])

	function openRevokeDialog(keyId: ApiKeyId) {
		setRevokingKeyId(keyId)
		setRevokeOpen(true)
	}

	function openRollDialog(key: ApiKey) {
		setRollingKey(key)
		setRollOpen(true)
	}

	async function handleRevoke() {
		if (!revokingKeyId) return
		setIsRevoking(true)
		const result = await revokeMutation({ params: { keyId: revokingKeyId } })
		if (Exit.isSuccess(result)) {
			toast.success("API key revoked")
			refreshKeys()
		} else {
			toast.error("Failed to revoke API key")
		}
		setIsRevoking(false)
		setRevokeOpen(false)
		setRevokingKeyId(null)
	}

	const activeKeys = keys.filter((k) => !k.revoked)
	const revokedKeys = keys.filter((k) => k.revoked)
	const mcpCount = activeKeys.filter((k) => k.kind === "mcp").length
	const standardCount = activeKeys.length - mcpCount

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<CardTitle>API Keys</CardTitle>
							<CardDescription>
								Manage keys for programmatic access to the Maple API.{" "}
								<a
									href="https://maple.dev/docs"
									target="_blank"
									rel="noopener noreferrer"
									className="text-foreground underline underline-offset-2 hover:no-underline"
								>
									View API docs
								</a>
							</CardDescription>
							{activeKeys.length > 0 && (
								<div className="text-muted-foreground/80 flex items-center gap-2 pt-1 font-mono text-[11px] uppercase tracking-wider">
									<span className="text-success-foreground">{standardCount} standard</span>
									<MetaDot />
									<span className="text-info-foreground">{mcpCount} mcp</span>
									{revokedKeys.length > 0 && (
										<>
											<MetaDot />
											<span className="text-muted-foreground/60">
												{revokedKeys.length} revoked
											</span>
										</>
									)}
								</div>
							)}
						</div>
						<Button onClick={() => setCreateOpen(true)} size="sm">
							<PlusIcon data-icon="inline-start" size={14} />
							Create key
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					{Result.isInitial(listResult) ? (
						<div className="space-y-2">
							<Skeleton className="h-[68px] w-full" />
							<Skeleton className="h-[68px] w-full" />
						</div>
					) : !Result.isSuccess(listResult) ? (
						<p className="text-sm text-muted-foreground">Failed to load API keys</p>
					) : keys.length === 0 ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<KeyIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No API keys</EmptyTitle>
								<EmptyDescription>
									Create an API key to authenticate with the Maple API and MCP server.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="space-y-4">
							{activeKeys.length > 0 && (
								<div className="divide-y">
									{activeKeys.map((key) => (
										<ApiKeyListItem
											key={key.id}
											apiKey={key}
											onRoll={() => openRollDialog(key)}
											onRevoke={() => openRevokeDialog(key.id)}
										/>
									))}
								</div>
							)}
							{revokedKeys.length > 0 && (
								<div className="pt-2">
									<div className="flex items-center gap-2 pb-1">
										<span className="bg-border h-px flex-1" />
										<span className="text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.15em]">
											Revoked · {revokedKeys.length}
										</span>
										<span className="bg-border h-px flex-1" />
									</div>
									<div className="divide-y">
										{revokedKeys.map((key) => (
											<ApiKeyListItem key={key.id} apiKey={key} />
										))}
									</div>
								</div>
							)}
						</div>
					)}
				</CardContent>
			</Card>

			<CreateApiKeyDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={() => refreshKeys()}
			/>

			<RollApiKeyDialog
				open={rollOpen}
				onOpenChange={setRollOpen}
				apiKey={rollingKey}
				onRolled={() => refreshKeys()}
			/>

			<AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Revoke API key?</AlertDialogTitle>
						<AlertDialogDescription>
							This action cannot be undone. Any integrations using this key will stop working
							immediately.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleRevoke} disabled={isRevoking}>
							{isRevoking ? "Revoking..." : "Revoke key"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function ApiKeyListItem({
	apiKey,
	onRoll,
	onRevoke,
}: {
	apiKey: ApiKey
	onRoll?: () => void
	onRevoke?: () => void
}) {
	const isMcp = apiKey.kind === "mcp"
	const Icon = isMcp ? SquareTerminalIcon : KeyIcon
	const relativeLastUsed = formatRelative(apiKey.lastUsedAt)
	const expiresInPast = apiKey.expiresAt !== null && apiKey.expiresAt < Date.now()

	// Type-coded icon tile: emerald for standard keys (live credential), blue for MCP
	// (agent/machine type). Revoked keys desaturate to neutral so dead keys read as dead.
	const tileClass = apiKey.revoked
		? "bg-muted/40 text-muted-foreground border-border"
		: isMcp
			? "bg-info/10 text-info border-info/30"
			: "bg-success/10 text-success border-success/30"

	const prefixCopy = useCopyToClipboard("Key prefix")

	return (
		<div
			className={cn(
				"flex items-start gap-3 px-2 py-3 transition-colors",
				apiKey.revoked ? "opacity-60" : "hover:bg-muted/20",
			)}
		>
			<div className={cn("flex h-9 w-9 shrink-0 items-center justify-center border", tileClass)}>
				<Icon size={14} />
			</div>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-foreground text-sm font-medium leading-none">{apiKey.name}</span>
					{isMcp && (
						<Badge variant="info" size="sm">
							MCP
						</Badge>
					)}
					{apiKey.revoked && (
						<Badge variant="error" size="sm">
							Revoked
						</Badge>
					)}
					{expiresInPast && !apiKey.revoked && (
						<Badge variant="outline" size="sm">
							Expired
						</Badge>
					)}
				</div>

				{apiKey.description && (
					<p className="text-foreground/70 text-xs leading-snug">{apiKey.description}</p>
				)}

				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5">
					<code className="text-foreground/55 font-mono text-[11px] tracking-tight">
						{apiKey.keyPrefix}
					</code>
					<MetaDot />
					<MetaSpan label="Created">{formatDate(apiKey.createdAt)}</MetaSpan>
					{apiKey.createdByEmail && (
						<>
							<MetaDot />
							<MetaSpan label="by" className="max-w-[14rem] truncate">
								{apiKey.createdByEmail}
							</MetaSpan>
						</>
					)}
					{apiKey.lastUsedAt && (
						<>
							<MetaDot />
							<MetaSpan label="Last used" title={formatDate(apiKey.lastUsedAt)}>
								{relativeLastUsed ?? formatDate(apiKey.lastUsedAt)}
							</MetaSpan>
						</>
					)}
					{apiKey.expiresAt && (
						<>
							<MetaDot />
							<MetaSpan label={expiresInPast ? "Expired" : "Expires"}>
								{formatDate(apiKey.expiresAt)}
							</MetaSpan>
						</>
					)}
				</div>
			</div>

			{!apiKey.revoked && onRevoke && (
				<div className="flex shrink-0 items-center">
					<DropdownMenu>
						<DropdownMenuTrigger
							render={<Button variant="ghost" size="icon" className="size-7" />}
							aria-label={`Actions for ${apiKey.name}`}
						>
							<DotsVerticalIcon size={14} />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => prefixCopy.copy(apiKey.keyPrefix)}>
								<CopyIcon size={14} />
								Copy key prefix
							</DropdownMenuItem>
							{onRoll && (
								<DropdownMenuItem onClick={onRoll}>
									<ArrowPathIcon size={14} />
									Roll key
								</DropdownMenuItem>
							)}
							<DropdownMenuItem variant="destructive" onClick={onRevoke}>
								<TrashIcon size={14} />
								Revoke key
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}
		</div>
	)
}

function MetaDot() {
	return (
		<span aria-hidden="true" className="text-muted-foreground/40 text-[10px]">
			·
		</span>
	)
}

function MetaSpan({
	label,
	children,
	className,
	title,
}: {
	label: string
	children: ReactNode
	className?: string
	title?: string
}) {
	return (
		<span
			className={cn("text-muted-foreground inline-flex items-baseline gap-1 text-[11px]", className)}
			title={title}
		>
			<span className="text-muted-foreground/60">{label}</span>
			<span className="text-foreground/75">{children}</span>
		</span>
	)
}
