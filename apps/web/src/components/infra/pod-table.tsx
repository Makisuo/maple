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
import { HostStatusBadge } from "./status-badge"
import { UsageBar } from "./usage-bar"
import { formatRelative } from "./format"

export interface PodRow {
  podName: string
  namespace: string
  nodeName: string
  deploymentName: string
  statefulsetName: string
  daemonsetName: string
  qosClass: string
  podUid: string
  lastSeen: string
  cpuUsage: number
  cpuLimitPct: number
  memoryLimitPct: number
}

type SortKey =
  | "podName"
  | "namespace"
  | "cpuLimitPct"
  | "memoryLimitPct"
  | "cpuUsage"
  | "lastSeen"
type SortDir = "asc" | "desc"

interface PodTableProps {
  pods: ReadonlyArray<PodRow>
  waiting?: boolean
}

function workloadOf(pod: PodRow): { kind: string; name: string } | null {
  if (pod.deploymentName) return { kind: "deploy", name: pod.deploymentName }
  if (pod.statefulsetName) return { kind: "sts", name: pod.statefulsetName }
  if (pod.daemonsetName) return { kind: "ds", name: pod.daemonsetName }
  return null
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

export function PodTableLoading() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <TableHead>Pod</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="w-[200px]">CPU (limit)</TableHead>
            <TableHead className="hidden md:table-cell w-[200px]">Memory (limit)</TableHead>
            <TableHead className="hidden lg:table-cell w-[120px]">CPU cores</TableHead>
            <TableHead className="w-[120px]">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 6 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-1.5 h-3 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-3 w-full" />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Skeleton className="h-3 w-full" />
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <Skeleton className="h-4 w-12" />
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

export function PodTable({ pods, waiting }: PodTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("cpuLimitPct")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  function handleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(k)
      setSortDir(k === "podName" || k === "namespace" ? "asc" : "desc")
    }
  }

  const sorted = useMemo(() => {
    const copy = [...pods]
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
  }, [pods, sortKey, sortDir])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-opacity",
        waiting && "opacity-60",
      )}
    >
      <Table aria-label="Pods">
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <SortHead
              label="Pod"
              sortKey="podName"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
            />
            <TableHead className="w-[110px] text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </TableHead>
            <SortHead
              label="CPU (limit)"
              sortKey="cpuLimitPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="w-[200px]"
            />
            <SortHead
              label="Memory (limit)"
              sortKey="memoryLimitPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell w-[200px]"
            />
            <SortHead
              label="CPU cores"
              sortKey="cpuUsage"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden lg:table-cell w-[120px]"
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
                No pods match your filter.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((pod) => {
              const workload = workloadOf(pod)
              return (
                <TableRow
                  key={`${pod.namespace}/${pod.podName}`}
                  className="group border-b last:border-0 hover:bg-muted/40"
                >
                  <TableCell className="py-3">
                    <Link
                      to="/infra/kubernetes/pods/$podName"
                      params={{ podName: pod.podName }}
                      search={pod.namespace ? { namespace: pod.namespace } : {}}
                      className="block focus-visible:outline-none"
                    >
                      <div className="font-mono text-sm font-medium text-foreground group-hover:text-primary">
                        {pod.podName}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {pod.namespace && <MetaChip>ns={pod.namespace}</MetaChip>}
                        {workload && (
                          <MetaChip>
                            {workload.kind}={workload.name}
                          </MetaChip>
                        )}
                        {pod.nodeName && <MetaChip>node={pod.nodeName}</MetaChip>}
                        {pod.qosClass && <MetaChip>qos={pod.qosClass}</MetaChip>}
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <HostStatusBadge lastSeen={pod.lastSeen} />
                  </TableCell>
                  <TableCell>
                    <UsageBar fraction={pod.cpuLimitPct} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <UsageBar fraction={pod.memoryLimitPct} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell font-mono text-xs tabular-nums text-foreground/80">
                    {Number.isFinite(pod.cpuUsage) ? pod.cpuUsage.toFixed(3) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <Tooltip>
                      <TooltipTrigger
                        render={<span />}
                        className="cursor-default font-mono"
                      >
                        {formatRelative(pod.lastSeen)}
                      </TooltipTrigger>
                      <TooltipContent>{pod.lastSeen}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}
