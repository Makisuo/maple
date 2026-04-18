import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
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
import type { ErrorIssueDocument } from "@maple/domain/http"

const StatusValues = ["open", "resolved", "ignored", "archived"] as const
type StatusFilter = (typeof StatusValues)[number] | "all"

const FILTER_VALUES = ["open", "resolved", "ignored", "all"] as const
const FILTER_LABEL: Record<(typeof FILTER_VALUES)[number], string> = {
  open: "Open",
  resolved: "Resolved",
  ignored: "Ignored",
  all: "All",
}

// Cap server-side reads. The list is for triage — pagination comes later.
const ISSUES_PAGE_LIMIT = 50

const searchSchema = Schema.Struct({
  status: Schema.optional(
    Schema.Literals(["all", "open", "resolved", "ignored", "archived"]),
  ),
})

export const Route = effectRoute(createFileRoute("/errors/issues/"))({
  component: IssuesPage,
  validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const STATUS_BADGE: Record<
  ErrorIssueDocument["status"],
  { label: string; tone: string }
> = {
  open: { label: "Open", tone: "bg-destructive/10 text-destructive" },
  resolved: { label: "Resolved", tone: "bg-success/10 text-success" },
  ignored: { label: "Ignored", tone: "bg-muted text-muted-foreground" },
  archived: { label: "Archived", tone: "bg-muted text-muted-foreground" },
}

function IssueStatusBadge({ status }: { status: ErrorIssueDocument["status"] }) {
  const { label, tone } = STATUS_BADGE[status]
  return (
    <Badge variant="outline" className={tone}>
      {label}
    </Badge>
  )
}

function IssuesPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const activeStatus: StatusFilter = search.status ?? "open"

  const issuesQueryAtom = MapleApiAtomClient.query("errors", "listIssues", {
    query:
      activeStatus === "all"
        ? { limit: ISSUES_PAGE_LIMIT }
        : { status: activeStatus, limit: ISSUES_PAGE_LIMIT },
    reactivityKeys: ["errorIssues"],
  })
  const issuesResult = useAtomValue(issuesQueryAtom)

  const filterRow = (
    <div role="radiogroup" aria-label="Filter by status" className="flex items-center gap-2">
      {FILTER_VALUES.map((value) => {
        const isActive = activeStatus === value
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
                  status: value === "open" ? undefined : value,
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
        description="Persistent, triageable errors grouped by fingerprint."
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
        description="Persistent, triageable errors grouped by fingerprint."
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
      return (
        <DashboardLayout
          breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
          title="Issues"
          description="Persistent, triageable errors grouped by fingerprint."
        >
          <div className="space-y-4">
            {filterRow}
            {issues.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No issues</EmptyTitle>
                  <EmptyDescription>
                    {activeStatus === "open"
                      ? "No open issues. Nice."
                      : `No issues with status "${activeStatus}".`}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table
                className={isRefreshing ? "opacity-60 transition-opacity" : ""}
                aria-busy={isRefreshing}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Exception</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead>Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {issues.map((issue) => (
                    <TableRow key={issue.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <IssueStatusBadge status={issue.status} />
                          {issue.hasOpenIncident ? (
                            <Badge
                              variant="outline"
                              className="bg-destructive/10 text-destructive"
                            >
                              incident
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
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
                        {issue.topFrame ? (
                          <div className="truncate font-mono text-xs text-muted-foreground/70">
                            {issue.topFrame}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{issue.serviceName}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {issue.occurrenceCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelativeTime(issue.lastSeenAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DashboardLayout>
      )
    })
    .render()
}
