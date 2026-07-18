import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Schema } from "effect"

import { toAlertContext } from "@/components/chat/alert-context"
import { decodeInvestigationRef } from "@/components/chat/investigation-context"
import { InvestigationView } from "@/components/investigations/investigation-view"
import { subjectFromAlertContext, subjectFromAnomaly, subjectFromError } from "@/components/investigations/subject"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { AnomalyIncidentId, ErrorIssueId } from "@maple/domain/http"

const SearchSchema = Schema.Struct({
	/** Base64url `{kind, id, issueId?}` — the attached resource that defines the investigation. */
	r: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/investigations/$id")({
	component: InvestigationPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

const decodeAnomalyId = Schema.decodeSync(AnomalyIncidentId)
const decodeErrorIssueId = Schema.decodeSync(ErrorIssueId)

function InvestigationPage() {
	const { id } = Route.useParams()
	const { r } = Route.useSearch()
	const ref = r ? decodeInvestigationRef(r) : undefined

	if (!ref) {
		return (
			<DashboardLayout breadcrumbs={[{ label: "Investigation" }]} title="Investigation">
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Open an investigation from its source</EmptyTitle>
						<EmptyDescription>
							Investigations are launched from an alert, anomaly, or error. Head to one of those and
							choose "Investigate with Maple AI".
						</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" render={<Link to="/errors" />}>
						Go to errors
					</Button>
				</Empty>
			</DashboardLayout>
		)
	}

	if (ref.kind === "anomaly") return <AnomalyInvestigation id={id} />
	if (ref.kind === "error") return <ErrorInvestigation id={ref.issueId ?? id} />
	return <AlertInvestigation incidentId={id} />
}

function LoadingShell() {
	return (
		<DashboardLayout breadcrumbs={[{ label: "Investigation" }]} title="Investigation">
			<div className="mx-auto w-full max-w-3xl space-y-4">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-2/3" />
			</div>
		</DashboardLayout>
	)
}

function NotFoundShell({ message }: { message: string }) {
	return (
		<DashboardLayout breadcrumbs={[{ label: "Investigation" }]} title="Investigation">
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Nothing to investigate</EmptyTitle>
					<EmptyDescription>{message}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</DashboardLayout>
	)
}

function AnomalyInvestigation({ id }: { id: string }) {
	const incidentId = decodeAnomalyId(id)
	const result = useAtomValue(
		MapleApiAtomClient.query("anomalies", "getIncident", {
			params: { incidentId },
			reactivityKeys: ["anomalyIncidents", `anomalyIncident:${incidentId}`],
		}),
	)
	return Result.builder(result)
		.onInitial(() => <LoadingShell />)
		.onError(() => <NotFoundShell message="This anomaly may have been pruned, or the link is stale." />)
		.onSuccess((incident) => <InvestigationView subject={subjectFromAnomaly(incident)} />)
		.render()
}

function ErrorInvestigation({ id }: { id: string }) {
	const issueId = decodeErrorIssueId(id)
	const result = useAtomValue(
		MapleApiAtomClient.query("errors", "getIssue", {
			params: { issueId },
			query: {},
			reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
		}),
	)
	return Result.builder(result)
		.onInitial(() => <LoadingShell />)
		.onError(() => <NotFoundShell message="This error issue could not be loaded." />)
		.onSuccess((detail) => {
			const totalInWindow = detail.timeseries.reduce((sum, b) => sum + b.count, 0)
			const latestIncidentId =
				(detail.incidents.find((i) => i.status === "open") ?? detail.incidents[0])?.id ?? null
			return (
				<InvestigationView subject={subjectFromError(detail.issue, { totalInWindow, latestIncidentId })} />
			)
		})
		.render()
}

function AlertInvestigation({ incidentId }: { incidentId: string }) {
	const { result: incidentsResult } = useAlertIncidentsList()
	const { result: rulesResult } = useAlertRulesList()

	if (Result.isInitial(incidentsResult) || Result.isInitial(rulesResult)) return <LoadingShell />

	const incidents = Result.builder(incidentsResult)
		.onSuccess((r) => r.incidents)
		.orElse(() => [])
	const rules = Result.builder(rulesResult)
		.onSuccess((r) => r.rules)
		.orElse(() => [])

	const incident = incidents.find((i) => i.id === incidentId) ?? null
	const rule = incident ? (rules.find((r) => r.id === incident.ruleId) ?? null) : null
	if (!incident || !rule) {
		return <NotFoundShell message="This alert incident may have been resolved and pruned." />
	}

	const subject = subjectFromAlertContext(toAlertContext(rule, incident), {
		...(incident.errorIssueId ? { issueId: incident.errorIssueId } : {}),
	})
	return <InvestigationView subject={subject} />
}
