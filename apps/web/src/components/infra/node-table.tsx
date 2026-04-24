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
import { formatRelative } from "./format"

export interface NodeRow {
  nodeName: string
  nodeUid: string
  clusterName: string
  environment: string
  kubeletVersion: string
  lastSeen: string
  cpuUsage: number
  uptime: number
}

type SortKey = "nodeName" | "cpuUsage" | "uptime" | "lastSeen"
type SortDir = "asc" | "desc"

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function NodeTableLoading() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <TableHead>Node</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="hidden md:table-cell w-[140px]">CPU cores</TableHead>
            <TableHead className="hidden md:table-cell w-[140px]">Uptime</TableHead>
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
              <TableCell className="hidden md:table-cell">
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Skeleton className="h-4 w-16" />
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

interface NodeTableProps {
  nodes: ReadonlyArray<NodeRow>
  waiting?: boolean
  referenceTime?: string
}

export function NodeTable({ nodes, waiting, referenceTime }: NodeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("cpuUsage")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  function handleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(k)
      setSortDir(k === "nodeName" ? "asc" : "desc")
    }
  }

  const sorted = useMemo(() => {
    const copy = [...nodes]
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
  }, [nodes, sortKey, sortDir])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-opacity",
        waiting && "opacity-60",
      )}
    >
      <Table aria-label="Nodes">
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <SortHead
              label="Node"
              sortKey="nodeName"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
            />
            <TableHead className="w-[110px] text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </TableHead>
            <SortHead
              label="CPU cores"
              sortKey="cpuUsage"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell w-[140px]"
            />
            <SortHead
              label="Uptime"
              sortKey="uptime"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell w-[140px]"
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
              <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                No nodes match your search.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((node) => (
              <TableRow
                key={node.nodeName}
                className="group border-b last:border-0 hover:bg-muted/40"
              >
                <TableCell className="py-3">
                  <Link
                    to="/infra/kubernetes/nodes/$nodeName"
                    params={{ nodeName: node.nodeName }}
                    className="block focus-visible:outline-none"
                  >
                    <div className="font-mono text-sm font-medium text-foreground group-hover:text-primary">
                      {node.nodeName}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {node.kubeletVersion && (
                        <MetaChip>kubelet={node.kubeletVersion}</MetaChip>
                      )}
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  <HostStatusBadge lastSeen={node.lastSeen} referenceTime={referenceTime} />
                </TableCell>
                <TableCell className="hidden md:table-cell font-mono text-xs tabular-nums text-foreground/80">
                  {Number.isFinite(node.cpuUsage) ? node.cpuUsage.toFixed(2) : "—"}
                </TableCell>
                <TableCell className="hidden md:table-cell font-mono text-xs tabular-nums text-foreground/80">
                  {formatUptime(node.uptime)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span />}
                      className="cursor-default font-mono"
                    >
                      {formatRelative(node.lastSeen)}
                    </TooltipTrigger>
                    <TooltipContent>{node.lastSeen}</TooltipContent>
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
