import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit } from "effect"
import { useState, useEffect } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Textarea } from "@maple/ui/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import type {
  ErrorIssueDocument,
  ErrorIssueStatus,
} from "@maple/domain/http"

export const Route = effectRoute(createFileRoute("/errors/issues/$issueId"))({
  component: IssueDetailPage,
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

function IssueDetailPage() {
  const { issueId } = Route.useParams()

  const detailQueryAtom = MapleApiAtomClient.query("errors", "getIssue", {
    params: { issueId: issueId as never },
    query: {},
    reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
  })
  const detailResult = useAtomValue(detailQueryAtom)
  const updateIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "updateIssue"), {
    mode: "promiseExit",
  })

  const detail = Result.builder(detailResult)
    .onSuccess((response) => response)
    .orElse(() => null)

  const [notesDraft, setNotesDraft] = useState("")
  const [assigneeDraft, setAssigneeDraft] = useState("")
  const [savingField, setSavingField] = useState<"status" | "notes" | "assignee" | null>(null)

  useEffect(() => {
    if (detail) {
      setNotesDraft(detail.issue.notes ?? "")
      setAssigneeDraft(detail.issue.assignedTo ?? "")
    }
  }, [detail?.issue.id, detail?.issue.notes, detail?.issue.assignedTo])

  const patchIssue = async (
    patch: { status?: ErrorIssueStatus; notes?: string | null; assignedTo?: string | null },
    field: "status" | "notes" | "assignee",
  ) => {
    setSavingField(field)
    const result = await updateIssue({
      params: { issueId: issueId as never },
      payload: patch as never,
      reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
    })
    setSavingField(null)
    if (Exit.isSuccess(result)) {
      toast.success("Issue updated")
    } else {
      toast.error("Failed to update issue")
    }
  }

  if (!detail) {
    return (
      <DashboardLayout
        breadcrumbs={[
          { label: "Errors", href: "/errors" },
          { label: "Issues", href: "/errors/issues" },
          { label: "…" },
        ]}
        title="Issue"
      >
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </DashboardLayout>
    )
  }

  const { issue, timeseries, sampleTraces, incidents } = detail
  const totalInWindow = timeseries.reduce((sum, b) => sum + b.count, 0)

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Errors", href: "/errors" },
        { label: "Issues", href: "/errors/issues" },
        { label: issue.exceptionType || "Issue" },
      ]}
      title={issue.exceptionType || "Error"}
      description={issue.serviceName}
      headerActions={
        <div className="flex items-center gap-2">
          <IssueStatusBadge status={issue.status} />
          {issue.hasOpenIncident ? (
            <Badge variant="outline" className="bg-red-500/10 text-red-700 dark:text-red-400">
              Incident open
            </Badge>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div>
              <div className="text-sm text-muted-foreground">Message</div>
              <div className="mt-1">{issue.exceptionMessage}</div>
            </div>
            {issue.topFrame ? (
              <div>
                <div className="text-sm text-muted-foreground">Top frame</div>
                <div className="mt-1 font-mono text-xs">{issue.topFrame}</div>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Events (total)" value={issue.occurrenceCount.toLocaleString()} />
              <Stat label="Events (window)" value={totalInWindow.toLocaleString()} />
              <Stat label="First seen" value={formatRelativeTime(issue.firstSeenAt)} />
              <Stat label="Last seen" value={formatRelativeTime(issue.lastSeenAt)} />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {issue.status !== "resolved" ? (
                <Button
                  size="sm"
                  onClick={() => patchIssue({ status: "resolved" }, "status")}
                  disabled={savingField === "status"}
                >
                  Resolve
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => patchIssue({ status: "open" }, "status")}
                  disabled={savingField === "status"}
                >
                  Reopen
                </Button>
              )}
              {issue.status !== "ignored" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => patchIssue({ status: "ignored" }, "status")}
                  disabled={savingField === "status"}
                >
                  Ignore
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => patchIssue({ status: "open" }, "status")}
                  disabled={savingField === "status"}
                >
                  Unignore
                </Button>
              )}
              {issue.status !== "archived" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => patchIssue({ status: "archived" }, "status")}
                  disabled={savingField === "status"}
                >
                  Archive
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="text-sm font-medium">Assignee</div>
              <Input
                value={assigneeDraft}
                placeholder="user id or email"
                onChange={(e) => setAssigneeDraft(e.target.value)}
                onBlur={() => {
                  const next = assigneeDraft.trim() === "" ? null : assigneeDraft.trim()
                  if (next !== (issue.assignedTo ?? null)) {
                    patchIssue({ assignedTo: next }, "assignee")
                  }
                }}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="text-sm font-medium">Notes</div>
              <Textarea
                rows={4}
                value={notesDraft}
                placeholder="Triage notes, context, links…"
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={() => {
                  const next = notesDraft.trim() === "" ? null : notesDraft
                  if (next !== (issue.notes ?? null)) {
                    patchIssue({ notes: next }, "notes")
                  }
                }}
              />
            </CardContent>
          </Card>
        </div>

        <section>
          <h2 className="mb-2 text-lg font-semibold">Incidents</h2>
          {incidents.length === 0 ? (
            <div className="text-sm text-muted-foreground">No incidents yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Last triggered</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidents.map((incident) => (
                  <TableRow key={incident.id}>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          incident.status === "open"
                            ? "bg-red-500/10 text-red-700 dark:text-red-400"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {incident.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{incident.reason}</TableCell>
                    <TableCell>{formatRelativeTime(incident.firstTriggeredAt)}</TableCell>
                    <TableCell>{formatRelativeTime(incident.lastTriggeredAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {incident.occurrenceCount.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">Latest occurrences</h2>
          {sampleTraces.length === 0 ? (
            <div className="text-sm text-muted-foreground">No samples in window.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sampleTraces.map((trace) => (
                  <TableRow key={`${trace.traceId}-${trace.spanId}`}>
                    <TableCell className="text-muted-foreground">
                      {formatRelativeTime(trace.timestamp)}
                    </TableCell>
                    <TableCell>{trace.serviceName}</TableCell>
                    <TableCell className="max-w-sm truncate">{trace.exceptionMessage}</TableCell>
                    <TableCell>
                      <Link
                        to="/traces/$traceId"
                        params={{ traceId: trace.traceId }}
                        className="font-mono text-xs hover:underline"
                      >
                        {trace.traceId.slice(0, 12)}…
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </DashboardLayout>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  )
}
