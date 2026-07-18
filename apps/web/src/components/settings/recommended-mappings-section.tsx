import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Recommendation } from "@maple/domain/http/v2"
import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import { toast } from "sonner"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowRotateAnticlockwiseIcon,
	BoltIcon,
	CheckIcon,
	CodeIcon,
	LoaderIcon,
	XmarkIcon,
} from "@/components/icons"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	ingestAttributeMappingsListAtom,
	recommendationIssuesListAtom,
} from "@/lib/services/atoms/ingestion-atoms"
import { formatRelativeTime } from "@/lib/format"

type IssueKind = V2Recommendation["kind"]
type IssueStatus = V2Recommendation["status"]

const KIND_BADGE: Record<IssueKind, { label: string; variant: "success" | "warning" | "info" }> = {
	rename: { label: "Safe rename", variant: "success" },
	"double-emission": { label: "Both emitted", variant: "warning" },
	naming: { label: "Naming", variant: "info" },
}

const STATUS_BADGE: Record<IssueStatus, { label: string; variant: "success" | "secondary" }> = {
	open: { label: "Open", variant: "secondary" },
	dismissed: { label: "Dismissed", variant: "secondary" },
	applied: { label: "Applied", variant: "success" },
	resolved: { label: "Resolved", variant: "secondary" },
}

const MODE = {
	auto: {
		label: "Auto-apply",
		icon: BoltIcon,
		className: "border-primary/30 text-primary",
		title: "Maple can apply this for you — Apply creates the ingest mapping.",
	},
	manual: {
		label: "Manual fix",
		icon: CodeIcon,
		className: "text-muted-foreground",
		title: "Fix this in your SDK — an ingest mapping can't resolve it.",
	},
} as const

const MONO = "font-mono text-[0.92em] text-muted-foreground"

function recSentence(issue: V2Recommendation) {
	if (issue.kind === "double-emission") {
		return (
			<>
				<span className="text-foreground font-medium">Standardize on</span>{" "}
				<code className={MONO}>{issue.canonical_key}</code>
				<span className="text-muted-foreground"> — spans also emit </span>
				<code className={MONO}>{issue.source_key}</code>
			</>
		)
	}
	if (issue.kind === "naming") {
		return (
			<>
				<span className="text-foreground font-medium">Rename non-conforming key</span>{" "}
				<code className={MONO}>{issue.source_key}</code>
			</>
		)
	}
	return (
		<>
			<span className="text-foreground font-medium">Rename</span>{" "}
			<code className={MONO}>{issue.source_key}</code> <span className="text-muted-foreground">→</span>{" "}
			<code className={MONO}>{issue.canonical_key}</code>
		</>
	)
}

function recPlainText(issue: V2Recommendation): string {
	if (issue.kind === "double-emission")
		return `Standardize on ${issue.canonical_key} — spans also emit ${issue.source_key}`
	if (issue.kind === "naming") return `Rename non-conforming key ${issue.source_key}`
	return `Rename ${issue.source_key} → ${issue.canonical_key}`
}

export function RecommendedMappingsSection() {
	const [tab, setTab] = useState<"open" | "closed">("open")
	const [applyingId, setApplyingId] = useState<string | null>(null)
	const [busyId, setBusyId] = useState<string | null>(null)

	const listResult = useAtomValue(recommendationIssuesListAtom)
	const refreshIssues = useAtomRefresh(recommendationIssuesListAtom)
	// Applying a recommendation creates a mapping, so refresh the mappings list too.
	const refreshMappings = useAtomRefresh(ingestAttributeMappingsListAtom)

	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "create"), {
		mode: "promiseExit",
	})
	const dismissMutation = useAtomSet(
		MapleApiV2AtomClient.mutation("instrumentationRecommendations", "dismiss"),
		{
			mode: "promiseExit",
		},
	)
	const reopenMutation = useAtomSet(
		MapleApiV2AtomClient.mutation("instrumentationRecommendations", "reopen"),
		{
			mode: "promiseExit",
		},
	)

	const issues = Result.builder(listResult)
		.onSuccess((r) => [...r.data])
		.orElse(() => [] as V2Recommendation[])

	const openIssues = issues.filter((i) => i.status === "open")
	const closedIssues = issues.filter((i) => i.status !== "open")

	// Opportunistic — only surface when there's something open or dismissed to act on.
	const hasRelevant = issues.some((i) => i.status === "open" || i.status === "dismissed")
	if (!Result.isSuccess(listResult) || !hasRelevant) {
		return null
	}

	async function handleApply(issue: V2Recommendation) {
		if (issue.kind !== "rename" || !issue.canonical_key) return
		const canonicalKey = issue.canonical_key
		setApplyingId(issue.id)
		const result = await createMutation({
			payload: {
				name: `Rename ${issue.source_key} → ${canonicalKey}`,
				source_context: "span",
				source_key: issue.source_key,
				target_key: canonicalKey,
				operation: "copy",
			},
		})
		if (Exit.isSuccess(result)) {
			toast.success(`Mapping created — ${issue.source_key} → ${canonicalKey}`)
			refreshIssues()
			refreshMappings()
		} else {
			toast.error("Failed to create mapping")
		}
		setApplyingId(null)
	}

	async function handleDismiss(issue: V2Recommendation) {
		setBusyId(issue.id)
		const result = await dismissMutation({ params: { id: issue.id } })
		if (Exit.isSuccess(result)) {
			refreshIssues()
		} else {
			toast.error("Failed to dismiss recommendation")
		}
		setBusyId(null)
	}

	async function handleReopen(issue: V2Recommendation) {
		setBusyId(issue.id)
		const result = await reopenMutation({ params: { id: issue.id } })
		if (Exit.isSuccess(result)) {
			refreshIssues()
		} else {
			toast.error("Failed to reopen recommendation")
		}
		setBusyId(null)
	}

	const rows = tab === "open" ? openIssues : closedIssues

	function TabButton({ id, label, count }: { id: "open" | "closed"; label: string; count: number }) {
		const active = tab === id
		return (
			<button
				type="button"
				onClick={() => setTab(id)}
				className={cn(
					"-mb-px flex items-center gap-2 border-b-2 pt-1 pb-2.5 text-sm font-medium transition-colors",
					active
						? "border-primary text-foreground"
						: "text-muted-foreground hover:text-foreground border-transparent",
				)}
			>
				{label}
				<span
					className={cn(
						"rounded-full px-1.5 text-xs tabular-nums",
						active ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground",
					)}
				>
					{count}
				</span>
			</button>
		)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Recommendations</CardTitle>
				<CardDescription>
					Deprecated or non-conforming OpenTelemetry attribute keys detected on your spans. Apply a
					fix to create the matching mapping, or dismiss it.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{/* tabs */}
				<div className="border-border/60 -mx-6 flex items-center gap-5 border-b px-6">
					<TabButton id="open" label="Open" count={openIssues.length} />
					<TabButton id="closed" label="Closed" count={closedIssues.length} />
				</div>

				{/* column header */}
				<div className="text-muted-foreground border-border/60 -mx-6 flex items-center gap-4 border-b px-6 pt-3 pb-2 text-xs">
					<div className="w-12 shrink-0">#</div>
					<div className="w-28 shrink-0">Type</div>
					<div className="flex-1">Recommendation</div>
					<div className="w-28 shrink-0">{tab === "open" ? "Action" : "Status"}</div>
					<div className="w-32 shrink-0 text-right">Opened</div>
				</div>

				{rows.length === 0 ? (
					<p className="text-muted-foreground py-10 text-center text-sm">
						{tab === "open"
							? "No open recommendations — your span attributes look healthy."
							: "Nothing here yet."}
					</p>
				) : (
					<div>
						{rows.map((issue) => {
							const badge = KIND_BADGE[issue.kind]
							const mode = issue.kind === "rename" ? MODE.auto : MODE.manual
							const ModeIcon = mode.icon
							const status = STATUS_BADGE[issue.status]
							const isApplying = applyingId === issue.id
							const isBusy = busyId === issue.id

							return (
								<div
									key={issue.id}
									className="group border-border/60 hover:bg-muted/40 -mx-6 flex items-center gap-4 border-b px-6 py-2.5 transition-colors last:border-b-0"
								>
									<Link
										to="/recommendations/$recommendationKey"
										params={{ recommendationKey: issue.id }}
										className="text-muted-foreground hover:text-foreground w-12 shrink-0 font-mono text-[13px] tabular-nums"
									>
										#{issue.number}
									</Link>
									<div className="w-28 shrink-0">
										<Badge variant={badge.variant}>{badge.label}</Badge>
									</div>
									<Link
										to="/recommendations/$recommendationKey"
										params={{ recommendationKey: issue.id }}
										className="group/link min-w-0 flex-1 truncate text-sm"
										title={recPlainText(issue)}
									>
										<span className="underline-offset-4 decoration-muted-foreground/40 group-hover/link:underline">
											{recSentence(issue)}
										</span>
									</Link>

									<div className="w-28 shrink-0">
										{tab === "open" ? (
											<Badge
												variant="outline"
												className={cn("gap-1", mode.className)}
												title={mode.title}
											>
												<ModeIcon size={11} />
												{mode.label}
											</Badge>
										) : (
											<Badge variant={status.variant}>{status.label}</Badge>
										)}
									</div>

									<div className="relative flex w-32 shrink-0 items-center justify-end">
										<span
											className="text-muted-foreground text-xs whitespace-nowrap tabular-nums transition-opacity group-hover:opacity-0"
											title={`${issue.usage_count.toLocaleString()} spans · 24h`}
										>
											{formatRelativeTime(issue.opened_at)}
										</span>
										<div className="absolute right-0 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
											{issue.status === "open" ? (
												<>
													{issue.kind === "rename" ? (
														<Button
															size="sm"
															onClick={() => handleApply(issue)}
															disabled={isApplying}
														>
															{isApplying ? (
																<LoaderIcon
																	size={14}
																	className="animate-spin"
																/>
															) : (
																<CheckIcon size={14} />
															)}
															Apply
														</Button>
													) : null}
													<Button
														variant="ghost"
														size="icon-sm"
														className="text-muted-foreground hover:text-foreground"
														onClick={() => handleDismiss(issue)}
														disabled={isBusy}
														aria-label="Dismiss recommendation"
														title="Dismiss"
													>
														{isBusy ? (
															<LoaderIcon size={14} className="animate-spin" />
														) : (
															<XmarkIcon size={14} />
														)}
													</Button>
												</>
											) : issue.status === "dismissed" ? (
												<Button
													variant="outline"
													size="sm"
													onClick={() => handleReopen(issue)}
													disabled={isBusy}
												>
													{isBusy ? (
														<LoaderIcon size={14} className="animate-spin" />
													) : (
														<ArrowRotateAnticlockwiseIcon size={14} />
													)}
													Reopen
												</Button>
											) : null}
										</div>
									</div>
								</div>
							)
						})}
					</div>
				)}
			</CardContent>
		</Card>
	)
}
