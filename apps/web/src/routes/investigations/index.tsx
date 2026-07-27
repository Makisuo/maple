import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { toast } from "sonner"

import { ErrorState } from "@/components/common/error-state"
import { PulseIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { formatRelativeTime } from "@maple/ui/time-format"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

type HubView = "active" | "history"

export const Route = createFileRoute("/investigations/")({
	component: InvestigationsHub,
})

const statusLabel = (status: V2Investigation["status"]) =>
	status === "investigating" ? "In progress" : status

function InvestigationsHub() {
	const navigate = useNavigate()
	const [view, setView] = useState<HubView>("active")
	const [subject, setSubject] = useState("")
	const [creating, setCreating] = useState(false)
	const query = MapleApiV2AtomClient.query("investigations", "list", {
		query: { limit: 100 },
		reactivityKeys: ["investigations"],
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const create = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

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

	const handleCreate = async () => {
		const title = subject.trim()
		if (!title) return
		setCreating(true)
		const created = await create({
			payload: {
				subject: {
					type: "freeform",
					title,
					prompt: title,
					context_refs: [],
				},
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
			void navigate({
				to: "/investigations/$id",
				params: { id: created.value.id },
			})
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
							description="Durable evidence, diagnoses, approvals, and escalation outcomes."
						/>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="space-y-4">
							<form
								className="flex items-center gap-2 border bg-card/20 p-3"
								onSubmit={(event) => {
									event.preventDefault()
									void handleCreate()
								}}
							>
								<PulseIcon className="size-4 shrink-0 text-muted-foreground" />
								<Input
									value={subject}
									onChange={(event) => setSubject(event.target.value)}
									placeholder="Investigate a service, symptom, or incident…"
									aria-label="New investigation subject"
									className="border-0 bg-transparent shadow-none focus-visible:ring-0"
								/>
								<Button size="sm" type="submit" disabled={creating || !subject.trim()}>
									{creating ? "Starting…" : "New investigation"}
								</Button>
							</form>

							<div className="flex items-center justify-between border-b">
								<Tabs value={view} onValueChange={(value) => setView(value as HubView)}>
									<TabsList variant="underline">
										<TabsTrigger value="active">Active</TabsTrigger>
										<TabsTrigger value="history">History</TabsTrigger>
									</TabsList>
								</Tabs>
								<span className="pb-2 text-xs tabular-nums text-muted-foreground">
									{investigations.length} {view}
								</span>
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
										<div className="border px-4 py-12 text-center">
											<p className="text-sm font-medium text-foreground">
												{view === "active"
													? "No active investigations match this view"
													: "No completed or failed investigations yet"}
											</p>
											<p className="mt-1 text-xs text-muted-foreground">
												{view === "active"
													? "Start one above or open an issue and choose Start investigation."
													: "Resolved and failed investigations will remain available here."}
											</p>
										</div>
									) : (
										<InvestigationTable investigations={investigations} />
									),
								)
								.render()}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function InvestigationTable({ investigations }: { investigations: ReadonlyArray<V2Investigation> }) {
	return (
		<div className="overflow-x-auto border">
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
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										{investigation.snapshot.scope}
									</p>
								) : null}
							</TableCell>
							<TableCell className="capitalize">
								{investigation.subject.type === "freeform"
									? "Freeform"
									: investigation.subject.incident_kind}
							</TableCell>
							<TableCell className="capitalize">
								{investigation.severity ?? investigation.snapshot.severity ?? "—"}
							</TableCell>
							<TableCell className="capitalize">{investigation.confidence ?? "—"}</TableCell>
							<TableCell>
								<Badge variant="outline" className="capitalize">
									{statusLabel(investigation.status)}
								</Badge>
							</TableCell>
							<TableCell className="capitalize">{investigation.seeded_by}</TableCell>
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
		<div className="divide-y border" aria-label="Loading investigations">
			{Array.from({ length: 5 }, (_, index) => (
				<div key={index} className="h-14 animate-pulse bg-muted/20" />
			))}
		</div>
	)
}
