import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import {
	decodeAlertContextFromSearchParam,
	toAlertContext,
	type AlertContext,
} from "@/components/chat/alert-context"
import { InvestigationView } from "@/components/investigations/investigation-view"
import { subjectFromAlertContext } from "@/components/investigations/subject"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { ErrorIssueId } from "@maple/domain/http"

const SearchSchema = Schema.Struct({
	/** Base64url alert context carried by the "Ask Maple AI" notification link. */
	alert: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/incidents/$incidentId"))({
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
						<EmptyDescription>It may have been resolved and pruned, or the link is stale.</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" render={<Link to="/alerts" />}>
						Back to alerts
					</Button>
				</Empty>
			</DashboardLayout>
		)
	}

	const subject = subjectFromAlertContext(alertContext, issueId ? { issueId } : undefined)
	return <InvestigationView subject={subject} />
}
