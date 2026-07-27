import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomSet } from "@/lib/effect-atom"
import { Exit, Schema } from "effect"

import {
	decodeAlertContextFromSearchParam,
	toAlertContext,
	type AlertContext,
} from "@/components/chat/alert-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { ErrorIssueId } from "@maple/domain/http"

const SearchSchema = Schema.Struct({
	/** Base64url alert context carried by the "Ask Maple AI" notification link. */
	alert: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/incidents/$incidentId")({
	component: AlertIncidentPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

function AlertIncidentPage() {
	const { incidentId } = Route.useParams()
	const { alert: alertParam } = Route.useSearch()

	// The notification link carries the alert context inline, so the page can
	// render instantly without waiting on a fetch.
	const paramContext = useMemo(
		() => (alertParam ? decodeAlertContextFromSearchParam(alertParam) : undefined),
		[alertParam],
	)

	const { result: incidentsResult } = useAlertIncidentsList()
	const { result: rulesResult } = useAlertRulesList()

	const incidents = Result.builder(incidentsResult)
		.onSuccess((r) => r.incidents)
		.orElse(() => [])
	const rules = Result.builder(rulesResult)
		.onSuccess((r) => r.rules)
		.orElse(() => [])

	const incident = incidents.find((i) => i.id === incidentId) ?? null
	const rule = incident
		? (rules.find((r) => r.id === incident.ruleId) ?? null)
		: paramContext
			? (rules.find((r) => r.id === paramContext.ruleId) ?? null)
			: null

	const loading = Result.isInitial(incidentsResult) || Result.isInitial(rulesResult)

	// Prefer the authoritative fetched rows; fall back to the link's inline context
	// (e.g. a stale link to a since-pruned incident still opens the report).
	const alertContext: AlertContext | null =
		incident && rule ? toAlertContext(rule, incident) : (paramContext ?? null)
	const issueId: ErrorIssueId | undefined = incident?.errorIssueId ?? undefined

	if (loading && !alertContext) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "…" }]}
				title="Investigation"
			>
				<div className="mx-auto w-full max-w-3xl space-y-4">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-8 w-3/4" />
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-2/3" />
				</div>
			</DashboardLayout>
		)
	}

	if (!alertContext) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Not found" }]}
				title="Investigation"
			>
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Incident not found</EmptyTitle>
						<EmptyDescription>
							It may have been resolved and pruned, or the link is stale.
						</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" render={<Link to="/alerts" />}>
						Back to alerts
					</Button>
				</Empty>
			</DashboardLayout>
		)
	}

	return (
		<AlertInvestigationRedirect alertContext={alertContext} incidentId={incidentId} issueId={issueId} />
	)
}

function AlertInvestigationRedirect({
	alertContext,
	incidentId,
	issueId,
}: {
	alertContext: AlertContext
	incidentId: string
	issueId?: ErrorIssueId
}) {
	const navigate = useNavigate()
	const create = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})
	const [failed, setFailed] = useState(false)
	const openInvestigation = () => {
		setFailed(false)
		void create({
			payload: {
				subject: {
					type: "incident",
					incident_kind: "alert",
					incident_id: incidentId,
					...(issueId ? { issue_id: issueId } : {}),
				} as never,
				snapshot: {
					title: alertContext.ruleName,
					scope: alertContext.groupKey,
					status: alertContext.eventType === "resolve" ? "resolved" : "open",
					severity: alertContext.severity === "critical" ? "critical" : "medium",
					facts: [
						{ label: "Signal", value: alertContext.signalType },
						{ label: "Observed", value: String(alertContext.value ?? "no data") },
					],
					references: issueId ? [{ label: "Issue", url: `/errors/issues/${issueId}` }] : [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				},
			},
			reactivityKeys: ["investigations"],
		}).then((result) => {
			if (Exit.isSuccess(result)) {
				void navigate({
					to: "/investigations/$id",
					params: { id: result.value.id },
					replace: true,
				})
			} else {
				setFailed(true)
			}
		})
	}
	useMountEffect(openInvestigation)
	if (failed) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Investigation" }]}
				title="Could not open investigation"
			>
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Investigation start failed</EmptyTitle>
						<EmptyDescription>
							The investigation could not be created. You can safely retry.
						</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" onClick={openInvestigation}>
						Try again
					</Button>
				</Empty>
			</DashboardLayout>
		)
	}
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Investigation" }]}
			title="Opening investigation…"
		>
			<div className="mx-auto w-full max-w-3xl space-y-4">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-40 w-full" />
			</div>
		</DashboardLayout>
	)
}
