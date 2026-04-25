import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import { ArrowUpDownIcon } from "@/components/icons"
import type { WorkloadKind } from "@/api/tinybird/infra"
import { HostStatusBadge } from "./status-badge"
import { UsageBar } from "./usage-bar"
import { deriveHostStatus, formatRelative, type HostStatus } from "./format"

export interface WorkloadRow {
  workloadName: string
  namespace: string
  clusterName: string
  environment: string
  podCount: number
  lastSeen: string
  avgCpuLimitPct: number
  avgMemoryLimitPct: number
  avgCpuUsage: number
}

type SortKey =
  | "workloadName"
  | "namespace"
  | "podCount"
  | "avgCpuLimitPct"
  | "avgMemoryLimitPct"
  | "lastSeen"
type SortDir = "asc" | "desc"

const STRIPE_COLOR: Record<HostStatus, string> = {
  active: "bg-[color-mix(in_oklab,var(--severity-info)_75%,transparent)]",
  idle: "bg-border",
  down: "bg-[color-mix(in_oklab,var(--severity-error)_80%,transparent)]",
}

interface WorkloadTableProps {
  workloads: ReadonlyArray<WorkloadRow>
  kind: WorkloadKind
  waiting?: boolean
  referenceTime?: string
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] text-muted-foreground/80">
      {children}
    </span>
  )
}

function ColumnHead({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  align = "left",
  width,
  hidden,
}: {
  label: string
  sortKey?: SortKey
  currentKey?: SortKey
  dir?: SortDir
  onSort?: (k: SortKey) => void
  align?: "left" | "right"
  width: string
  hidden?: string
}) {
  const active = sortKey && currentKey === sortKey
  const sortable = !!sortKey
  return (
    <div
      className={cn(
        "flex items-center text-[11px] font-medium",
        align === "right" && "justify-end",
        width,
        hidden,
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => sortKey && onSort?.(sortKey)}
          className={cn(
            "inline-flex items-center gap-1 transition-colors",
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
          <ArrowUpDownIcon
            size={10}
            className={cn(
              "transition-opacity",
              active ? "opacity-100" : "opacity-40",
              active && dir === "asc" && "rotate-180",
            )}
          />
        </button>
      ) : (
        <span className="text-muted-foreground">{label}</span>
      )}
    </div>
  )
}

export function WorkloadTableLoading() {
  return (
    <div className="border-y border-border/70">
      <div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">
        <ColumnHead label="Workload" width="flex-1 min-w-[260px]" />
        <ColumnHead label="Status" width="w-[88px]" />
        <ColumnHead label="Pods" align="right" width="w-[60px]" />
        <ColumnHead label="Avg CPU" align="right" width="w-[160px]" hidden="hidden md:flex" />
        <ColumnHead label="Avg memory" align="right" width="w-[160px]" hidden="hidden lg:flex" />
        <ColumnHead label="Last seen" align="right" width="w-[100px]" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
        >
          <div className="flex flex-1 min-w-[260px] gap-3">
            <span className="w-[2px] self-stretch bg-muted/50" />
            <div className="flex-1">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-1.5 h-3 w-32" />
            </div>
          </div>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-6" />
          <Skeleton className="hidden md:block h-3 w-[160px]" />
          <Skeleton className="hidden lg:block h-3 w-[160px]" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}

export function WorkloadTable({ workloads, kind, waiting, referenceTime }: WorkloadTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("avgCpuLimitPct")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  function handleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(k)
      setSortDir(k === "workloadName" || k === "namespace" ? "asc" : "desc")
    }
  }

  const sorted = useMemo(() => {
    const copy = [...workloads]
    copy.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av
      }
      const as = String(av)
      const bs = String(bv)
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as)
    })
    return copy
  }, [workloads, sortKey, sortDir])

  return (
    <div
      className={cn(
        "border-y border-border/70 transition-opacity",
        waiting && "opacity-60",
      )}
      aria-label="Workloads"
    >
      <div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">
        <ColumnHead
          label="Workload"
          sortKey="workloadName"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          width="flex-1 min-w-[260px]"
        />
        <ColumnHead label="Status" width="w-[88px]" />
        <ColumnHead
          label="Pods"
          sortKey="podCount"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          align="right"
          width="w-[60px]"
        />
        <ColumnHead
          label="Avg CPU"
          sortKey="avgCpuLimitPct"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          align="right"
          width="w-[160px]"
          hidden="hidden md:flex"
        />
        <ColumnHead
          label="Avg memory"
          sortKey="avgMemoryLimitPct"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          align="right"
          width="w-[160px]"
          hidden="hidden lg:flex"
        />
        <ColumnHead
          label="Last seen"
          sortKey="lastSeen"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          align="right"
          width="w-[100px]"
        />
      </div>

      {sorted.length === 0 ? (
        <div className="px-4 py-12 text-center text-[12px] text-muted-foreground">
          No workloads match your filter.
        </div>
      ) : (
        sorted.map((wl) => {
          const status = deriveHostStatus(wl.lastSeen, referenceTime ?? Date.now())
          return (
            <Link
              key={`${wl.namespace}/${wl.workloadName}`}
              to="/infra/kubernetes/workloads/$kind/$workloadName"
              params={{ kind, workloadName: wl.workloadName }}
              search={wl.namespace ? { namespace: wl.namespace } : {}}
              className="group flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
            >
              <div className="flex flex-1 min-w-[260px] gap-3">
                <span
                  className={cn(
                    "w-[2px] self-stretch transition-all",
                    STRIPE_COLOR[status],
                    "group-hover:w-[3px] group-hover:bg-primary",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
                    {wl.workloadName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {wl.namespace && <MetaChip>ns {wl.namespace}</MetaChip>}
                    <span className="text-foreground/20">·</span>
                    <MetaChip>kind {kind}</MetaChip>
                  </div>
                </div>
              </div>
              <div className="w-[88px]">
                <HostStatusBadge lastSeen={wl.lastSeen} referenceTime={referenceTime} />
              </div>
              <div className="w-[60px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
                {wl.podCount}
              </div>
              <div className="hidden md:block w-[160px]">
                <UsageBar fraction={wl.avgCpuLimitPct} />
              </div>
              <div className="hidden lg:block w-[160px]">
                <UsageBar fraction={wl.avgMemoryLimitPct} />
              </div>
              <div className="w-[100px] text-right">
                <Tooltip>
                  <TooltipTrigger
                    render={<span />}
                    className="cursor-default font-mono text-[11px] text-muted-foreground"
                  >
                    {formatRelative(wl.lastSeen)}
                  </TooltipTrigger>
                  <TooltipContent>{wl.lastSeen}</TooltipContent>
                </Tooltip>
              </div>
            </Link>
          )
        })
      )}
    </div>
  )
}
