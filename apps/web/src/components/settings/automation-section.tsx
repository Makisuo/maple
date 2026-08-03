import { useState } from "react"
import type { ReactNode } from "react"
import { Exit } from "effect"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	type EscalationConfidence,
	EscalationPolicyEvaluationRequest,
	type IssueSeverity,
} from "@maple/domain/http"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"

import { AiTriageSettingsSection } from "./ai-triage-settings-section"
import { EscalationPolicySection } from "./escalation-policy-section"
import { SectionHeader } from "@/components/layout/section-header"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

const SEVERITIES: ReadonlyArray<IssueSeverity> = ["critical", "high", "medium", "low"]
const CONFIDENCES: ReadonlyArray<EscalationConfidence> = ["high", "medium", "low"]

export function AutomationSection({
	isAdmin,
	hasEntitlement,
}: {
	isAdmin: boolean
	hasEntitlement: boolean
}) {
	return (
		<div className="max-w-5xl space-y-10">
			<section aria-labelledby="automatic-investigations-heading">
				<SectionHeader id="automatic-investigations-heading" label="Automatic investigations" />
				<AiTriageSettingsSection isAdmin={isAdmin} hasEntitlement={hasEntitlement} />
			</section>
			<section aria-labelledby="routing-heading">
				<SectionHeader id="routing-heading" label="Severity and confidence routing" />
				<p className="mb-4 text-sm text-muted-foreground">
					Confidence gates apply only to AI decisions. A manual severity change is explicit human
					intent and bypasses the confidence threshold.
				</p>
				<EscalationPolicySection isAdmin={isAdmin} />
			</section>
			<PolicySimulator />
			<RecentDeliveries />
		</div>
	)
}

function PolicySimulator() {
	const [severity, setSeverity] = useState<IssueSeverity>("high")
	const [source, setSource] = useState<"ai" | "manual">("ai")
	const [confidence, setConfidence] = useState<EscalationConfidence>("high")
	const [decision, setDecision] = useState<{
		outcome: "route" | "skip"
		destinationIds: ReadonlyArray<string>
		skipReason: string | null
	} | null>(null)
	const [busy, setBusy] = useState(false)
	const evaluate = useAtomSet(MapleApiAtomClient.mutation("errors", "evaluateEscalationPolicy"), {
		mode: "promiseExit",
	})
	const { result: destinationsResult } = useAlertDestinationsList()
	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => response.destinations)
		.orElse(() => [])

	const run = async () => {
		setBusy(true)
		setDecision(null)
		const result = await evaluate({
			payload: new EscalationPolicyEvaluationRequest({
				severity,
				source,
				...(source === "ai" ? { confidence } : {}),
			}),
		})
		setBusy(false)
		if (Exit.isSuccess(result)) {
			setDecision(result.value)
		} else {
			toastManager.add({ title: "Policy evaluation failed", type: "error" })
		}
	}

	return (
		<section aria-labelledby="policy-simulator-heading">
			<SectionHeader id="policy-simulator-heading" label="Policy simulator" />
			<div className="border bg-card/20 p-4">
				<div className="grid gap-4 md:grid-cols-3">
					<SimulatorField label="Severity">
						<select
							value={severity}
							onChange={(event) => setSeverity(event.target.value as IssueSeverity)}
							className="h-8 w-full border bg-background px-2 text-sm"
						>
							{SEVERITIES.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					</SimulatorField>
					<SimulatorField label="Decision source">
						<select
							value={source}
							onChange={(event) => setSource(event.target.value as "ai" | "manual")}
							className="h-8 w-full border bg-background px-2 text-sm"
						>
							<option value="ai">AI diagnosis</option>
							<option value="manual">Manual change</option>
						</select>
					</SimulatorField>
					<SimulatorField label="AI confidence">
						<select
							value={confidence}
							onChange={(event) => setConfidence(event.target.value as EscalationConfidence)}
							disabled={source === "manual"}
							className="h-8 w-full border bg-background px-2 text-sm disabled:opacity-50"
						>
							{CONFIDENCES.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					</SimulatorField>
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
					<Button size="sm" onClick={() => void run()} disabled={busy}>
						{busy ? "Evaluating…" : "Evaluate policy"}
					</Button>
					{decision ? (
						<>
							<Badge variant="outline" className="capitalize">
								{decision.outcome}
							</Badge>
							<span className="text-sm text-muted-foreground">
								{decision.outcome === "route"
									? decision.destinationIds
											.map(
												(id) =>
													destinations.find((destination) => destination.id === id)
														?.name ?? id,
											)
											.join(", ")
									: decision.skipReason?.replaceAll("_", " ")}
							</span>
						</>
					) : (
						<span className="text-sm text-muted-foreground">
							Preview the exact worker decision without sending a notification.
						</span>
					)}
				</div>
			</div>
		</section>
	)
}

function SimulatorField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="space-y-1.5">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{children}
		</label>
	)
}

function RecentDeliveries() {
	const result = useAtomValue(
		MapleApiAtomClient.query("errors", "listRecentEscalations", {
			query: { limit: 20 },
			reactivityKeys: ["issueEscalations"],
		}),
	)
	return (
		<section aria-labelledby="recent-deliveries-heading">
			<SectionHeader id="recent-deliveries-heading" label="Recent escalation deliveries" />
			{Result.builder(result)
				.onSuccess((response) =>
					response.attempts.length === 0 ? (
						<div className="border px-4 py-8 text-center text-sm text-muted-foreground">
							No escalation attempts have been recorded.
						</div>
					) : (
						<div className="divide-y border">
							{response.attempts.map((attempt) => (
								<div
									key={attempt.id}
									className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[8rem_1fr_auto]"
								>
									<div className="flex items-center gap-2">
										<Badge variant="outline" className="capitalize">
											{attempt.severity}
										</Badge>
										<span className="capitalize text-muted-foreground">
											{attempt.status}
										</span>
									</div>
									<p className="min-w-0 truncate text-muted-foreground">
										{attempt.deliveries.length > 0
											? attempt.deliveries
													.map(
														(delivery) =>
															`${delivery.destinationName ?? delivery.destinationId}: ${delivery.status}`,
													)
													.join(", ")
											: (attempt.skipReason?.replaceAll("_", " ") ??
												"Awaiting delivery")}
									</p>
									<span className="text-xs text-muted-foreground">
										{formatRelativeTime(attempt.createdAt)}
									</span>
								</div>
							))}
						</div>
					),
				)
				.orElse(() => (
					<div className="border px-4 py-8 text-center text-sm text-muted-foreground">
						Recent escalation activity could not be loaded.
					</div>
				))}
		</section>
	)
}
