import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
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
import { formatRelative } from "./format"

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

interface WorkloadTableProps {
  workloads: ReadonlyArray<WorkloadRow>
  kind: WorkloadKind
  waiting?: boolean
  referenceTime?: string
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

export function WorkloadTableLoading() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <TableHead>Workload</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="w-[80px]">Pods</TableHead>
            <TableHead className="hidden md:table-cell w-[200px]">Avg CPU</TableHead>
            <TableHead className="hidden lg:table-cell w-[200px]">Avg memory</TableHead>
            <TableHead className="w-[120px]">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 4 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-1.5 h-3 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-8" />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Skeleton className="h-3 w-full" />
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <Skeleton className="h-3 w-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function SortHead({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  className,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onSort: (k: SortKey) => void
  className?: string
}) {
  const active = currentKey === sortKey
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        <ArrowUpDownIcon
          size={11}
          className={cn(
            "transition-opacity",
            active ? "opacity-100" : "opacity-40",
            active && dir === "asc" && "rotate-180",
          )}
        />
      </button>
    </TableHead>
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
        "overflow-hidden rounded-lg border bg-card transition-opacity",
        waiting && "opacity-60",
      )}
    >
      <Table aria-label="Workloads">
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <SortHead
              label="Workload"
              sortKey="workloadName"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
            />
            <TableHead className="w-[110px] text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </TableHead>
            <SortHead
              label="Pods"
              sortKey="podCount"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="w-[80px]"
            />
            <SortHead
              label="Avg CPU"
              sortKey="avgCpuLimitPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell w-[200px]"
            />
            <SortHead
              label="Avg memory"
              sortKey="avgMemoryLimitPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden lg:table-cell w-[200px]"
            />
            <SortHead
              label="Last seen"
              sortKey="lastSeen"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="w-[120px]"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                No workloads match your filter.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((wl) => (
              <TableRow
                key={`${wl.namespace}/${wl.workloadName}`}
                className="group border-b last:border-0 hover:bg-muted/40"
              >
                <TableCell className="py-3">
                  <Link
                    to="/infra/kubernetes/workloads/$kind/$workloadName"
                    params={{ kind, workloadName: wl.workloadName }}
                    search={wl.namespace ? { namespace: wl.namespace } : {}}
                    className="block focus-visible:outline-none"
                  >
                    <div className="font-mono text-sm font-medium text-foreground group-hover:text-primary">
                      {wl.workloadName}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {wl.namespace && <MetaChip>ns={wl.namespace}</MetaChip>}
                      <MetaChip>kind={kind}</MetaChip>
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  <HostStatusBadge lastSeen={wl.lastSeen} referenceTime={referenceTime} />
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                  {wl.podCount}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <UsageBar fraction={wl.avgCpuLimitPct} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <UsageBar fraction={wl.avgMemoryLimitPct} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span />}
                      className="cursor-default font-mono"
                    >
                      {formatRelative(wl.lastSeen)}
                    </TooltipTrigger>
                    <TooltipContent>{wl.lastSeen}</TooltipContent>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
