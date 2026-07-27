import { useMemo, useState } from "react"
import { Exit } from "effect"
import { useAtomSet } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueSeverity } from "@maple/domain/http"
import { toast } from "sonner"

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import type { InvestigationContext } from "@/components/chat/investigation-context"
import { SeverityBadge } from "@/components/errors/severity-badge"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { InvestigationRail } from "./investigation-rail"
import { InvestigationStatusBadge, investigationKindLabel } from "./investigation-status"

const factKey = (label: string) =>
	label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "")

/**
 * An investigation's title is whatever named its subject — for an error that's
 * the exception message, which can be a line of JSON. `BreadcrumbList` wraps by
 * design, so an unclamped title spills the trail out of the fixed `h-16` bar.
 * Clamping loses nothing: the full title is the `<h1>` directly beneath it.
 */
const breadcrumbLabel = (title: string): string => {
	const line = title.split("\n")[0]!.trim()
	return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line
}

/** Only the four canonical severities render as a badge; anything else is unset. */
const asIssueSeverity = (value: string | null | undefined): IssueSeverity | null =>
	value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null

/**
 * Read a snapshot fact by label. The snapshot is the only place the signal type
 * survives — it isn't a column on the investigation — and both writers emit it
 * under a "Signal" label (the alert route client-side, `snapshotFor` in the API),
 * so matching on the label recovers it for either origin.
 */
const factValue = (
	facts: V2Investigation["snapshot"]["facts"],
	label: string,
): string | undefined => facts.find((fact) => fact.label.toLowerCase() === label)?.value

const contextFromInvestigation = (investigation: V2Investigation): InvestigationContext => {
	const subject = investigation.subject
	const kind = subject.type === "freeform" ? "freeform" : subject.incident_kind
	// Without this the signal is always unknown, every alert falls through to
	// `investigationSuggestions`' generic branch, and its per-signal prompts are
	// dead code on the one page that should use them.
	const signalType = factValue(investigation.snapshot.facts, "signal")
	return {
		kind,
		id: subject.type === "freeform" ? investigation.id : subject.incident_id,
		title: investigation.snapshot.title,
		severity: investigation.severity ?? investigation.snapshot.severity ?? "unclassified",
		status: investigation.status,
		...(signalType ? { signalType } : {}),
		...(investigation.snapshot.scope ? { scope: investigation.snapshot.scope } : {}),
		facts: investigation.snapshot.facts.map((fact) => ({
			key: factKey(fact.label),
			label: fact.label,
			value: fact.value,
		})),
		refs:
			subject.type === "incident"
				? {
						incidentId: subject.incident_id,
						...(subject.issue_id ? { issueId: subject.issue_id } : {}),
						...(investigation.snapshot.scope
							? { serviceName: investigation.snapshot.scope }
							: {}),
					}
				: undefined,
		...(investigation.report
			? {
					aiSummary: investigation.report.summary,
					aiSuspectedCause: investigation.report.suspectedCause,
				}
			: {}),
	}
}

/**
 * One investigation, as a workspace rather than a document: the header states the
 * subject, the transcript owns the rest of the viewport and its own scrolling, and
 * the rail carries everything the transcript doesn't — the run's history, what it
 * cost, what it points at, and the actions that change its state. Nothing appears
 * twice.
 */
export function InvestigationView({
	investigation,
	onRefresh,
}: {
	investigation: V2Investigation
	onRefresh: () => void
}) {
	const [busy, setBusy] = useState(false)
	const restart = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "restart"), {
		mode: "promiseExit",
	})
	const updateStatus = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "updateStatus"), {
		mode: "promiseExit",
	})
	const context = useMemo(() => contextFromInvestigation(investigation), [investigation])
	const isResolved = investigation.status === "resolved"

	const reactivityKeys = ["investigations", `investigation:${investigation.id}`]

	const handleRestart = async () => {
		setBusy(true)
		const result = await restart({ params: { id: investigation.id }, reactivityKeys })
		setBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success(isResolved ? "Investigation reopened" : "Investigation restarted")
			onRefresh()
		} else {
			toast.error("Investigation could not be restarted")
		}
	}

	const handleResolve = async () => {
		setBusy(true)
		const result = await updateStatus({
			params: { id: investigation.id },
			payload: { status: "resolved" },
			reactivityKeys,
		})
		setBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success("Investigation resolved")
			onRefresh()
		} else {
			toast.error("Investigation could not be resolved")
		}
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Investigations", href: "/investigations" },
					{ label: breadcrumbLabel(investigation.snapshot.title) },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					{/* No actions here: Resolve/Reopen/Retry live in the rail, beneath the
					    run history they act on. The header states the subject and nothing else. */}
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={<InvestigationHeading investigation={investigation} />}
						/>
					</DashboardLayout.Sticky>
					{/* `Fill`, not `Scroll`: the transcript scrolls itself. Nesting it in a
					    scrolling page is what previously needed a `calc(100dvh - 12rem)`
					    guess that the billing banners could invalidate. */}
					<DashboardLayout.Fill>
						<FlueClientProvider>
							<ChatConversation
								tabId={`inv-${investigation.id}`}
								isActive
								mode="investigation"
								investigationContext={context}
								subjectSeededByServer
								showAttachmentCard={false}
								readOnly={isResolved ? "resolved" : false}
								fallbackDiagnosis={investigation.report}
							/>
						</FlueClientProvider>
					</DashboardLayout.Fill>
				</DashboardLayout.Content>
				<DashboardLayout.RightPanel title="Investigation context" width="w-80">
					<InvestigationRail
						investigation={investigation}
						busy={busy}
						onResolve={handleResolve}
						onRestart={handleRestart}
					/>
				</DashboardLayout.RightPanel>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/**
 * Eyebrow, title, and the snapshot facts as one line of prose-with-values —
 * following the anomaly hero rather than a grid of chips, so the subject reads as
 * a sentence and the numbers still stand out.
 */
function InvestigationHeading({ investigation }: { investigation: V2Investigation }) {
	const { snapshot } = investigation
	const severity = asIssueSeverity(investigation.severity ?? snapshot.severity)

	return (
		<div className="min-w-0 space-y-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				<span>Investigation</span>
				<span aria-hidden>·</span>
				<span>{investigationKindLabel(investigation.subject)}</span>
			</div>
			<DashboardLayout.Title title={snapshot.title}>{snapshot.title}</DashboardLayout.Title>
			<div className="flex flex-wrap items-center gap-2">
				<InvestigationStatusBadge status={investigation.status} />
				{severity ? <SeverityBadge severity={severity} /> : null}
				{/* `scope` is free text and a system-seeded investigation can carry a
				    whole paragraph of it. One line, always — the full string is on the
				    title, and the diagnosis card states the scope properly anyway. */}
				{snapshot.scope ? (
					<span
						title={snapshot.scope}
						className="min-w-0 max-w-[28rem] truncate font-mono text-xs text-muted-foreground"
					>
						{snapshot.scope}
					</span>
				) : null}
			</div>
			{snapshot.facts.length > 0 ? (
				<p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted-foreground">
					{snapshot.facts.map((fact) => (
						<span key={`${fact.label}:${fact.value}`}>
							{fact.label}{" "}
							{/* `inline-block`, or `truncate`'s overflow rules do nothing here. */}
							<span
								title={fact.value}
								className="inline-block max-w-[16rem] truncate align-bottom font-mono font-medium text-foreground"
							>
								{fact.value}
							</span>
						</span>
					))}
				</p>
			) : null}
		</div>
	)
}
