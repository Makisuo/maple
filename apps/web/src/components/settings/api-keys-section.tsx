import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useState, type ReactNode } from "react"
import { Exit } from "effect"
import { CreateApiKeyRequest, type ApiKeyId, type ApiKeyResponse } from "@maple/domain/http"
import { toast } from "sonner"
import { cn } from "@maple/ui/lib/utils"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Badge } from "@maple/ui/components/ui/badge"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
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
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	AlertWarningIcon,
	CheckIcon,
	CopyIcon,
	KeyIcon,
	PlusIcon,
	SquareTerminalIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

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
	const [newName, setNewName] = useState("")
	const [newDescription, setNewDescription] = useState("")
	const [isCreating, setIsCreating] = useState(false)
	const [newSecret, setNewSecret] = useState<string | null>(null)
	const [secretCopied, setSecretCopied] = useState(false)
	const [revokeOpen, setRevokeOpen] = useState(false)
	const [revokingKeyId, setRevokingKeyId] = useState<ApiKeyId | null>(null)
	const [isRevoking, setIsRevoking] = useState(false)

	const listQueryAtom = MapleApiAtomClient.query("apiKeys", "list", {})
	const listResult = useAtomValue(listQueryAtom)
	const refreshKeys = useAtomRefresh(listQueryAtom)

	const createMutation = useAtomSet(MapleApiAtomClient.mutation("apiKeys", "create"), {
		mode: "promiseExit",
	})
	const revokeMutation = useAtomSet(MapleApiAtomClient.mutation("apiKeys", "revoke"), {
		mode: "promiseExit",
	})

	const keys = Result.builder(listResult)
		.onSuccess((response) => response.keys)
		.orElse(() => [])

	async function handleCreate() {
		if (!newName.trim()) return
		setIsCreating(true)
		const result = await createMutation({
			payload: new CreateApiKeyRequest({
				name: newName.trim(),
				description: newDescription.trim() || undefined,
			}),
		})
		if (Exit.isSuccess(result)) {
			setNewSecret(result.value.secret)
			refreshKeys()
		} else {
			toast.error("Failed to create API key")
		}
		setIsCreating(false)
	}

	function handleCreateDialogClose(open: boolean) {
		if (open) {
			setCreateOpen(true)
			return
		}
		setCreateOpen(false)
		setNewName("")
		setNewDescription("")
		setNewSecret(null)
		setSecretCopied(false)
	}

	async function handleCopySecret() {
		if (!newSecret) return
		try {
			await navigator.clipboard.writeText(newSecret)
			setSecretCopied(true)
			toast.success("API key copied to clipboard")
			setTimeout(() => setSecretCopied(false), 2000)
		} catch {
			toast.error("Failed to copy API key")
		}
	}

	function openRevokeDialog(keyId: ApiKeyId) {
		setRevokingKeyId(keyId)
		setRevokeOpen(true)
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
									<span>{standardCount} standard</span>
									<MetaDot />
									<span className="text-severity-info">{mcpCount} mcp</span>
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
								<div className="space-y-1.5">
									{activeKeys.map((key) => (
										<ApiKeyListItem
											key={key.id}
											apiKey={key}
											onRevoke={() => openRevokeDialog(key.id)}
										/>
									))}
								</div>
							)}
							{revokedKeys.length > 0 && (
								<div className="space-y-1.5 pt-2">
									<div className="flex items-center gap-2">
										<span className="bg-border h-px flex-1" />
										<span className="text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.15em]">
											Revoked · {revokedKeys.length}
										</span>
										<span className="bg-border h-px flex-1" />
									</div>
									{revokedKeys.map((key) => (
										<ApiKeyListItem key={key.id} apiKey={key} />
									))}
								</div>
							)}
						</div>
					)}
				</CardContent>
			</Card>

			<Dialog open={createOpen} onOpenChange={handleCreateDialogClose}>
				<DialogContent>
					{newSecret ? (
						<>
							<DialogHeader>
								<DialogTitle>API key created</DialogTitle>
								<DialogDescription>
									Copy your API key now. You won't be able to see it again.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-3">
								<InputGroup>
									<InputGroupInput
										readOnly
										value={newSecret}
										className="font-mono text-xs tracking-wide select-all"
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											onClick={handleCopySecret}
											aria-label="Copy API key"
											title={secretCopied ? "Copied!" : "Copy"}
										>
											{secretCopied ? (
												<CheckIcon size={14} className="text-severity-info" />
											) : (
												<CopyIcon size={14} />
											)}
										</InputGroupButton>
									</InputGroupAddon>
								</InputGroup>
								<p className="text-muted-foreground text-xs">
									Store this key in a secure location. It will not be shown again.
								</p>
							</div>
							<DialogFooter>
								<Button variant="outline" onClick={() => handleCreateDialogClose(false)}>
									Close
								</Button>
							</DialogFooter>
						</>
					) : (
						<>
							<DialogHeader>
								<DialogTitle>Create API key</DialogTitle>
								<DialogDescription>
									API keys are used to authenticate with the Maple API and MCP server.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-3">
								<div className="space-y-1.5">
									<Label htmlFor="api-key-name">Name</Label>
									<Input
										id="api-key-name"
										placeholder="e.g. CI/CD Pipeline"
										value={newName}
										onChange={(e) => setNewName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && newName.trim()) {
												void handleCreate()
											}
										}}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="api-key-description">
										Description{" "}
										<span className="text-muted-foreground font-normal">(optional)</span>
									</Label>
									<Input
										id="api-key-description"
										placeholder="What is this key used for?"
										value={newDescription}
										onChange={(e) => setNewDescription(e.target.value)}
									/>
								</div>
							</div>
							<DialogFooter>
								<Button variant="outline" onClick={() => handleCreateDialogClose(false)}>
									Cancel
								</Button>
								<Button onClick={handleCreate} disabled={!newName.trim() || isCreating}>
									{isCreating ? "Creating..." : "Create"}
								</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>

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

function ApiKeyListItem({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke?: () => void }) {
	const isMcp = apiKey.kind === "mcp"
	const Icon = isMcp ? SquareTerminalIcon : KeyIcon
	const relativeLastUsed = formatRelative(apiKey.lastUsedAt)
	const expiresInPast = apiKey.expiresAt !== null && apiKey.expiresAt < Date.now()

	return (
		<div
			className={cn(
				"group relative flex items-start gap-3 border px-3 py-2.5 transition-colors",
				apiKey.revoked
					? "bg-muted/10 opacity-60"
					: "bg-muted/20 hover:bg-muted/40 hover:border-foreground/20",
			)}
		>
			{!apiKey.revoked && isMcp && (
				<span
					aria-hidden="true"
					className="bg-severity-info/70 absolute inset-y-0 left-0 w-px"
				/>
			)}

			<div
				className={cn(
					"flex h-9 w-9 shrink-0 items-center justify-center border",
					isMcp
						? "bg-severity-info/10 text-severity-info border-severity-info/30"
						: "bg-background/60 text-foreground/70 border-border",
				)}
			>
				<Icon size={14} />
			</div>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-foreground text-sm font-medium leading-none">
						{apiKey.name}
					</span>
					{isMcp && (
						<span className="text-severity-info bg-severity-info/10 border-severity-info/25 inline-flex h-4 items-center gap-1 border px-1.5 font-mono text-[9px] uppercase tracking-[0.12em]">
							MCP
						</span>
					)}
					{apiKey.revoked && (
						<Badge variant="destructive" className="h-4 px-1.5 text-[10px] uppercase tracking-wider">
							Revoked
						</Badge>
					)}
					{expiresInPast && !apiKey.revoked && (
						<Badge variant="outline" className="text-foreground/60 border-foreground/30 h-4 px-1.5 text-[10px] uppercase tracking-wider">
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
							<MetaSpan
								label="Last used"
								title={formatDate(apiKey.lastUsedAt)}
							>
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

			<div className="flex shrink-0 items-center gap-2 pt-1">
				{!apiKey.revoked && (
					<span
						className="bg-severity-info/15 inline-flex h-5 items-center gap-1.5 px-1.5 font-mono text-[10px] uppercase tracking-wider"
						aria-label="Active"
					>
						<span className="bg-severity-info relative h-1.5 w-1.5 rounded-full">
							<span className="bg-severity-info/60 absolute inset-0 animate-ping rounded-full" />
						</span>
						<span className="text-severity-info">Active</span>
					</span>
				)}
				{!apiKey.revoked && onRevoke && (
					<Button
						variant="ghost"
						size="xs"
						onClick={onRevoke}
						className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
					>
						Revoke
					</Button>
				)}
			</div>
		</div>
	)
}

function MetaDot() {
	return <span aria-hidden="true" className="text-muted-foreground/40 text-[10px]">·</span>
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
