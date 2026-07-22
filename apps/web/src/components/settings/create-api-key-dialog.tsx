import { useAtomSet } from "@/lib/effect-atom"
import { useId, useState } from "react"
import { Exit } from "effect"
import type { ApiKeyKind } from "@maple/domain/http"
import type { V2ApiKeyWithSecret, V2Scope } from "@maple/domain/http/v2"
import { toast } from "sonner"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { useApiKeyMutationSync } from "@/hooks/use-api-keys"
import { formatBackendError } from "@/lib/error-messages"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { buildApiKeyCreatePayload } from "./api-key-create-payload"
import { ApiKeySecretReveal } from "./api-key-secret-reveal"

interface CreateApiKeyDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onCreated?: (secret: string) => void
	kind?: ApiKeyKind
}

const EXPIRATION_OPTIONS = [
	{ value: "never", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "1 year" },
] as const

type ExpirationValue = (typeof EXPIRATION_OPTIONS)[number]["value"]

/**
 * v2 scope families the dashboard can mint restricted keys for. Only families
 * with live /v2 route groups belong here — append as groups ship (error_issues,
 * traces per docs/api-v2.md). A family is the first path segment under /v2, so
 * the /v2/alerts/* namespace (rules, destinations, incidents) is one family.
 */
const SCOPE_FAMILIES = [
	{ id: "api_keys", label: "API keys" },
	{ id: "dashboards", label: "Dashboards" },
	{ id: "alerts", label: "Alerts" },
	{ id: "ingest_keys", label: "Ingest keys" },
	{ id: "attribute_mappings", label: "Attribute mappings" },
	{ id: "scrape_targets", label: "Scrape targets" },
	{ id: "instrumentation", label: "Recommendations" },
	{ id: "investigations", label: "Investigations" },
	{ id: "anomalies", label: "Anomalies" },
	{ id: "session_replays", label: "Session replays" },
	{ id: "traces", label: "Traces" },
	{ id: "logs", label: "Logs" },
	{ id: "metrics", label: "Metrics" },
	{ id: "services", label: "Services" },
	{ id: "service_map", label: "Service map" },
	{ id: "query", label: "Query" },
	{ id: "organization", label: "Organization" },
] as const

type ScopeLevel = "none" | "read" | "write"
type AccessMode = "full" | "restricted"

const defaultScopeLevels = (): Record<string, ScopeLevel> =>
	Object.fromEntries(SCOPE_FAMILIES.map((f) => [f.id, "none"]))

const scopesFromLevels = (levels: Record<string, ScopeLevel>): Array<V2Scope> =>
	SCOPE_FAMILIES.flatMap((f) => {
		const level = levels[f.id]
		return level === "read" || level === "write" ? [`${f.id}:${level}` as V2Scope] : []
	})

export function CreateApiKeyDialog({ open, onOpenChange, onCreated, kind }: CreateApiKeyDialogProps) {
	const isMcp = kind === "mcp"
	const accessLabelId = useId()
	const [newName, setNewName] = useState("")
	const [newDescription, setNewDescription] = useState("")
	const [expiration, setExpiration] = useState<ExpirationValue>("never")
	const [accessMode, setAccessMode] = useState<AccessMode>("full")
	const [scopeLevels, setScopeLevels] = useState<Record<string, ScopeLevel>>(defaultScopeLevels)
	const [isCreating, setIsCreating] = useState(false)
	const [createdKey, setCreatedKey] = useState<V2ApiKeyWithSecret | null>(null)

	const { prepareForMutation, reconcileTxid } = useApiKeyMutationSync()
	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("apiKeys", "create"), {
		mode: "promiseExit",
	})

	const restrictedScopes = !isMcp && accessMode === "restricted" ? scopesFromLevels(scopeLevels) : undefined
	const missingScopes = !isMcp && accessMode === "restricted" && restrictedScopes?.length === 0
	const canCreate = newName.trim().length > 0 && !missingScopes && !isCreating

	async function handleCreate() {
		if (!canCreate) return
		setIsCreating(true)
		prepareForMutation()
		const result = await createMutation({
			payload: buildApiKeyCreatePayload(newName, newDescription, kind, {
				...(expiration !== "never" ? { expiresInSeconds: Number(expiration) * 86_400 } : {}),
				...(restrictedScopes !== undefined ? { scopes: restrictedScopes } : {}),
			}),
		})
		if (Exit.isSuccess(result)) {
			setCreatedKey(result.value)
			onCreated?.(result.value.secret)
			void reconcileTxid(result.value.txid)
		} else {
			const { title, description } = formatBackendError(result)
			toast.error(title, { description })
		}
		setIsCreating(false)
	}

	function handleClose(nextOpen: boolean) {
		if (nextOpen) {
			onOpenChange(true)
			return
		}
		onOpenChange(false)
		setNewName("")
		setNewDescription("")
		setExpiration("never")
		setAccessMode("full")
		setScopeLevels(defaultScopeLevels())
		setCreatedKey(null)
	}

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent>
				{createdKey ? (
					<>
						<DialogHeader>
							<DialogTitle>{isMcp ? "MCP key created" : "API key created"}</DialogTitle>
							<DialogDescription>
								Copy your API key now. You won't be able to see it again.
							</DialogDescription>
						</DialogHeader>
						<DialogPanel className="space-y-3">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="text-foreground text-sm font-medium">{createdKey.name}</span>
								<code className="text-muted-foreground font-mono text-[11px] tracking-tight">
									{createdKey.key_prefix}…
								</code>
								{createdKey.scopes !== null &&
									createdKey.scopes.map((scope) => (
										<Badge key={scope} variant="outline" size="sm" className="font-mono">
											{scope}
										</Badge>
									))}
							</div>
							<ApiKeySecretReveal secret={createdKey.secret} />
						</DialogPanel>
						<DialogFooter>
							<Button variant="outline" onClick={() => handleClose(false)}>
								Done
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>{isMcp ? "Create MCP key" : "Create API key"}</DialogTitle>
							<DialogDescription>
								{isMcp
									? "MCP keys authenticate clients with the Maple MCP server."
									: "API keys authenticate clients with the Maple API."}
							</DialogDescription>
						</DialogHeader>
						<DialogPanel className="space-y-4">
							<div className="space-y-1.5">
								<Label htmlFor="api-key-name">Name</Label>
								<Input
									id="api-key-name"
									placeholder="e.g. CI/CD Pipeline"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && canCreate) {
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
							<div className="space-y-1.5">
								<Label htmlFor="api-key-expiration">Expiration</Label>
								<Select
									items={EXPIRATION_OPTIONS.map((o) => ({
										value: o.value,
										label: o.label,
									}))}
									value={expiration}
									onValueChange={(value) => setExpiration(value as ExpirationValue)}
								>
									<SelectTrigger id="api-key-expiration" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{EXPIRATION_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{!isMcp && (
								<div className="space-y-2">
									<Label id={accessLabelId}>Access</Label>
									<ToggleGroup
										aria-labelledby={accessLabelId}
										value={[accessMode]}
										onValueChange={(values) => {
											const next = values[0]
											if (next === "full" || next === "restricted") setAccessMode(next)
										}}
										variant="outline"
										size="sm"
									>
										<ToggleGroupItem value="full">Full access</ToggleGroupItem>
										<ToggleGroupItem value="restricted">Restricted</ToggleGroupItem>
									</ToggleGroup>
									{accessMode === "restricted" ? (
										<div className="space-y-2 pt-1">
											{SCOPE_FAMILIES.map((family) => {
												const familyLabelId = `${accessLabelId}-${family.id}`
												return (
													<div
														key={family.id}
														className="flex items-center justify-between gap-3"
													>
														<span
															id={familyLabelId}
															className="text-foreground text-sm"
														>
															{family.label}
														</span>
														<ToggleGroup
															aria-labelledby={familyLabelId}
															value={[scopeLevels[family.id] ?? "none"]}
															onValueChange={(values) => {
																const next = values[0]
																if (
																	next === "none" ||
																	next === "read" ||
																	next === "write"
																) {
																	setScopeLevels((current) => ({
																		...current,
																		[family.id]: next,
																	}))
																}
															}}
															variant="outline"
															size="sm"
														>
															<ToggleGroupItem value="none">
																None
															</ToggleGroupItem>
															<ToggleGroupItem value="read">
																Read
															</ToggleGroupItem>
															<ToggleGroupItem value="write">
																Write
															</ToggleGroupItem>
														</ToggleGroup>
													</div>
												)
											})}
											<p className="text-muted-foreground text-xs">
												Write includes read. Scopes are fixed at creation — roll the
												key to change access.
											</p>
										</div>
									) : (
										<p className="text-muted-foreground text-xs">
											Full access to the organization's API.
										</p>
									)}
								</div>
							)}
						</DialogPanel>
						<DialogFooter>
							<Button variant="outline" onClick={() => handleClose(false)}>
								Cancel
							</Button>
							<Button onClick={handleCreate} disabled={!canCreate}>
								{isCreating ? "Creating..." : "Create"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}
