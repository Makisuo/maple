import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { IssueGroup } from "@/components/errors/issue-group"
import { IssuesBulkBar } from "@/components/errors/issues-bulk-bar"
import { IssuesToolbar } from "@/components/errors/issues-toolbar"
import { useIssueMutations } from "@/components/errors/use-issue-mutations"
import type { SelectToggleEvent } from "@/components/errors/issue-row"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import type {
  ErrorIssueDocument,
  ErrorIssueId,
  WorkflowState,
} from "@maple/domain/http"

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

const TOOLBAR_TABS = FILTER_VALUES.map((value) => ({
  value,
  label: FILTER_LABEL[value],
}))

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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
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
  const mutations = useIssueMutations()

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const anchorRef = useRef<string | null>(null)

  const toolbar = (
    <IssuesToolbar
      tabs={TOOLBAR_TABS}
      active={activeFilter}
      onChange={(value) => {
        setSelectedIds(new Set())
        navigate({
          search: (prev) => ({
            ...prev,
            workflowState: value === "triage" ? undefined : value,
          }),
        })
      }}
    />
  )

  return Result.builder(issuesResult)
    .onInitial(() => (
      <DashboardLayout
        breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
        title="Issues"
        description="Workflow-tracked errors, grouped by fingerprint."
      >
        <div>
          {toolbar}
          <div className="space-y-px p-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
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
        <div>
          {toolbar}
          <div className="p-4">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Failed to load issues</EmptyTitle>
                <EmptyDescription>
                  {error.message ?? "Try refreshing or check API logs."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        </div>
      </DashboardLayout>
    ))
    .onSuccess((response) => {
      const issues = response.issues
      return (
        <IssuesPageBody
          issues={issues}
          isRefreshing={issuesResult.waiting}
          activeFilter={activeFilter}
          mutations={mutations}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          anchorRef={anchorRef}
          toolbar={toolbar}
        />
      )
    })
    .render()
}

interface IssuesPageBodyProps {
  issues: ReadonlyArray<ErrorIssueDocument>
  isRefreshing: boolean
  activeFilter: FilterValue
  mutations: ReturnType<typeof useIssueMutations>
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  focusedId: string | null
  setFocusedId: React.Dispatch<React.SetStateAction<string | null>>
  anchorRef: React.MutableRefObject<string | null>
  toolbar: React.ReactNode
}

function IssuesPageBody({
  issues,
  isRefreshing,
  activeFilter,
  mutations,
  selectedIds,
  setSelectedIds,
  focusedId,
  setFocusedId,
  anchorRef,
  toolbar,
}: IssuesPageBodyProps) {
  const grouped = useMemo(() => {
    const map = new Map<WorkflowState, ErrorIssueDocument[]>()
    for (const issue of issues) {
      const bucket = map.get(issue.workflowState) ?? []
      bucket.push(issue)
      map.set(issue.workflowState, bucket)
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        return b.lastSeenAt.localeCompare(a.lastSeenAt)
      })
    }
    return map
  }, [issues])

  const visibleGroups = useMemo(
    () => GROUP_ORDER.filter((state) => (grouped.get(state)?.length ?? 0) > 0),
    [grouped],
  )

  const flatIssues = useMemo<ReadonlyArray<ErrorIssueDocument>>(() => {
    const out: ErrorIssueDocument[] = []
    for (const state of visibleGroups) {
      const bucket = grouped.get(state)
      if (bucket) out.push(...bucket)
    }
    return out
  }, [grouped, visibleGroups])

  const selectedArray = useMemo(
    () =>
      flatIssues
        .filter((i) => selectedIds.has(i.id))
        .map((i) => i.id as ErrorIssueId),
    [flatIssues, selectedIds],
  )

  const handleSelectToggle = useCallback(
    (id: string, event: SelectToggleEvent) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (event.shiftKey && anchorRef.current) {
          const ids = flatIssues.map((i) => i.id as string)
          const a = ids.indexOf(anchorRef.current)
          const b = ids.indexOf(id)
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a]
            for (let i = lo; i <= hi; i++) next.add(ids[i]!)
            return next
          }
        }
        if (next.has(id)) next.delete(id)
        else next.add(id)
        anchorRef.current = id
        return next
      })
      setFocusedId(id)
    },
    [flatIssues, anchorRef, setSelectedIds, setFocusedId],
  )

  const handleFocus = useCallback(
    (id: string) => {
      setFocusedId(id)
    },
    [setFocusedId],
  )

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [setSelectedIds])

  const navigate = useNavigate({ from: Route.fullPath })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (flatIssues.length === 0) return

      const ids = flatIssues.map((i) => i.id as string)
      const currentIndex = focusedId ? ids.indexOf(focusedId) : -1

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        const next = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, ids.length - 1)
        const id = ids[next]!
        setFocusedId(id)
        scrollIntoView(id)
        return
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        const next = currentIndex <= 0 ? 0 : currentIndex - 1
        const id = ids[next]!
        setFocusedId(id)
        scrollIntoView(id)
        return
      }
      if (e.key === "Enter" && focusedId) {
        e.preventDefault()
        navigate({
          to: "/errors/issues/$issueId",
          params: { issueId: focusedId as ErrorIssueId },
        })
        return
      }
      if (e.key.toLowerCase() === "x" && focusedId) {
        e.preventDefault()
        handleSelectToggle(focusedId, {
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
        })
        return
      }
      if (e.key === "Escape") {
        if (selectedIds.size > 0) {
          e.preventDefault()
          clearSelection()
        }
        return
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [
    flatIssues,
    focusedId,
    selectedIds,
    setFocusedId,
    handleSelectToggle,
    clearSelection,
    navigate,
  ])

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Errors", href: "/errors" }, { label: "Issues" }]}
      title="Issues"
      description="Workflow-tracked errors, grouped by fingerprint."
    >
      <div
        className={isRefreshing ? "opacity-60 transition-opacity" : undefined}
        aria-busy={isRefreshing}
      >
        {toolbar}
        {issues.length === 0 ? (
          <div className="p-4">
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
          </div>
        ) : (
          <div>
            {visibleGroups.map((state) => (
              <IssueGroup
                key={state}
                state={state}
                issues={grouped.get(state) ?? []}
                mutations={mutations}
                selectedIds={selectedIds}
                focusedId={focusedId}
                onSelectToggle={handleSelectToggle}
                onFocus={handleFocus}
              />
            ))}
          </div>
        )}
      </div>
      <IssuesBulkBar
        selectedIds={selectedArray}
        mutations={mutations}
        onClear={clearSelection}
      />
    </DashboardLayout>
  )
}

function scrollIntoView(issueId: string) {
  if (typeof document === "undefined") return
  const el = document.querySelector<HTMLElement>(
    `[data-issue-id="${CSS.escape(issueId)}"]`,
  )
  if (!el) return
  el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
