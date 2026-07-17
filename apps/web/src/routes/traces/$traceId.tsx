import * as React from "react"
import { useNavigate, useRouterState, createFileRoute } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { TraceId } from "@maple/domain"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { TraceReplayLink } from "@/components/replays/trace-replay-link"
import { QueryErrorState } from "@/components/common/query-error-state"
import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { SpanDetailPanel } from "@/components/traces/span-detail-panel"
import { TraceAnatomyStrip } from "@/components/traces/trace-anatomy-strip"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@maple/ui/components/ui/resizable"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import { useIsMobile } from "@maple/ui/hooks/use-media-query"
import { type Span, type SpanNode, type SpanHierarchyResponse } from "@/api/warehouse/traces"
import { getSpanHierarchyResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { findSpanById } from "@maple/ui/components/traces/flow-utils"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { TraceIdBadge } from "@/components/traces/trace-id-badge"
import { getHttpInfo } from "@maple/ui/lib/http"

const TraceDetailSearchSchema = Schema.Struct({
	spanId: Schema.optional(Schema.String),
	// Optional timestamp (any time inside the trace) carried in from the
	// referring page. Used to narrow the ClickHouse partition scan to a ±1h
	// window — without it the query reads every retained daily partition.
	t: Schema.optional(Schema.String),
})

function buildBackToTracesHref(searchStr: string): string {
	const params = new URLSearchParams(searchStr)
	params.delete("spanId")
	params.delete("t")
	const nextSearch = params.toString()
	return nextSearch ? `/traces?${nextSearch}` : "/traces"
}

export const Route = effectRoute(createFileRoute("/traces/$traceId"), ({ params, search }) => {
	const t = typeof (search as { t?: unknown }).t === "string" ? (search as { t: string }).t : undefined
	return [
		getSpanHierarchyResultAtom({
			data: { traceId: Schema.decodeSync(TraceId)(params.traceId), timestamp: t },
		}),
	]
})({
	component: TraceDetailPage,
	validateSearch: Schema.toStandardSchemaV1(TraceDetailSearchSchema),
})

function TraceDetailPage() {
	const { traceId } = Route.useParams()
	const search = Route.useSearch()
	const searchStr = useRouterState({ select: (state) => state.location.searchStr })
	const backToTracesHref = buildBackToTracesHref(searchStr)
	const result = useAtomValue(
		getSpanHierarchyResultAtom({
			data: { traceId: Schema.decodeSync(TraceId)(traceId), timestamp: search.t },
		}),
	)

	return Result.builder(result)
		.onInitial(() => (
			<DashboardLayout
				breadcrumbs={[{ label: "Traces", href: backToTracesHref }, { label: "Loading..." }]}
				title="Loading trace..."
				description="Loading trace details..."
			>
				<div className="space-y-4">
					<div className="space-y-2">
						<Skeleton className="h-8 w-32" />
						<Skeleton className="h-1.5 w-full rounded-full" />
						<div className="flex gap-4">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-4 w-24" />
						</div>
					</div>
					<div className="rounded-md border">
						{Array.from({ length: 5 }).map((_, i) => (
							<div key={i} className="flex items-center gap-2 border-b p-3">
								<Skeleton className="size-4" />
								<Skeleton className="h-4 w-20" />
								<Skeleton className="h-4 w-16" />
								<Skeleton className="h-4 flex-1" />
								<Skeleton className="h-2 w-32" />
								<Skeleton className="h-4 w-16" />
							</div>
						))}
					</div>
				</div>
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout
				breadcrumbs={[{ label: "Traces", href: backToTracesHref }, { label: "Error" }]}
				title="Error"
				description="Failed to load trace"
			>
				<QueryErrorState error={error} titleOverride="Failed to load trace details" />
			</DashboardLayout>
		))
		.onSuccess((data) => {
			if (data.spans.length === 0) {
				return (
					<DashboardLayout
						breadcrumbs={[
							{ label: "Traces", href: backToTracesHref },
							{ label: traceId.slice(0, 8) },
						]}
						title="Trace not found"
						description="This trace could not be found. It may have expired or not been ingested yet."
					>
						<div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
							<p className="mb-2 text-sm text-muted-foreground">Trace ID</p>
							<TraceIdBadge traceId={traceId} />
							<a
								href={backToTracesHref}
								className="mt-6 text-sm text-primary underline underline-offset-4 hover:text-primary/80"
							>
								Back to Traces
							</a>
						</div>
					</DashboardLayout>
				)
			}

			if (data.rootSpans.length === 0) {
				return (
					<DashboardLayout
						breadcrumbs={[
							{ label: "Traces", href: backToTracesHref },
							{ label: traceId.slice(0, 8) },
						]}
						title="Root span not found"
						description={`Found ${data.spans.length} span${data.spans.length !== 1 ? "s" : ""}, but the root span is missing. The trace may be incomplete.`}
					>
						<div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
							<p className="mb-2 text-sm text-muted-foreground">Trace ID</p>
							<TraceIdBadge traceId={traceId} />
							<p className="mt-4 text-sm text-muted-foreground max-w-md">
								This trace contains spans but the root span was not found. It may not have
								been ingested yet or could have been dropped during sampling.
							</p>
							<a
								href={backToTracesHref}
								className="mt-6 text-sm text-primary underline underline-offset-4 hover:text-primary/80"
							>
								Back to Traces
							</a>
						</div>
					</DashboardLayout>
				)
			}

			return <TraceDetailContent data={data} traceId={traceId} backToTracesHref={backToTracesHref} />
		})
		.render()
}

function TraceDetailContent({
	data,
	traceId,
	backToTracesHref,
}: {
	data: SpanHierarchyResponse
	traceId: string
	backToTracesHref: string
}) {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const selectedSpan = React.useMemo(
		() => (search.spanId ? (findSpanById(data.rootSpans, search.spanId) ?? null) : null),
		[data.rootSpans, search.spanId],
	)

	const handleSelectSpan = React.useCallback(
		(span: SpanNode) => {
			if (search.spanId === span.spanId) return
			navigate({
				search: (prev: Record<string, unknown>) => ({ ...prev, spanId: span.spanId }),
				replace: true,
			})
		},
		[search.spanId, navigate],
	)

	const handleCloseSpanDetails = React.useCallback(() => {
		navigate({
			search: (prev: Record<string, unknown>) => ({ ...prev, spanId: undefined }),
			replace: true,
		})
	}, [navigate])

	// Esc closes the inline span panel; while the nested log sheet is open the
	// dialog guard defers to it, so Esc closes the sheet first.
	useAppHotkey("list.clear", handleCloseSpanDetails, { enabled: selectedSpan !== null })

	const services = React.useMemo(
		() => [...new Set(data.spans.map((s: Span) => s.serviceName))],
		[data.spans],
	)

	const traceStartTime = React.useMemo(
		() =>
			data.spans.length > 0
				? data.spans.reduce((earliest, span) =>
						new Date(span.startTime) < new Date(earliest.startTime) ? span : earliest,
					).startTime
				: new Date().toISOString(),
		[data.spans],
	)

	const isMobile = useIsMobile()

	// Shared by both layouts below so the tabs keep their state across a breakpoint change.
	const traceViewTabs = (
		<TraceViewTabs
			rootSpans={data.rootSpans}
			spans={data.spans}
			totalDurationMs={data.totalDurationMs}
			traceStartTime={traceStartTime}
			services={services}
			selectedSpanId={selectedSpan?.spanId}
			onSelectSpan={handleSelectSpan}
		/>
	)

	const rootSpan = data.rootSpans[0]
	const rootHttpInfo = rootSpan ? getHttpInfo(rootSpan) : null
	const deploymentEnv = rootSpan?.resourceAttributes?.["deployment.environment"]
	const commitSha = rootSpan?.resourceAttributes?.["deployment.commit_sha"]
	const hasError = data.spans.some((s: Span) => {
		if (s.statusCode === "Error") return true
		const httpStatus = s.spanAttributes?.["http.status_code"]
		if (httpStatus) {
			const code = typeof httpStatus === "string" ? parseInt(httpStatus) : httpStatus
			if (typeof code === "number" && code >= 500) return true
		}
		return false
	})

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Traces", href: backToTracesHref }, { label: traceId.slice(0, 8) }]}
			title={rootHttpInfo ? undefined : (rootSpan?.spanName ?? "Unknown Trace")}
			titleContent={
				rootHttpInfo ? (
					<h1 className="min-w-0">
						<HttpSpanLabel
							spanName={rootSpan.spanName}
							spanAttributes={rootSpan.spanAttributes}
							spanKind={rootSpan.spanKind}
							className="gap-3 text-2xl font-bold tracking-tight"
							textClassName="text-2xl font-bold tracking-tight"
						/>
					</h1>
				) : undefined
			}
			headerActions={
				<div className="flex items-center gap-2">
					<TraceReplayLink traceId={traceId} />
				</div>
			}
		>
			<div className="flex flex-1 flex-col gap-y-3 min-h-0 content-enter">
				<TraceAnatomyStrip
					spans={data.spans}
					totalDurationMs={data.totalDurationMs}
					traceId={traceId}
					hasError={hasError}
					httpStatusCode={rootHttpInfo?.statusCode}
					deploymentEnv={deploymentEnv}
					commitSha={commitSha}
				/>

				{isMobile ? (
					// A 60/40 side-by-side split leaves each pane ~150px on a phone. Give the waterfall
					// the full width and float the span detail over it instead.
					<>
						<div className="flex-1 min-h-0 rounded-md border overflow-hidden">
							{traceViewTabs}
						</div>
						<Sheet
							open={selectedSpan != null}
							onOpenChange={(open) => {
								if (!open) handleCloseSpanDetails()
							}}
						>
							<SheetContent side="bottom" className="h-[80svh] p-0" showCloseButton={false}>
								<SheetHeader className="sr-only">
									<SheetTitle>Span details</SheetTitle>
									<SheetDescription>Details for the selected span.</SheetDescription>
								</SheetHeader>
								{selectedSpan && (
									<SpanDetailPanel
										span={selectedSpan}
										onClose={handleCloseSpanDetails}
										traceStartTime={traceStartTime}
										totalDurationMs={data.totalDurationMs}
									/>
								)}
							</SheetContent>
						</Sheet>
					</>
				) : (
					<ResizablePanelGroup
						orientation="horizontal"
						className="flex-1 min-h-0 rounded-md border overflow-hidden"
					>
						<ResizablePanel defaultSize={selectedSpan ? 60 : 100} minSize={40}>
							{traceViewTabs}
						</ResizablePanel>

						{selectedSpan && (
							<>
								<ResizableHandle withHandle />
								<ResizablePanel defaultSize={40} minSize={25}>
									<SpanDetailPanel
										span={selectedSpan}
										onClose={handleCloseSpanDetails}
										traceStartTime={traceStartTime}
										totalDurationMs={data.totalDurationMs}
										className="panel-enter"
									/>
								</ResizablePanel>
							</>
						)}
					</ResizablePanelGroup>
				)}
			</div>
		</DashboardLayout>
	)
}
