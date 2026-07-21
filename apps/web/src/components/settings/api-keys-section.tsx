import { useAtomSet } from "@/lib/effect-atom"
import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import type { V2ApiKey } from "@maple/domain/http/v2"
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
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	AlertWarningIcon,
	ArrowPathIcon,
	DotsVerticalIcon,
	KeyIcon,
	PlusIcon,
	SquareTerminalIcon,
	TrashIcon,
} from "@/components/icons"
import { useApiKeyMutationSync, useApiKeysList } from "@/hooks/use-api-keys"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { formatBackendError } from "@/lib/error-messages"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { CreateApiKeyDialog } from "./create-api-key-dialog"
import { RollApiKeyDialog } from "./roll-api-key-dialog"

type ApiKey = V2ApiKey

function formatDate(timestamp: string | null): string {
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

function formatRelative(timestamp: string | null): string | null {
	if (!timestamp) return null
	const parsed = Date.parse(timestamp)
	if (!Number.isFinite(parsed)) return null
	const diff = Date.now() - parsed
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
	const isAdmin = useIsOrgAdmin()
	const [createOpen, setCreateOpen] = useState(false)
	const [revokeOpen, setRevokeOpen] = useState(false)
	const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null)
	const [isRevoking, setIsRevoking] = useState(false)
	const [rollOpen, setRollOpen] = useState(false)
	const [rollingKey, setRollingKey] = useState<ApiKey | null>(null)

	const { keys, isLoading, isError } = useApiKeysList()
	const { prepareForMutation, reconcileTxid } = useApiKeyMutationSync()
	const revokeMutation = useAtomSet(MapleApiV2AtomClient.mutation("apiKeys", "revoke"), {
		mode: "promiseExit",
	})

	function openRevokeDialog(key: ApiKey) {
		setRevokingKey(key)
		setRevokeOpen(true)
	}

	function openRollDialog(key: ApiKey) {
		setRollingKey(key)
		setRollOpen(true)
	}

	async function handleRevoke() {
		if (!revokingKey) return
		setIsRevoking(true)
		prepareForMutation()
		const result = await revokeMutation({ params: { id: revokingKey.id } })
		if (Exit.isSuccess(result)) {
			toast.success("API key revoked")
			void reconcileTxid(result.value.txid)
		} else {
			const { title, description } = formatBackendError(result)
			toast.error(title, { description })
		}
		setIsRevoking(false)
		setRevokeOpen(false)
		// Keep `revokingKey` set so the dialog copy doesn't swap to the generic
		// fallback while the close animation plays; the next open overwrites it.
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
						<Button onClick={() => setCreateOpen(true)} size="sm" disabled={!isAdmin}>
							<PlusIcon data-icon="inline-start" size={14} />
							Create key
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-[68px] w-full" />
							<Skeleton className="h-[68px] w-full" />
						</div>
					) : isError ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<AlertWarningIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>Couldn't load API keys</EmptyTitle>
								<EmptyDescription>
									Something went wrong while loading your keys. Reload the page to try
									again.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
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
							<EmptyContent>
								<Button size="sm" onClick={() => setCreateOpen(true)} disabled={!isAdmin}>
									<PlusIcon data-icon="inline-start" size={14} />
									Create key
								</Button>
							</EmptyContent>
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
											onRevoke={() => openRevokeDialog(key)}
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

			{!isAdmin ? (
				<p className="text-muted-foreground text-xs">
					Only org admins can create API keys. For a key that connects your editor to Maple, use the{" "}
					<Link
						to="/mcp"
						className="text-foreground underline underline-offset-2 hover:no-underline"
					>
						MCP
					</Link>{" "}
					page — you can create one of those yourself.
				</p>
			) : null}

			<CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />

			<RollApiKeyDialog open={rollOpen} onOpenChange={setRollOpen} apiKey={rollingKey} />

			<AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Revoke API key?</AlertDialogTitle>
						<AlertDialogDescription>
							{revokingKey ? (
								<>
									<span className="text-foreground font-medium">{revokingKey.name}</span> (
									<span className="font-mono text-xs">{revokingKey.key_prefix}</span>) will
									stop working immediately. This action cannot be undone.
								</>
							) : (
								<>
									This action cannot be undone. Any integrations using this key will stop
									working immediately.
								</>
							)}
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
	const relativeLastUsed = formatRelative(apiKey.last_used_at)
	const expiresAt = apiKey.expires_at === null ? null : Date.parse(apiKey.expires_at)
	const expiresInPast = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt < Date.now()
	const expiresSoon =
		expiresAt !== null &&
		Number.isFinite(expiresAt) &&
		!expiresInPast &&
		expiresAt - Date.now() < 7 * 86_400_000

	// Type-coded icon tile: emerald for standard keys (live credential), blue for MCP
	// (agent/machine type). Revoked keys desaturate to neutral so dead keys read as dead.
	const tileClass = apiKey.revoked
		? "bg-muted/40 text-muted-foreground border-border"
		: isMcp
			? "bg-info/10 text-info border-info/30"
			: "bg-success/10 text-success border-success/30"

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
						{apiKey.key_prefix}
					</code>
					<MetaDot />
					{apiKey.scopes === null ? (
						<span className="text-muted-foreground/60 text-[11px]">Full access</span>
					) : (
						apiKey.scopes.map((scope) => (
							<code
								key={scope}
								className="text-foreground/70 border-border bg-muted/40 border px-1 font-mono text-[10px] tracking-tight"
							>
								{scope}
							</code>
						))
					)}
					<MetaDot />
					<MetaSpan label="Created">{formatDate(apiKey.created_at)}</MetaSpan>
					{apiKey.created_by_email && (
						<>
							<MetaDot />
							<MetaSpan label="by" className="max-w-[14rem] truncate">
								{apiKey.created_by_email}
							</MetaSpan>
						</>
					)}
					{apiKey.last_used_at && (
						<>
							<MetaDot />
							<MetaSpan label="Last used" title={formatDate(apiKey.last_used_at)}>
								{relativeLastUsed ?? formatDate(apiKey.last_used_at)}
							</MetaSpan>
						</>
					)}
					{apiKey.expires_at && (
						<>
							<MetaDot />
							<MetaSpan label={expiresInPast ? "Expired" : "Expires"}>
								<span className={expiresSoon ? "text-warning-foreground" : undefined}>
									{formatDate(apiKey.expires_at)}
								</span>
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
