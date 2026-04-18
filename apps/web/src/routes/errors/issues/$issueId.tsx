import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Schema } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ActorChip } from "@/components/errors/actor-chip"
import { IssueTimeline } from "@/components/errors/issue-timeline"
import { StateSelect } from "@/components/errors/state-select"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatRelativeTime } from "@/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
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
import { ErrorIssueId, type WorkflowState } from "@maple/domain/http"

const decodeIssueId = Schema.decodeSync(ErrorIssueId)

export const Route = effectRoute(createFileRoute("/errors/issues/$issueId"))({
  component: IssueDetailPage,
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

function formatLeaseCountdown(leaseExpiresAt: string, nowMs: number): string {
  const expiresMs = Date.parse(leaseExpiresAt)
  if (!Number.isFinite(expiresMs)) return "—"
  const delta = expiresMs - nowMs
  if (delta <= 0) return "expired"
  const minutes = Math.floor(delta / 60_000)
  const seconds = Math.floor((delta % 60_000) / 1000)
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  return `${minutes}m ${seconds}s`
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

  const eventsQueryAtom = MapleApiAtomClient.query(
    "errors",
    "listIssueEvents",
    {
      params: { issueId },
      query: { limit: 200 },
      reactivityKeys: ["errorIssues", `errorIssue:${issueId}:events`],
    },
  )
  const eventsResult = useAtomValue(eventsQueryAtom)

  const transitionIssue = useAtomSet(
    MapleApiAtomClient.mutation("errors", "transitionIssue"),
    { mode: "promiseExit" },
  )
  const claimIssue = useAtomSet(
    MapleApiAtomClient.mutation("errors", "claimIssue"),
    { mode: "promiseExit" },
  )
  const heartbeatIssue = useAtomSet(
    MapleApiAtomClient.mutation("errors", "heartbeatIssue"),
    { mode: "promiseExit" },
  )
  const releaseIssue = useAtomSet(
    MapleApiAtomClient.mutation("errors", "releaseIssue"),
    { mode: "promiseExit" },
  )
  const commentOnIssue = useAtomSet(
    MapleApiAtomClient.mutation("errors", "commentOnIssue"),
    { mode: "promiseExit" },
  )

  const [notesDraft, setNotesDraft] = useState("")
  const [commentDraft, setCommentDraft] = useState("")
  const [busy, setBusy] = useState<
    "state" | "claim" | "release" | "heartbeat" | "comment" | null
  >(null)

  const lastSyncedRef = useRef<{ id: string | null; notes: string | null }>({
    id: null,
    notes: null,
  })

  useEffect(() => {
    if (!Result.isSuccess(detailResult)) return
    const issue = detailResult.value.issue
    const last = lastSyncedRef.current
    if (last.id === issue.id && last.notes === (issue.notes ?? null)) return
    lastSyncedRef.current = { id: issue.id, notes: issue.notes ?? null }
    setNotesDraft(issue.notes ?? "")
  }, [detailResult])

  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 5_000)
    return () => clearInterval(interval)
  }, [])

  const invalidateKeys = useMemo(
    () => ["errorIssues", `errorIssue:${issueId}`, `errorIssue:${issueId}:events`],
    [issueId],
  )

  const transitionTo = async (next: WorkflowState) => {
    setBusy("state")
    const result = await transitionIssue({
      params: { issueId },
      payload: { toState: next },
      reactivityKeys: invalidateKeys,
    })
    setBusy(null)
    if (Exit.isSuccess(result)) toast.success(`Moved to ${next}`)
    else toast.error("State change failed")
  }

  const claim = async () => {
    setBusy("claim")
    const result = await claimIssue({
      params: { issueId },
      payload: {},
      reactivityKeys: invalidateKeys,
    })
    setBusy(null)
    if (Exit.isSuccess(result)) toast.success("Claimed")
    else toast.error("Claim failed")
  }

  const heartbeat = async () => {
    setBusy("heartbeat")
    const result = await heartbeatIssue({
      params: { issueId },
      reactivityKeys: invalidateKeys,
    })
    setBusy(null)
    if (Exit.isSuccess(result)) toast.success("Lease extended")
    else toast.error("Heartbeat failed")
  }

  const release = async () => {
    setBusy("release")
    const result = await releaseIssue({
      params: { issueId },
      payload: {},
      reactivityKeys: invalidateKeys,
    })
    setBusy(null)
    if (Exit.isSuccess(result)) toast.success("Released")
    else toast.error("Release failed")
  }

  const submitComment = async () => {
    const body = commentDraft.trim()
    if (body.length === 0) return
    setBusy("comment")
    const result = await commentOnIssue({
      params: { issueId },
      payload: { body },
      reactivityKeys: invalidateKeys,
    })
    setBusy(null)
    if (Exit.isSuccess(result)) {
      setCommentDraft("")
      toast.success("Comment added")
    } else {
      toast.error("Comment failed")
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
      const events = Result.isSuccess(eventsResult)
        ? eventsResult.value.events
        : []
      const leaseCountdown = issue.leaseExpiresAt
        ? formatLeaseCountdown(issue.leaseExpiresAt, nowTick)
        : null
      const isTerminal =
        issue.workflowState === "cancelled" || issue.workflowState === "done"
      const canClaim = !issue.leaseHolder && !isTerminal

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
              <WorkflowBadge state={issue.workflowState} />
              {issue.hasOpenIncident ? (
                <Badge
                  variant="outline"
                  className="bg-destructive/10 text-destructive"
                >
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
                <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">State</Label>
                    <StateSelect
                      current={issue.workflowState}
                      disabled={busy === "state"}
                      onChange={transitionTo}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Assignee</Label>
                    <ActorChip actor={issue.assignedActor} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Lease holder</Label>
                    <div className="flex items-center gap-2">
                      <ActorChip actor={issue.leaseHolder} />
                      {leaseCountdown ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {leaseCountdown}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {canClaim ? (
                      <Button size="sm" onClick={claim} disabled={busy === "claim"}>
                        Claim
                      </Button>
                    ) : null}
                    {issue.leaseHolder ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={heartbeat}
                          disabled={busy === "heartbeat"}
                        >
                          Heartbeat
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={release}
                          disabled={busy === "release"}
                        >
                          Release
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 pt-6">
                <Label htmlFor="notes-input" className="text-sm font-medium">
                  Notes (read-only for now)
                </Label>
                <Textarea
                  id="notes-input"
                  rows={3}
                  value={notesDraft}
                  readOnly
                  placeholder="Triage notes appear here when set via comments or transitions."
                />
              </CardContent>
            </Card>

            <section>
              <h2 className="mb-2 text-lg font-semibold">Timeline</h2>
              <IssueTimeline events={events} />
              <div className="mt-3 space-y-2">
                <Label htmlFor="comment-input" className="text-sm font-medium">
                  Add a comment
                </Label>
                <Textarea
                  id="comment-input"
                  rows={3}
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="Context, findings, links…"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={submitComment}
                    disabled={busy === "comment" || commentDraft.trim().length === 0}
                  >
                    Comment
                  </Button>
                </div>
              </div>
            </section>

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
