import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ActorChip } from "@/components/errors/actor-chip"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import type { ErrorIssueDocument, WorkflowState } from "@maple/domain/http"

const FILTER_VALUES = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "wontfix",
  "all",
] as const

type FilterValue = (typeof FILTER_VALUES)[number]

const FILTER_LABEL: Record<FilterValue, string> = {
  triage: "Triage",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
  wontfix: "Wontfix",
  all: "All",
}

const GROUP_ORDER: ReadonlyArray<WorkflowState> = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "wontfix",
]

const ISSUES_PAGE_LIMIT = 100

const searchSchema = Schema.Struct({
  workflowState: Schema.optional(
    Schema.Literals([
      "all",
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
      "wontfix",
    ]),
  ),
})

export const Route = effectRoute(createFileRoute("/errors/issues/"))({
  component: IssuesPage,
  validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const WORKFLOW_BADGE: Record<
  WorkflowState,
  { label: string; tone: string }
> = {
  triage: {
    label: "Triage",
    tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  todo: { label: "Todo", tone: "bg-muted text-muted-foreground" },
  in_progress: {
    label: "In progress",
    tone: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  in_review: {
    label: "In review",
    tone: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  },
  done: { label: "Done", tone: "bg-success/10 text-success" },
  cancelled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
  wontfix: { label: "Wontfix", tone: "bg-muted text-muted-foreground" },
}

function WorkflowBadge({ state }: { state: WorkflowState }) {
  const { label, tone } = WORKFLOW_BADGE[state]
  return (
    <Badge variant="outline" className={tone}>
      {label}
    </Badge>
  )
}

function IssuesPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const activeFilter: FilterValue = search.workflowState ?? "triage"

  const issuesQueryAtom = MapleApiAtomClient.query("errors", "listIssues", {
    query:
      activeFilter === "all"
        ? { limit: ISSUES_PAGE_LIMIT }
        : { workflowState: activeFilter, limit: ISSUES_PAGE_LIMIT },
    reactivityKeys: ["errorIssues"],
  })
  const issuesResult = useAtomValue(issuesQueryAtom)

  const filterRow = (
    <div
      role="radiogroup"
      aria-label="Filter by workflow state"
      className="flex flex-wrap items-center gap-2"
    >
      {FILTER_VALUES.map((value) => {
        const isActive = activeFilter === value
        return (
          <Button
            key={value}
            size="sm"
            variant={isActive ? "default" : "outline"}
            role="radio"
            aria-checked={isActive}
            onClick={() =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  workflowState: value === "triage" ? undefined : value,
                }),
              })
            }
          >
            {FILTER_LABEL[value]}
          </Button>
        )
      })}
    </div>
  )

  return Result.builder(issuesResult)
    .onInitial(() => (
      <DashboardLayout
        breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
        title="Issues"
        description="Workflow-tracked errors, grouped by fingerprint."
      >
        <div className="space-y-4">
          {filterRow}
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </DashboardLayout>
    ))
    .onError((error) => (
      <DashboardLayout
        breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
        title="Issues"
        description="Workflow-tracked errors, grouped by fingerprint."
      >
        <div className="space-y-4">
          {filterRow}
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Failed to load issues</EmptyTitle>
              <EmptyDescription>
                {error.message ?? "Try refreshing or check API logs."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </DashboardLayout>
    ))
    .onSuccess((response) => {
      const issues = response.issues
      const isRefreshing = issuesResult.waiting

      const grouped = new Map<WorkflowState, ErrorIssueDocument[]>()
      for (const issue of issues) {
        const bucket = grouped.get(issue.workflowState) ?? []
        bucket.push(issue)
        grouped.set(issue.workflowState, bucket)
      }
      for (const bucket of grouped.values()) {
        bucket.sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority
          return b.lastSeenAt.localeCompare(a.lastSeenAt)
        })
      }

      return (
        <DashboardLayout
          breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
          title="Issues"
          description="Workflow-tracked errors, grouped by fingerprint."
        >
          <div
            className={`space-y-6 ${isRefreshing ? "opacity-60 transition-opacity" : ""}`}
            aria-busy={isRefreshing}
          >
            {filterRow}
            {issues.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No issues</EmptyTitle>
                  <EmptyDescription>
                    {activeFilter === "triage"
                      ? "No issues in triage. Nice."
                      : `No issues in state "${FILTER_LABEL[activeFilter]}".`}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              GROUP_ORDER.filter((state) => (grouped.get(state)?.length ?? 0) > 0).map(
                (state) => {
                  const bucket = grouped.get(state) ?? []
                  return (
                    <section key={state}>
                      <header className="mb-2 flex items-center gap-2">
                        <WorkflowBadge state={state} />
                        <span className="text-sm text-muted-foreground">
                          {bucket.length} issue{bucket.length === 1 ? "" : "s"}
                        </span>
                      </header>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Exception</TableHead>
                            <TableHead>Service</TableHead>
                            <TableHead className="text-right">Events</TableHead>
                            <TableHead>Last seen</TableHead>
                            <TableHead>Assignee</TableHead>
                            <TableHead>Holder</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bucket.map((issue) => (
                            <TableRow key={issue.id}>
                              <TableCell className="max-w-md">
                                <Link
                                  to="/errors/issues/$issueId"
                                  params={{ issueId: issue.id }}
                                  className="font-medium hover:underline"
                                >
                                  {issue.exceptionType || "Unknown error"}
                                </Link>
                                <div className="truncate text-xs text-muted-foreground">
                                  {issue.exceptionMessage}
                                </div>
                                {issue.hasOpenIncident ? (
                                  <Badge
                                    variant="outline"
                                    className="mt-1 bg-destructive/10 text-destructive"
                                  >
                                    incident open
                                  </Badge>
                                ) : null}
                              </TableCell>
                              <TableCell>{issue.serviceName}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {issue.occurrenceCount.toLocaleString()}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {formatRelativeTime(issue.lastSeenAt)}
                              </TableCell>
                              <TableCell>
                                <ActorChip actor={issue.assignedActor} />
                              </TableCell>
                              <TableCell>
                                <ActorChip actor={issue.leaseHolder} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </section>
                  )
                },
              )
            )}
          </div>
        </DashboardLayout>
      )
    })
    .render()
}
