import { useAtomSet } from "@/lib/effect-atom"
import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { toast } from "sonner"
import { cn } from "@maple/ui/lib/utils"

import { Button } from "@maple/ui/components/ui/button"
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
	const [view, setView] = useState<"active" | "revoked">("active")
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

	const showRevokedSection = view === "active" && revokedKeys.length > 0
	const visibleActive = view === "active" ? activeKeys : []

	return (
		<div className="space-y-6">
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-3">
					{keys.length > 0 && (
						<>
							<div className="border-border flex items-center gap-0.5 rounded-md border p-0.5">
								<FilterTab active={view === "active"} onClick={() => setView("active")}>
									Active · {activeKeys.length}
								</FilterTab>
								<FilterTab active={view === "revoked"} onClick={() => setView("revoked")}>
									Revoked · {revokedKeys.length}
								</FilterTab>
							</div>
							{activeKeys.length > 0 && (
								<span className="text-muted-foreground font-mono text-[11px]">
									<span className="text-success-foreground">{standardCount} standard</span>
									<span className="text-muted-foreground/40"> · </span>
									<span className="text-info-foreground">{mcpCount} mcp</span>
								</span>
							)}
						</>
					)}
					<div className="flex-1" />
					<a
						href="https://maple.dev/docs"
						target="_blank"
						rel="noopener noreferrer"
						className="text-muted-foreground hover:text-foreground text-xs transition-colors"
					>
						View API docs ↗
					</a>
					<Button onClick={() => setCreateOpen(true)} size="sm" disabled={!isAdmin}>
						<PlusIcon data-icon="inline-start" size={14} />
						Create key
					</Button>
				</div>

				<div className="bg-card rounded-lg border">
					{isLoading ? (
						<div className="space-y-2 p-4">
							<Skeleton className="h-[52px] w-full" />
							<Skeleton className="h-[52px] w-full" />
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
					) : view === "revoked" && revokedKeys.length === 0 ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<KeyIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No revoked keys</EmptyTitle>
								<EmptyDescription>Revoked keys will show up here.</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="divide-border divide-y">
							<div className="flex items-center gap-3 px-4 py-2">
								<span className={cn(COL_HEADER, "min-w-0 flex-1")}>Key</span>
								<span className={cn(COL_HEADER, COL.prefix)}>Prefix</span>
								<span className={cn(COL_HEADER, COL.scopes)}>Scopes</span>
								<span className={cn(COL_HEADER, COL.lastUsed)}>Last used</span>
								<span className={cn(COL_HEADER, COL.expires)}>Expires</span>
								<span className={cn(COL.menu)} />
							</div>
							{visibleActive.map((key) => (
								<ApiKeyRow
									key={key.id}
									apiKey={key}
									onRoll={() => openRollDialog(key)}
									onRevoke={() => openRevokeDialog(key)}
								/>
							))}
							{showRevokedSection && (
								<div className="bg-muted/20 px-4 py-1.5">
									<span className="text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.15em]">
										Revoked · {revokedKeys.length}
									</span>
								</div>
							)}
							{(showRevokedSection || view === "revoked") &&
								revokedKeys.map((key) => <ApiKeyRow key={key.id} apiKey={key} />)}
						</div>
					)}
				</div>
			</div>

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

// Shared column lanes so the header row and key rows stay aligned. Prefix/scopes/last-used
// collapse on narrower viewports; the key cell always keeps name + created meta visible.
const COL = {
	prefix: "hidden w-[120px] shrink-0 lg:block",
	scopes: "hidden w-[180px] shrink-0 xl:block",
	lastUsed: "hidden w-[90px] shrink-0 xl:block",
	expires: "hidden w-[110px] shrink-0 md:block",
	menu: "w-7 shrink-0",
}
const COL_HEADER = "text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.12em]"

function FilterTab({
	active,
	onClick,
	children,
}: {
	active: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded px-2.5 py-1 font-mono text-[11px] leading-4 transition-colors",
				active
					? "bg-accent text-foreground font-medium"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}

function ApiKeyRow({
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
		? "bg-muted/40 text-muted-foreground"
		: isMcp
			? "bg-info/10 text-info"
			: "bg-success/10 text-success"

	const createdMeta = [
		apiKey.description,
		`Created ${formatDate(apiKey.created_at)}${apiKey.created_by_email ? ` by ${apiKey.created_by_email}` : ""}`,
	]
		.filter(Boolean)
		.join(" · ")

	return (
		<div
			className={cn(
				"flex items-center gap-3 px-4 py-3 transition-colors",
				apiKey.revoked ? "opacity-60" : "hover:bg-muted/20",
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<div
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-md",
						tileClass,
					)}
				>
					<Icon size={13} />
				</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="text-foreground truncate text-sm font-medium leading-none">
							{apiKey.name}
						</span>
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
					<span className="text-muted-foreground truncate text-[11px]" title={createdMeta}>
						{createdMeta}
					</span>
				</div>
			</div>

			<code className={cn(COL.prefix, "text-foreground/55 truncate font-mono text-[11px] tracking-tight")}>
				{apiKey.key_prefix}
			</code>

			<div className={cn(COL.scopes)}>
				<ScopesCell apiKey={apiKey} />
			</div>

			<span
				className={cn(COL.lastUsed, "text-muted-foreground truncate text-[11px]")}
				title={apiKey.last_used_at ? formatDate(apiKey.last_used_at) : undefined}
			>
				{apiKey.last_used_at ? (relativeLastUsed ?? formatDate(apiKey.last_used_at)) : "—"}
			</span>

			<span
				className={cn(
					COL.expires,
					"truncate text-[11px]",
					expiresSoon ? "text-warning-foreground" : "text-muted-foreground",
				)}
			>
				{apiKey.expires_at ? formatDate(apiKey.expires_at) : "Never"}
			</span>

			<div className={cn(COL.menu, "flex items-center justify-end")}>
				{!apiKey.revoked && onRevoke && (
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
				)}
			</div>
		</div>
	)
}

function ScopesCell({ apiKey }: { apiKey: ApiKey }) {
	if (apiKey.kind === "mcp") {
		return <span className="text-muted-foreground text-[11px]">MCP tools</span>
	}
	if (apiKey.scopes === null) {
		return <span className="text-foreground/80 text-[11px]">Full access</span>
	}
	const compact = apiKey.scopes.map((scope) => scope.replace(/:write$/, ":w").replace(/:read$/, ":r"))
	const shown = compact.slice(0, 2).join(" · ")
	const extra = compact.length - 2
	return (
		<span
			className="text-muted-foreground block truncate font-mono text-[11px] tracking-tight"
			title={apiKey.scopes.join(", ")}
		>
			{shown}
			{extra > 0 ? ` · +${extra}` : ""}
		</span>
	)
}
