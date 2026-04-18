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

const searchSchema = Schema.Struct({
  status: Schema.optional(
    Schema.Literals(["all", "open", "resolved", "ignored", "archived"]),
  ),
})

export const Route = effectRoute(createFileRoute("/errors/issues/"))({
  component: IssuesPage,
  validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const STATUS_BADGE: Record<ErrorIssueDocument["status"], { label: string; tone: string }> = {
  open: { label: "Open", tone: "bg-red-500/10 text-red-700 dark:text-red-400" },
  resolved: { label: "Resolved", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
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
    query: activeStatus === "all" ? {} : { status: activeStatus },
    reactivityKeys: ["errorIssues"],
  })
  const issuesResult = useAtomValue(issuesQueryAtom)

  const issues = Result.builder(issuesResult)
    .onSuccess((response) => [...response.issues])
    .orElse(() => [] as ErrorIssueDocument[])
  const isLoading = Result.isInitial(issuesResult)

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
      title="Issues"
      description="Persistent, triageable errors grouped by fingerprint."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {(["open", "resolved", "ignored", "all"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={activeStatus === s ? "default" : "outline"}
              onClick={() =>
                navigate({ search: (prev) => ({ ...prev, status: s === "open" ? undefined : s }) })
              }
            >
              {s === "all" ? "All" : STATUS_BADGE[s as ErrorIssueDocument["status"]].label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : issues.length === 0 ? (
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
          <Table>
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
                    <IssueStatusBadge status={issue.status} />
                    {issue.hasOpenIncident ? (
                      <span className="ml-2 text-xs text-red-600 dark:text-red-400">
                        • incident
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <Link
                      to="/errors/issues/$issueId"
                      params={{ issueId: issue.id }}
                      className="font-medium hover:underline"
                    >
                      {issue.exceptionType || "Error"}
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
}
