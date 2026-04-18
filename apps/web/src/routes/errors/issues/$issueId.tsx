import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Textarea } from "@maple/ui/components/ui/textarea"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import {
  ErrorIssueId,
  type ErrorIssueDocument,
  type ErrorIssueStatus,
  UserId,
} from "@maple/domain/http"

const decodeIssueId = Schema.decodeSync(ErrorIssueId)
const decodeUserId = Schema.decodeSync(UserId)

type IssuePatch = {
  status?: ErrorIssueStatus
  assignedTo?: UserId | null
  notes?: string | null
}

export const Route = effectRoute(createFileRoute("/errors/issues/$issueId"))({
  component: IssueDetailPage,
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

function IssueDetailPage() {
  const { issueId: rawIssueId } = Route.useParams()
  const issueId = decodeIssueId(rawIssueId)

  const detailQueryAtom = MapleApiAtomClient.query("errors", "getIssue", {
    params: { issueId },
    query: {},
    reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
  })
  const detailResult = useAtomValue(detailQueryAtom)
  const updateIssue = useAtomSet(
    MapleApiAtomClient.mutation("errors", "updateIssue"),
    { mode: "promiseExit" },
  )

  const [notesDraft, setNotesDraft] = useState("")
  const [assigneeDraft, setAssigneeDraft] = useState("")
  const [savingField, setSavingField] = useState<
    "status" | "notes" | "assignee" | null
  >(null)

  // Only sync drafts when the issue *changes* (id flip or after a save). Don't
  // overwrite in-flight typing on every refetch.
  const lastSyncedRef = useRef<{
    id: string | null
    notes: string | null
    assignedTo: string | null
  }>({ id: null, notes: null, assignedTo: null })

  useEffect(() => {
    if (!Result.isSuccess(detailResult)) return
    const issue = detailResult.value.issue
    const last = lastSyncedRef.current
    if (
      last.id === issue.id &&
      last.notes === (issue.notes ?? null) &&
      last.assignedTo === (issue.assignedTo ?? null)
    ) {
      return
    }
    lastSyncedRef.current = {
      id: issue.id,
      notes: issue.notes ?? null,
      assignedTo: issue.assignedTo ?? null,
    }
    setNotesDraft(issue.notes ?? "")
    setAssigneeDraft(issue.assignedTo ?? "")
  }, [detailResult])

  const patchIssue = async (
    patch: IssuePatch,
    field: "status" | "notes" | "assignee",
  ) => {
    setSavingField(field)
    const result = await updateIssue({
      params: { issueId },
      payload: patch,
      reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
    })
    setSavingField(null)
    if (Exit.isSuccess(result)) {
      toast.success("Issue updated")
    } else {
      toast.error("Failed to update issue")
    }
  }

  const decodeOptionalUserId = (raw: string): UserId | null => {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    try {
      return decodeUserId(trimmed)
    } catch {
      return null
    }
  }

  const breadcrumbsLoading = [
    { label: "Errors", href: "/errors" },
    { label: "Issues", href: "/errors/issues" },
    { label: "…" },
  ] as const

  return Result.builder(detailResult)
    .onInitial(() => (
      <DashboardLayout
        breadcrumbs={[...breadcrumbsLoading]}
        title="Issue"
      >
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </DashboardLayout>
    ))
    .onError((error) => (
      <DashboardLayout
        breadcrumbs={[...breadcrumbsLoading]}
        title="Issue"
      >
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Failed to load issue</EmptyTitle>
            <EmptyDescription>
              {error.message ?? "Try refreshing or check API logs."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </DashboardLayout>
    ))
    .onSuccess((detail) => {
      const { issue, timeseries, sampleTraces, incidents } = detail
      const totalInWindow = timeseries.reduce((sum, b) => sum + b.count, 0)
      return (
        <DashboardLayout
          breadcrumbs={[
            { label: "Errors", href: "/errors" },
            { label: "Issues", href: "/errors/issues" },
            { label: issue.exceptionType || "Unknown error" },
          ]}
          title={issue.exceptionType || "Unknown error"}
          description={issue.serviceName}
          headerActions={
            <div className="flex items-center gap-2">
              <IssueStatusBadge status={issue.status} />
              {issue.hasOpenIncident ? (
                <Badge variant="outline" className="bg-destructive/10 text-destructive">
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
                  <Stat
                    label="Events (total)"
                    value={issue.occurrenceCount.toLocaleString()}
                  />
                  <Stat
                    label="Events (window)"
                    value={totalInWindow.toLocaleString()}
                  />
                  <Stat
                    label="First seen"
                    value={formatRelativeTime(issue.firstSeenAt)}
                  />
                  <Stat
                    label="Last seen"
                    value={formatRelativeTime(issue.lastSeenAt)}
                  />
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
                  <Label htmlFor="assignee-input" className="text-sm font-medium">
                    Assignee
                  </Label>
                  <Input
                    id="assignee-input"
                    value={assigneeDraft}
                    placeholder="user id"
                    aria-busy={savingField === "assignee"}
                    onChange={(e) => setAssigneeDraft(e.target.value)}
                    onBlur={() => {
                      const next = decodeOptionalUserId(assigneeDraft)
                      if (next !== (issue.assignedTo ?? null)) {
                        patchIssue({ assignedTo: next }, "assignee")
                      }
                    }}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <Label htmlFor="notes-input" className="text-sm font-medium">
                    Notes
                  </Label>
                  <Textarea
                    id="notes-input"
                    rows={4}
                    value={notesDraft}
                    placeholder="Triage notes, context, links…"
                    aria-busy={savingField === "notes"}
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
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No incidents yet</EmptyTitle>
                    <EmptyDescription>
                      Incidents open on first-seen or regression events.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
                                ? "bg-destructive/10 text-destructive"
                                : "bg-muted text-muted-foreground"
                            }
                          >
                            {incident.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{incident.reason}</TableCell>
                        <TableCell>
                          {formatRelativeTime(incident.firstTriggeredAt)}
                        </TableCell>
                        <TableCell>
                          {formatRelativeTime(incident.lastTriggeredAt)}
                        </TableCell>
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
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No samples in window</EmptyTitle>
                  </EmptyHeader>
                </Empty>
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
                        <TableCell className="max-w-sm truncate">
                          {trace.exceptionMessage}
                        </TableCell>
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
    })
    .render()
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  )
}
