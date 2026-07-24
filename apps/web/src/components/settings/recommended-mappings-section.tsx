import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Recommendation } from "@maple/domain/http/v2"
import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import { toast } from "sonner"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
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
import { formatNumber, formatRelativeTime } from "@/lib/format"

type IssueKind = V2Recommendation["kind"]
type IssueStatus = V2Recommendation["status"]

// Mono uppercase kind tags in the row's leading lane (Paper ingestion redesign).
const KIND_TAG: Record<IssueKind, { label: string; className: string }> = {
	rename: { label: "Rename", className: "text-info" },
	"double-emission": { label: "Duplicate", className: "text-warning" },
	naming: { label: "Naming", className: "text-warning" },
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

	function FilterTab({ id, label, count }: { id: "open" | "closed"; label: string; count: number }) {
		const active = tab === id
		return (
			<button
				type="button"
				onClick={() => setTab(id)}
				className={cn(
					"rounded-md px-2.5 py-1 font-mono text-[11px] leading-3.5 transition-colors",
					active
						? "bg-accent text-foreground font-medium"
						: "text-muted-foreground hover:text-foreground border border-transparent",
				)}
			>
				{label} · {count}
			</button>
		)
	}

	return (
		<div className="bg-card flex flex-col rounded-lg border">
			<div className="flex items-start gap-3 px-4 pt-4 pb-3">
				<div className="flex flex-col gap-1">
					<h3 className="text-sm font-medium">Recommendations</h3>
					<p className="text-muted-foreground text-xs">
						Deprecated or non-conforming OpenTelemetry attribute keys detected on your spans.
					</p>
				</div>
				<div className="grow" />
				<div className="flex shrink-0 items-center gap-1.5">
					<FilterTab id="open" label="Open" count={openIssues.length} />
					<FilterTab id="closed" label="Closed" count={closedIssues.length} />
				</div>
			</div>

			{rows.length === 0 ? (
				<p className="text-muted-foreground border-t px-4 py-8 text-center text-sm">
					{tab === "open"
						? "No open recommendations — your span attributes look healthy."
						: "Nothing here yet."}
				</p>
			) : (
				rows.map((issue) => {
					const kindTag = KIND_TAG[issue.kind]
					const mode = issue.kind === "rename" ? MODE.auto : MODE.manual
					const status = STATUS_BADGE[issue.status]
					const isApplying = applyingId === issue.id
					const isBusy = busyId === issue.id

					return (
						<div
							key={issue.id}
							className="group hover:bg-muted/20 flex items-center gap-3 border-t px-4 py-2.5 transition-colors"
						>
							<span
								className={cn(
									"w-20 shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.12em]",
									kindTag.className,
								)}
							>
								{kindTag.label}
							</span>
							<Link
								to="/recommendations/$recommendationKey"
								params={{ recommendationKey: issue.id }}
								className="group/link min-w-0 flex-1 truncate text-sm"
								title={`${recPlainText(issue)} · ${issue.usage_count.toLocaleString()} spans in 24h · opened ${formatRelativeTime(issue.opened_at)}`}
							>
								<span className="underline-offset-4 decoration-muted-foreground/40 group-hover/link:underline">
									{recSentence(issue)}
								</span>
								<span className="text-muted-foreground">
									{" "}
									· {formatNumber(issue.usage_count)} spans/24h
								</span>
							</Link>

							<div className="flex shrink-0 items-center gap-1.5">
								{issue.status === "open" ? (
									<>
										{issue.kind === "rename" ? (
											<Button
												size="sm"
												onClick={() => handleApply(issue)}
												disabled={isApplying}
											>
												{isApplying ? (
													<LoaderIcon size={14} className="animate-spin" />
												) : (
													<CheckIcon size={14} />
												)}
												Apply fix
											</Button>
										) : (
											<Badge
												variant="outline"
												className={cn("gap-1", mode.className)}
												title={mode.title}
											>
												<mode.icon size={11} />
												{mode.label}
											</Badge>
										)}
										<Button
											variant="outline"
											size="sm"
											className="text-muted-foreground hover:text-foreground"
											onClick={() => handleDismiss(issue)}
											disabled={isBusy}
										>
											{isBusy ? (
												<LoaderIcon size={14} className="animate-spin" />
											) : (
												<XmarkIcon size={14} />
											)}
											Dismiss
										</Button>
									</>
								) : issue.status === "dismissed" ? (
									<>
										<Badge variant={status.variant}>{status.label}</Badge>
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
									</>
								) : (
									<Badge variant={status.variant}>{status.label}</Badge>
								)}
							</div>
						</div>
					)
				})
			)}
		</div>
	)
}
