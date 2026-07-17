import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit } from "effect"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { CreateIngestAttributeMappingRequest, type RecommendationIssue } from "@maple/domain/http"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	ingestAttributeMappingsListAtom,
	recommendationIssuesListAtom,
} from "@/lib/services/atoms/ingestion-atoms"
import { formatRelativeTime } from "@/lib/format"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowRotateAnticlockwiseIcon,
	BoltIcon,
	CheckIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	CodeIcon,
	CopyIcon,
	PulseIcon,
	XmarkIcon,
} from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

export const Route = effectRoute(createFileRoute("/recommendations/$recommendationKey"))({
	component: RecommendationDetailPage,
})

const INGESTION_HREF = "/settings?tab=ingestion"
const MONO = "font-mono text-[0.92em] text-muted-foreground"

type IssueKind = RecommendationIssue["kind"]
type IssueStatus = RecommendationIssue["status"]
type BusyAction = "apply" | "dismiss" | "reopen" | null

const KIND_BADGE: Record<IssueKind, { label: string; variant: "success" | "warning" | "info" }> = {
	rename: { label: "Safe rename", variant: "success" },
	"double-emission": { label: "Both emitted", variant: "warning" },
	naming: { label: "Naming", variant: "info" },
}

const STATUS_BADGE: Record<IssueStatus, { label: string; variant: "success" | "secondary" | "outline" }> = {
	open: { label: "Open", variant: "outline" },
	dismissed: { label: "Dismissed", variant: "secondary" },
	applied: { label: "Applied", variant: "success" },
	resolved: { label: "Resolved", variant: "success" },
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

/** The recommendation rendered as a sentence with mono-styled attribute keys. */
function recSentence(issue: RecommendationIssue) {
	if (issue.kind === "double-emission") {
		return (
			<>
				<span className="text-foreground font-medium">Standardize on</span>{" "}
				<code className={MONO}>{issue.canonicalKey}</code>
				<span className="text-muted-foreground"> — spans also emit </span>
				<code className={MONO}>{issue.sourceKey}</code>
			</>
		)
	}
	if (issue.kind === "naming") {
		return (
			<>
				<span className="text-foreground font-medium">Rename non-conforming key</span>{" "}
				<code className={MONO}>{issue.sourceKey}</code>
			</>
		)
	}
	return (
		<>
			<span className="text-foreground font-medium">Rename</span>{" "}
			<code className={MONO}>{issue.sourceKey}</code> <span className="text-muted-foreground">→</span>{" "}
			<code className={MONO}>{issue.canonicalKey}</code>
		</>
	)
}

function RecommendationDetailPage() {
	const { recommendationKey } = Route.useParams()

	const listResult = useAtomValue(recommendationIssuesListAtom)
	const refreshIssues = useAtomRefresh(recommendationIssuesListAtom)
	// Applying a recommendation creates a mapping, so refresh the mappings list too.
	const refreshMappings = useAtomRefresh(ingestAttributeMappingsListAtom)

	const createMutation = useAtomSet(MapleApiAtomClient.mutation("ingestAttributeMappings", "create"), {
		mode: "promiseExit",
	})
	const dismissMutation = useAtomSet(MapleApiAtomClient.mutation("recommendationIssues", "dismiss"), {
		mode: "promiseExit",
	})
	const reopenMutation = useAtomSet(MapleApiAtomClient.mutation("recommendationIssues", "reopen"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<BusyAction>(null)

	const issue = useMemo(
		() =>
			Result.builder(listResult)
				.onSuccess((r) => r.issues.find((i) => i.id === recommendationKey) ?? null)
				.orElse(() => null),
		[listResult, recommendationKey],
	)

	async function handleApply(target: RecommendationIssue) {
		if (target.kind !== "rename" || !target.canonicalKey) return
		setBusy("apply")
		const result = await createMutation({
			payload: new CreateIngestAttributeMappingRequest({
				name: `Rename ${target.sourceKey} → ${target.canonicalKey}`,
				sourceContext: "span",
				sourceKey: target.sourceKey,
				targetKey: target.canonicalKey,
				operation: "copy",
			}),
		})
		if (Exit.isSuccess(result)) {
			toast.success(`Mapping created — ${target.sourceKey} → ${target.canonicalKey}`)
			refreshIssues()
			refreshMappings()
		} else {
			toast.error("Failed to create mapping")
		}
		setBusy(null)
	}

	async function handleDismiss(target: RecommendationIssue) {
		setBusy("dismiss")
		const result = await dismissMutation({ params: { id: target.id } })
		if (Exit.isSuccess(result)) refreshIssues()
		else toast.error("Failed to dismiss recommendation")
		setBusy(null)
	}

	async function handleReopen(target: RecommendationIssue) {
		setBusy("reopen")
		const result = await reopenMutation({ params: { id: target.id } })
		if (Exit.isSuccess(result)) refreshIssues()
		else toast.error("Failed to reopen recommendation")
		setBusy(null)
	}

	return Result.builder(listResult)
		.onInitial(() => <LoadingShell />)
		.onError((error) => <ErrorShell message={error.message} />)
		.onSuccess(() => {
			if (!issue) return <InactiveShell />
			return (
				<DetailView
					issue={issue}
					busy={busy}
					onApply={() => handleApply(issue)}
					onDismiss={() => handleDismiss(issue)}
					onReopen={() => handleReopen(issue)}
				/>
			)
		})
		.render()
}

/* -------------------------------------------------------------------------------------------------
 * Detail view
 * -------------------------------------------------------------------------------------------------*/

function DetailView({
	issue,
	busy,
	onApply,
	onDismiss,
	onReopen,
}: {
	issue: RecommendationIssue
	busy: BusyAction
	onApply: () => void
	onDismiss: () => void
	onReopen: () => void
}) {
	const status = STATUS_BADGE[issue.status]
	const isApplyable = issue.kind === "rename" && Boolean(issue.canonicalKey)
	const isLive = issue.status === "applied" || issue.status === "resolved"

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Ingestion", href: INGESTION_HREF },
				{ label: `Recommendation #${issue.number}` },
			]}
			titleContent={
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
						{recSentence(issue)}
					</h1>
					<Badge variant={status.variant} size="lg">
						{status.label}
					</Badge>
				</div>
			}
			description={`Opened ${formatRelativeTime(issue.openedAt)} · ${issue.usageCount.toLocaleString()} spans · 24h`}
			rightSidebar={
				<DetailSidebar
					issue={issue}
					busy={busy}
					isApplyable={isApplyable}
					isLive={isLive}
					onApply={onApply}
					onDismiss={onDismiss}
					onReopen={onReopen}
				/>
			}
		>
			<div className="max-w-3xl space-y-6">
				<Summary issue={issue} />
				<ChangeBreakdown issue={issue} />
				<CautionCallout issue={issue} isApplyable={isApplyable} />
				{isApplyable && issue.canonicalKey ? (
					<MappingBlock issue={issue} isLive={isLive} />
				) : (
					<SdkFixBlock issue={issue} />
				)}
			</div>
		</DashboardLayout>
	)
}

/** Plain-language explanation of the recommendation, with mono-styled keys. */
function Summary({ issue }: { issue: RecommendationIssue }) {
	let body: React.ReactNode
	if (issue.kind === "double-emission") {
		body = (
			<>
				Your spans emit both <code className={MONO}>{issue.sourceKey}</code> and{" "}
				<code className={MONO}>{issue.canonicalKey}</code>. Standardize on{" "}
				<code className={MONO}>{issue.canonicalKey}</code> in your SDK — an ingest mapping can't merge
				them because the canonical key already exists on your spans.
			</>
		)
	} else if (issue.kind === "naming") {
		body = (
			<>
				<code className={MONO}>{issue.sourceKey}</code> doesn't follow OpenTelemetry's lowercase{" "}
				<code className={MONO}>dotted.snake_case</code> convention. Rename it where your spans are
				created so it conforms to the semantic conventions.
			</>
		)
	} else {
		body = (
			<>
				<code className={MONO}>{issue.sourceKey}</code> is a deprecated or non-conforming
				OpenTelemetry attribute key. Maple can rewrite it to{" "}
				<code className={MONO}>{issue.canonicalKey}</code> at ingest time so newly ingested spans use
				the current semantic-convention name.
			</>
		)
	}
	return <p className="text-[15px] leading-relaxed text-foreground/90">{body}</p>
}

/** Before → after card — the deprecated key today vs. the key Maple writes. */
function ChangeBreakdown({ issue }: { issue: RecommendationIssue }) {
	const labels = {
		rename: { from: "Deprecated key on your spans today", to: "Canonical key Maple will write" },
		"double-emission": {
			from: "Deprecated key — still emitted",
			to: "Canonical key — already present",
		},
		naming: { from: "Non-conforming key", to: "" },
	}[issue.kind]

	const note =
		issue.kind === "double-emission"
			? "Both keys are already on your spans — an ingest mapping can't merge them. Standardize on the canonical key in your SDK."
			: issue.kind === "naming"
				? "No confident canonical target — rename this attribute at your SDK."
				: null

	return (
		<section>
			<SectionHeader label="What changes" />
			<div className="overflow-hidden rounded-md border">
				<div className="flex items-start gap-3 px-4 py-3">
					<CircleXmarkIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="text-xs text-muted-foreground">{labels.from}</p>
						<code className="font-mono text-sm break-all text-foreground line-through decoration-muted-foreground/40">
							{issue.sourceKey}
						</code>
					</div>
					<span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
						{issue.usageCount.toLocaleString()} spans · 24h
					</span>
				</div>
				{issue.canonicalKey ? (
					<div className="flex items-start gap-3 border-t border-border/60 px-4 py-3">
						<CircleCheckIcon size={16} className="mt-0.5 shrink-0 text-success" />
						<div className="min-w-0 flex-1">
							<p className="text-xs text-muted-foreground">{labels.to}</p>
							<code className="font-mono text-sm break-all text-foreground">
								{issue.canonicalKey}
							</code>
						</div>
					</div>
				) : null}
			</div>
			{note ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
		</section>
	)
}

/** Orange "Please note" caution, mirroring the reference layout. */
function CautionCallout({ issue, isApplyable }: { issue: RecommendationIssue; isApplyable: boolean }) {
	const text =
		isApplyable && issue.canonicalKey ? (
			<>
				Applying creates an ingest mapping that copies <code className={MONO}>{issue.sourceKey}</code>{" "}
				→ <code className={MONO}>{issue.canonicalKey}</code> on newly ingested spans. Existing spans
				aren't rewritten, and the mapping never overwrites a target that already exists.
			</>
		) : (
			<>
				Maple can't resolve this with an ingest mapping. The fix is to rename the attribute at your
				SDK / instrumentation so spans emit the conforming key.
			</>
		)
	return (
		<div className="rounded-r-md border-l-2 border-warning bg-warning/8 px-4 py-3">
			<p className="text-sm leading-relaxed text-foreground/90">
				<span className="font-medium text-warning-foreground">Please note:</span> {text}
			</p>
		</div>
	)
}

/** The exact ingest mapping Apply creates — the analog of the reference page's SQL block. */
function MappingBlock({ issue, isLive }: { issue: RecommendationIssue; isLive: boolean }) {
	const { copied, copy } = useCopyToClipboard("Mapping")
	const snippet = `WHEN span attribute \`${issue.sourceKey}\` is present\nCOPY → \`${issue.canonicalKey}\``

	const onCopy = () => copy(snippet)

	return (
		<section>
			<SectionHeader label={isLive ? "Active ingest mapping" : "What Apply does"} />
			<div className="overflow-hidden rounded-md border bg-muted/40">
				<div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
					<span className="text-xs text-muted-foreground">
						{isLive ? "This mapping is live" : "Ingest attribute mapping"}
					</span>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onCopy}
						aria-label="Copy mapping"
						title="Copy"
					>
						{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
					</Button>
				</div>
				<div className="space-y-1.5 px-4 py-3 font-mono text-[13px] leading-relaxed">
					<div className="flex items-baseline gap-3">
						<span className="w-12 shrink-0 text-muted-foreground">when</span>
						<span className="break-all">
							span attribute <span className="text-foreground">{issue.sourceKey}</span> is
							present
						</span>
					</div>
					<div className="flex items-baseline gap-3">
						<span className="w-12 shrink-0 text-muted-foreground">copy</span>
						<span className="break-all">
							<span className="text-muted-foreground">→</span>{" "}
							<span className="text-success">{issue.canonicalKey}</span>
						</span>
					</div>
				</div>
			</div>
		</section>
	)
}

function SdkFixBlock({ issue }: { issue: RecommendationIssue }) {
	return (
		<section>
			<SectionHeader label="How to fix" />
			<div className="rounded-md border bg-muted/40 px-4 py-3">
				<p className="text-sm leading-relaxed text-muted-foreground">
					Rename <code className={MONO}>{issue.sourceKey}</code>
					{issue.canonicalKey ? (
						<>
							{" "}
							to <code className={MONO}>{issue.canonicalKey}</code>
						</>
					) : (
						<> to a lowercase, dotted semantic-convention key</>
					)}{" "}
					where your spans are created (the instrumentation / SDK). Once the conforming key appears
					on incoming spans, this recommendation resolves automatically.
				</p>
			</div>
		</section>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Right sidebar
 * -------------------------------------------------------------------------------------------------*/

function DetailSidebar({
	issue,
	busy,
	isApplyable,
	isLive,
	onApply,
	onDismiss,
	onReopen,
}: {
	issue: RecommendationIssue
	busy: BusyAction
	isApplyable: boolean
	isLive: boolean
	onApply: () => void
	onDismiss: () => void
	onReopen: () => void
}) {
	const kindBadge = KIND_BADGE[issue.kind]
	const mode = issue.kind === "rename" ? MODE.auto : MODE.manual
	const ModeIcon = mode.icon
	const status = STATUS_BADGE[issue.status]

	return (
		<div className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l bg-card/30">
			<SidebarGroup label="Details">
				<Row label="Status">
					<Badge variant={status.variant}>{status.label}</Badge>
				</Row>
				<Row label="Type">
					<Badge variant={kindBadge.variant}>{kindBadge.label}</Badge>
				</Row>
				<Row label="Fix">
					<Badge variant="outline" className={cn("gap-1", mode.className)} title={mode.title}>
						<ModeIcon size={11} />
						{mode.label}
					</Badge>
				</Row>
				<Row label="Spans">
					<span className="tabular-nums text-foreground">{issue.usageCount.toLocaleString()}</span>
				</Row>
				<Row label="Opened" title={new Date(issue.openedAt).toLocaleString()}>
					<span className="tabular-nums text-muted-foreground">
						{formatRelativeTime(issue.openedAt)}
					</span>
				</Row>
				<Row label="Key" title={issue.sourceKey}>
					<code className="truncate font-mono text-xs text-muted-foreground">
						{issue.sourceKey}
					</code>
				</Row>
			</SidebarGroup>

			<SidebarGroup label="How this resolves">
				<ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
					{[
						"the deprecated key stops appearing on your spans",
						"an ingest mapping covers the key",
						"you apply the rename",
					].map((line) => (
						<li key={line} className="flex gap-2">
							<span aria-hidden className="select-none text-muted-foreground/50">
								·
							</span>
							<span>{line}</span>
						</li>
					))}
				</ul>
			</SidebarGroup>

			<SidebarGroup label="Action">
				{isLive ? (
					<div className="flex flex-col gap-3">
						<p className="flex items-center gap-2 text-sm text-success">
							<CircleCheckIcon size={15} />
							{issue.status === "resolved" ? "Resolved" : "Mapping is active"}
						</p>
						<Button
							variant="outline"
							size="sm"
							className="w-full"
							render={<Link to="/settings" search={{ tab: "ingestion" }} />}
						>
							Manage mappings
						</Button>
					</div>
				) : issue.status === "dismissed" ? (
					<div className="flex flex-col gap-2">
						<Button
							variant="outline"
							size="sm"
							className="w-full"
							onClick={onReopen}
							loading={busy === "reopen"}
						>
							<ArrowRotateAnticlockwiseIcon size={15} />
							Reopen recommendation
						</Button>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Dismissed recommendations come back if the key is still emitted.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{isApplyable ? (
							<Button className="w-full" onClick={onApply} loading={busy === "apply"}>
								<BoltIcon size={15} />
								Apply mapping
							</Button>
						) : (
							<p className="text-xs leading-relaxed text-muted-foreground">
								This one is a manual fix — rename the attribute at your SDK. Maple can't apply
								it for you.
							</p>
						)}
						<Button className="w-full" onClick={onDismiss} loading={busy === "dismiss"}>
							<XmarkIcon size={15} />
							Dismiss recommendation
						</Button>
					</div>
				)}
			</SidebarGroup>
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Shells (loading / error / inactive)
 * -------------------------------------------------------------------------------------------------*/

function ShellLayout({ children }: { children: React.ReactNode }) {
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Ingestion", href: INGESTION_HREF }, { label: "Recommendation" }]}
			title="Recommendation"
		>
			{children}
		</DashboardLayout>
	)
}

function LoadingShell() {
	return (
		<ShellLayout>
			<div className="max-w-3xl space-y-6">
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-24 w-full" />
			</div>
		</ShellLayout>
	)
}

function ErrorShell({ message }: { message: string }) {
	return (
		<ShellLayout>
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CircleXmarkIcon className="text-destructive" />
					</EmptyMedia>
					<EmptyTitle>Couldn't load recommendation</EmptyTitle>
					<EmptyDescription>{message}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</ShellLayout>
	)
}

function InactiveShell() {
	return (
		<ShellLayout>
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<PulseIcon className="text-muted-foreground" />
					</EmptyMedia>
					<EmptyTitle>Recommendation not found</EmptyTitle>
					<EmptyDescription>
						This recommendation isn't in your list anymore — it may have resolved on its own.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						variant="outline"
						size="sm"
						render={<Link to="/settings" search={{ tab: "ingestion" }} />}
					>
						Back to recommendations
					</Button>
				</EmptyContent>
			</Empty>
		</ShellLayout>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Small shared pieces
 * -------------------------------------------------------------------------------------------------*/

function SectionHeader({ label }: { label: string }) {
	return (
		<h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
			{label}
		</h2>
	)
}

function SidebarGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2 border-b border-border/40 p-4 last:border-b-0">
			<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
	return (
		<div title={title} className="grid min-h-8 grid-cols-[64px_1fr] items-center gap-x-3 py-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}
