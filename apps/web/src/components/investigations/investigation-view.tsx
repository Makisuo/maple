import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { useAtomSet } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import { toastManager } from "@maple/ui/components/ui/toast"

import { ChatConversation } from "@/components/chat/chat-conversation"
import type { InvestigationContext } from "@/components/chat/investigation-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { EvidenceTab } from "./evidence-tab"
import { ProvenanceCanvas } from "./flow/provenance-canvas"
import { FollowUpComposer } from "./follow-up-composer"
import { HypothesesTab } from "./hypotheses-tab"
import { ImpactStrip } from "./impact-strip"
import { investigationHeadline } from "./investigation-display"
import { InvestigationHeader } from "./investigation-header"
import { InvestigationMeta } from "./investigation-meta"
import { type InvestigationTab, InvestigationTabs } from "./investigation-tabs"
import { SignalsCard } from "./signals-card"
import { VerdictCard } from "./verdict-card"

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

/**
 * Read a snapshot fact by label. The snapshot is the only place the signal type
 * survives — it isn't a column on the investigation — and both writers emit it
 * under a "Signal" label (the alert route client-side, `snapshotFor` in the API),
 * so matching on the label recovers it for either origin.
 */
const factValue = (facts: V2Investigation["snapshot"]["facts"], label: string): string | undefined =>
	facts.find((fact) => fact.label.toLowerCase() === label)?.value

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
 * One investigation, as a finding rather than a conversation.
 *
 * The transcript used to *be* this page — the diagnosis was a card buried in a
 * scrolling chat, and everything that qualified it lived in the rail. Now the
 * verdict, its impact and what to do about it are the page; the conversation is
 * one tab among five, and the rail leads with the checks that back the verdict.
 *
 * The follow-up composer is docked on every document tab, because the question a
 * person wants to ask arrives while they're reading the evidence, not after
 * they've navigated away from it.
 */
export function InvestigationView({
	investigation,
	tab,
	onRefresh,
}: {
	investigation: V2Investigation
	tab: InvestigationTab
	onRefresh: () => void
}) {
	const navigate = useNavigate()
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
			toastManager.add({
				title: isResolved ? "Investigation reopened" : "Investigation restarted",
				type: "success",
			})
			onRefresh()
		} else {
			toastManager.add({ title: "Investigation could not be restarted", type: "error" })
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
			toastManager.add({ title: "Investigation resolved", type: "success" })
			onRefresh()
		} else {
			toastManager.add({ title: "Investigation could not be resolved", type: "error" })
		}
	}

	/**
	 * The docked composer doesn't own a chat session. Lifting `useMapleChat` out
	 * of `ChatConversation` to share one would mean rebuilding approvals, failed
	 * sends and history loading around it — so the question is handed to the Chat
	 * tab, which is where the answer belongs anyway.
	 */
	const handleFollowUp = () => {
		void navigate({
			to: "/investigations/$id",
			params: { id: investigation.id },
			search: { tab: "chat" },
		})
	}

	// Chat and Transcript own their own scrolling and fill the viewport; the
	// document tabs scroll as a page. `Fill` vs `Scroll` is exactly that
	// difference — nesting a self-scrolling transcript inside a scrolling page is
	// what used to need a `calc(100dvh - 12rem)` guess.
	const isConversation = tab === "chat" || tab === "transcript"

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Investigations", href: "/investigations" },
					{ label: breadcrumbLabel(investigationHeadline(investigation)) },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<InvestigationHeader
							investigation={investigation}
							busy={busy}
							onResolve={handleResolve}
							onRestart={handleRestart}
						/>
						<InvestigationTabs investigation={investigation} active={tab} />
					</DashboardLayout.Sticky>
					{isConversation ? (
						<DashboardLayout.Fill>
							<ChatConversation
								tabId={`inv-${investigation.id}`}
								isActive={tab === "chat"}
								mode="investigation"
								investigationContext={context}
								subjectSeededByServer
								showAttachmentCard={false}
								readOnly={
									tab === "transcript" ? "transcript" : isResolved ? "resolved" : false
								}
								fallbackDiagnosis={investigation.report}
							/>
						</DashboardLayout.Fill>
					) : (
						<>
							<DashboardLayout.Scroll>
								<div className="flex flex-col gap-7">
									{tab === "evidence" ? (
										<EvidenceTab investigation={investigation} />
									) : tab === "hypotheses" ? (
										<HypothesesTab investigation={investigation} />
									) : (
										<>
											{/*
											 * The canvas leads. It carries what the rail's run
											 * spine, its checks panel and the Next-actions ledger
											 * used to say separately — one causal read instead of
											 * three partial ones — so the verdict below it
											 * qualifies a chain the reader has already seen.
											 */}
											<ProvenanceCanvas investigation={investigation} />
											<VerdictCard investigation={investigation} />
											<ImpactStrip investigation={investigation} />
											<SignalsCard investigation={investigation} />
										</>
									)}
									{/*
									 * The audit trail, under the finding rather than beside it.
									 * This is what was left of the right rail once the canvas took
									 * over the run and the checks — not enough to keep a 320px
									 * column standing next to a graph that wanted the width.
									 */}
									<InvestigationMeta investigation={investigation} />
								</div>
							</DashboardLayout.Scroll>
							{/*
							 * A sibling of `Scroll`, not its last child. Inside it, `mt-auto` only
							 * reached the bottom while the tab was shorter than the viewport — on
							 * any real diagnosis the composer sat below the fold and scrolled away,
							 * which is the opposite of docked. `Content` is a flex column, so a
							 * `shrink-0` footer here is the same shape as the sticky header above.
							 */}
							{isResolved ? null : (
								<div className="shrink-0 px-4 pb-4">
									<FollowUpComposer onSubmit={handleFollowUp} />
								</div>
							)}
						</>
					)}
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
