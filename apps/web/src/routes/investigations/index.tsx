import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueSeverity } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { toast } from "sonner"

import { ErrorState } from "@/components/common/error-state"
import { SeverityBadge } from "@/components/errors/severity-badge"
import {
	InvestigationStatusBadge,
	investigationKindLabel,
	investigationOriginLabel,
} from "@/components/investigations/investigation-status"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { formatRelativeTime } from "@maple/ui/time-format"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

type HubView = "active" | "history"

export const Route = createFileRoute("/investigations/")({
	component: InvestigationsHub,
})

const PAGE_SIZE = 100

const asIssueSeverity = (value: string | null | undefined): IssueSeverity | null =>
	value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null

function InvestigationsHub() {
	const navigate = useNavigate()
	const [view, setView] = useState<HubView>("active")
	const [subject, setSubject] = useState("")
	const [creating, setCreating] = useState(false)
	const query = MapleApiV2AtomClient.query("investigations", "list", {
		query: { limit: PAGE_SIZE },
		reactivityKeys: ["investigations"],
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const create = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

	// The list endpoint filters by a single status, but each tab spans two, so the
	// split happens here. That makes the counts page-local — see `hasMore`.
	const investigations = useMemo(
		() =>
			Result.builder(result)
				.onSuccess((response) =>
					response.data.filter((investigation) =>
						view === "active"
							? investigation.status === "investigating" || investigation.status === "diagnosed"
							: investigation.status === "resolved" || investigation.status === "failed",
					),
				)
				.orElse(() => []),
		[result, view],
	)
	const hasMore = Result.builder(result)
		.onSuccess((response) => response.has_more)
		.orElse(() => false)

	const handleCreate = async () => {
		const title = subject.trim()
		if (!title) return
		setCreating(true)
		const created = await create({
			payload: {
				subject: { type: "freeform", title, prompt: title, context_refs: [] },
				snapshot: {
					title,
					scope: null,
					status: "open",
					severity: null,
					facts: [],
					references: [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				},
			},
			reactivityKeys: ["investigations"],
		})
		setCreating(false)
		if (Exit.isSuccess(created)) {
			setSubject("")
			void navigate({ to: "/investigations/$id", params: { id: created.value.id } })
		} else {
			toast.error("Investigation could not be started")
		}
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Investigations" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Investigations"
							description="Maple investigates an incident, records what it found, and keeps the thread open for follow-ups."
						/>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="space-y-6">
							<Card className="gap-3 p-4">
								<div className="space-y-1">
									<h2 className="text-sm font-medium text-foreground">
										Start an investigation
									</h2>
									<p className="text-xs text-muted-foreground">
										Name a service, a symptom, or a question. Maple gathers the evidence
										and reports back.
									</p>
								</div>
								<form
									className="flex flex-col gap-2 sm:flex-row"
									onSubmit={(event) => {
										event.preventDefault()
										void handleCreate()
									}}
								>
									<Input
										value={subject}
										onChange={(event) => setSubject(event.target.value)}
										placeholder="Why is checkout p95 latency climbing?"
										aria-label="What should Maple investigate?"
										className="sm:flex-1"
									/>
									<Button type="submit" disabled={creating || !subject.trim()}>
										{creating ? "Starting…" : "Investigate"}
									</Button>
								</form>
							</Card>

							<div className="space-y-3">
								<div className="flex items-center justify-between border-b">
									<Tabs value={view} onValueChange={(value) => setView(value as HubView)}>
										<TabsList variant="underline">
											<TabsTrigger value="active">Active</TabsTrigger>
											<TabsTrigger value="history">History</TabsTrigger>
										</TabsList>
									</Tabs>
									{investigations.length > 0 && (
										<span className="pb-2 text-xs tabular-nums text-muted-foreground">
											{/* Honest about the page: with more rows on the server, this
											    is what's shown, not a total. */}
											{hasMore
												? `Showing ${investigations.length} of the ${PAGE_SIZE} most recent`
												: `${investigations.length} shown`}
										</span>
									)}
								</div>

								{Result.builder(result)
									.onInitial(() => <InvestigationTableSkeleton />)
									.onError((error) => (
										<ErrorState
											error={error}
											title="Investigations could not be loaded"
											onRetry={refresh}
										/>
									))
									.onSuccess(() =>
										investigations.length === 0 ? (
											<HubEmptyState view={view} />
										) : (
											<InvestigationTable investigations={investigations} />
										),
									)
									.render()}
							</div>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function HubEmptyState({ view }: { view: HubView }) {
	return (
		<Empty>
			<EmptyHeader>
				<EmptyTitle>
					{view === "active" ? "Nothing under investigation" : "No finished investigations yet"}
				</EmptyTitle>
				<EmptyDescription>
					{view === "active"
						? "Start one above, or open an issue and choose Start investigation. Maple also opens one automatically when an incident fires."
						: "Investigations you resolve — and any that fail — stay here for reference."}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	)
}

function InvestigationTable({ investigations }: { investigations: ReadonlyArray<V2Investigation> }) {
	return (
		<div className="overflow-x-auto rounded-xl border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Subject</TableHead>
						<TableHead>Kind</TableHead>
						<TableHead>Severity</TableHead>
						<TableHead>Confidence</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Origin</TableHead>
						<TableHead className="text-right">Updated</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{investigations.map((investigation) => (
						<TableRow key={investigation.id}>
							<TableCell className="max-w-[32rem]">
								<Link
									to="/investigations/$id"
									params={{ id: investigation.id }}
									className="block truncate font-medium text-foreground hover:underline"
								>
									{investigation.snapshot.title}
								</Link>
								{investigation.snapshot.scope ? (
									<p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
										{investigation.snapshot.scope}
									</p>
								) : null}
							</TableCell>
							<TableCell>{investigationKindLabel(investigation.subject)}</TableCell>
							<TableCell>
								<SeverityBadge
									severity={asIssueSeverity(
										investigation.severity ?? investigation.snapshot.severity,
									)}
								/>
							</TableCell>
							<TableCell className="capitalize text-muted-foreground">
								{investigation.confidence ?? "—"}
							</TableCell>
							<TableCell>
								<InvestigationStatusBadge status={investigation.status} />
							</TableCell>
							<TableCell className="text-muted-foreground">
								{investigationOriginLabel(investigation.seeded_by)}
							</TableCell>
							<TableCell className="text-right text-xs text-muted-foreground">
								{formatRelativeTime(investigation.updated_at)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}

function InvestigationTableSkeleton() {
	return (
		<div className="divide-y rounded-xl border" aria-label="Loading investigations">
			{Array.from({ length: 5 }, (_, index) => (
				<div key={index} className="h-14 animate-pulse bg-muted/20" />
			))}
		</div>
	)
}
