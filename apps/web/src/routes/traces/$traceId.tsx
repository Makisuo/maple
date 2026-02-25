import { createFileRoute, useNavigate, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Schema } from "effect"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TraceViewTabs } from "@/components/traces/trace-view-tabs"
import { SpanDetailPanel } from "@/components/traces/span-detail-panel"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@maple/ui/components/ui/resizable"
import { formatDuration } from "@/lib/format"
import { type Span, type SpanNode } from "@/api/tinybird/traces"
import { getSpanHierarchyResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { findSpanById } from "@/components/traces/flow-utils"

const TraceDetailSearchSchema = Schema.Struct({
  spanId: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/traces/$traceId")({
  component: TraceDetailPage,
  validateSearch: Schema.standardSchemaV1(TraceDetailSearchSchema),
})

function TraceDetailPage() {
  const { traceId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const result = useAtomValue(getSpanHierarchyResultAtom({ data: { traceId } }))

  return Result.builder(result)
    .onInitial(() => (
      <DashboardLayout
        breadcrumbs={[
          { label: "Traces", href: "/traces" },
          { label: "Loading..." },
        ]}
        title="Loading trace..."
        description="Loading trace details..."
      >
        <div className="space-y-4">
          <div className="flex gap-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="rounded-md border">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 border-b p-3">
                <Skeleton className="h-4 w-4" />
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
        breadcrumbs={[
          { label: "Traces", href: "/traces" },
          { label: "Error" },
        ]}
        title="Error"
        description="Failed to load trace"
      >
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-8">
          <p className="font-medium text-red-600">Failed to load trace details</p>
          <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap">
            {error.message}
          </pre>
        </div>
      </DashboardLayout>
    ))
    .onSuccess((data) => {
      const selectedSpan = search.spanId
        ? findSpanById(data.rootSpans, search.spanId) ?? null
        : null

      const handleSelectSpan = (span: SpanNode) => {
        if (search.spanId === span.spanId) return
        navigate({
          search: (prev: Record<string, unknown>) => ({ ...prev, spanId: span.spanId }),
          replace: true,
        })
      }

      const handleCloseSpanDetails = () => {
        if (!search.spanId) return
        navigate({
          search: (prev: Record<string, unknown>) => ({ ...prev, spanId: undefined }),
          replace: true,
        })
      }

      if (data.spans.length === 0) {
        return (
          <DashboardLayout
            breadcrumbs={[
              { label: "Traces", href: "/traces" },
              { label: traceId.slice(0, 8) },
            ]}
            title="Trace not found"
            description="This trace could not be found. It may have expired or not been ingested yet."
          >
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
              <p className="text-sm text-muted-foreground">Trace ID</p>
              <Badge
                variant="outline"
                className="mt-1 font-mono text-xs cursor-pointer hover:bg-muted"
                onClick={() => {
                  navigator.clipboard.writeText(traceId)
                  toast.success("Trace ID copied to clipboard")
                }}
              >
                {traceId}
              </Badge>
              <Link
                to="/traces"
                className="mt-6 text-sm text-primary underline underline-offset-4 hover:text-primary/80"
              >
                Back to Traces
              </Link>
            </div>
          </DashboardLayout>
        )
      }

      if (data.rootSpans.length === 0) {
        return (
          <DashboardLayout
            breadcrumbs={[
              { label: "Traces", href: "/traces" },
              { label: traceId.slice(0, 8) },
            ]}
            title="Root span not found"
            description={`Found ${data.spans.length} span${data.spans.length !== 1 ? "s" : ""}, but the root span is missing. The trace may be incomplete.`}
          >
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
              <p className="text-sm text-muted-foreground">Trace ID</p>
              <Badge
                variant="outline"
                className="mt-1 font-mono text-xs cursor-pointer hover:bg-muted"
                onClick={() => {
                  navigator.clipboard.writeText(traceId)
                  toast.success("Trace ID copied to clipboard")
                }}
              >
                {traceId}
              </Badge>
              <p className="mt-4 text-sm text-muted-foreground max-w-md">
                This trace contains spans but the root span was not found.
                It may not have been ingested yet or could have been dropped during sampling.
              </p>
              <Link
                to="/traces"
                className="mt-6 text-sm text-primary underline underline-offset-4 hover:text-primary/80"
              >
                Back to Traces
              </Link>
            </div>
          </DashboardLayout>
        )
      }

      const services = [...new Set(data.spans.map((s: Span) => s.serviceName))]
      const rootSpan = data.rootSpans[0]
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
      const traceStartTime = data.spans.length > 0
        ? data.spans.reduce((earliest, span) =>
            new Date(span.startTime) < new Date(earliest.startTime) ? span : earliest
          ).startTime
        : new Date().toISOString()

      return (
        <DashboardLayout
          breadcrumbs={[
            { label: "Traces", href: "/traces" },
            { label: traceId.slice(0, 8) },
          ]}
          title={rootSpan?.spanName ?? "Unknown Trace"}
          description={`${data.spans.length} spans across ${services.length} service${services.length !== 1 ? "s" : ""}`}
          headerActions={
            <Badge
              variant="outline"
              className="font-mono text-xs cursor-pointer hover:bg-muted"
              onClick={() => {
                navigator.clipboard.writeText(traceId)
                toast.success("Trace ID copied to clipboard")
              }}
            >
              {traceId.slice(0, 8)}...
            </Badge>
          }
        >
          <div className="flex flex-1 flex-col space-y-3 min-h-0">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground">Services:</span>
              {services.map((service: string) => (
                <Badge key={service} variant="outline" className="font-mono text-xs">
                  {service}
                </Badge>
              ))}

              <span className="ml-4 text-xs text-muted-foreground">Duration:</span>
              <Badge variant="secondary" className="font-mono text-xs">
                {formatDuration(data.totalDurationMs)}
              </Badge>

              <span className="ml-4 text-xs text-muted-foreground">Status:</span>
              <Badge
                variant="secondary"
                className={
                  hasError
                    ? "bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400"
                    : "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400"
                }
              >
                {hasError ? "Error" : "OK"}
              </Badge>

              {deploymentEnv && (
                <>
                  <span className="ml-4 text-xs text-muted-foreground">Environment:</span>
                  <Badge
                    variant="secondary"
                    className={
                      deploymentEnv === "production"
                        ? "bg-orange-500/10 text-orange-600 dark:bg-orange-400/10 dark:text-orange-400"
                        : "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400"
                    }
                  >
                    {deploymentEnv}
                  </Badge>
                </>
              )}

              {commitSha && (
                <>
                  <span className="ml-4 text-xs text-muted-foreground">Commit:</span>
                  <Badge variant="outline" className="font-mono text-xs">
                    {commitSha.slice(0, 7)}
                  </Badge>
                </>
              )}
            </div>

            <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 rounded-md border overflow-hidden">
              <ResizablePanel defaultSize={selectedSpan ? 60 : 100} minSize={40}>
                <TraceViewTabs
                  rootSpans={data.rootSpans}
                  spans={data.spans}
                  totalDurationMs={data.totalDurationMs}
                  traceStartTime={traceStartTime}
                  services={services}
                  defaultExpandDepth={Infinity}
                  selectedSpanId={selectedSpan?.spanId}
                  onSelectSpan={handleSelectSpan}
                />
              </ResizablePanel>

              {selectedSpan && (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={40} minSize={25}>
                    <SpanDetailPanel
                      span={selectedSpan}
                      onClose={handleCloseSpanDetails}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </div>
        </DashboardLayout>
      )
    })
    .render()
}
