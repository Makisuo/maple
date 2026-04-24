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
import { formatLoad, formatRelative } from "./format"

export interface HostRow {
  hostName: string
  osType: string
  hostArch: string
  cloudProvider: string
  lastSeen: string
  cpuPct: number
  memoryPct: number
  diskPct: number
  load15: number
}

type SortKey = "cpuPct" | "memoryPct" | "diskPct" | "load15" | "lastSeen" | "hostName"
type SortDir = "asc" | "desc"

interface HostTableProps {
  hosts: ReadonlyArray<HostRow>
  waiting?: boolean
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

export function HostTableLoading() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <TableHead>Host</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="w-[200px]">CPU</TableHead>
            <TableHead className="hidden md:table-cell w-[200px]">Memory</TableHead>
            <TableHead className="hidden lg:table-cell w-[200px]">Disk</TableHead>
            <TableHead className="hidden lg:table-cell w-[100px]">Load 15m</TableHead>
            <TableHead className="w-[120px]">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 6 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-40" />
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
  align = "left",
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onSort: (k: SortKey) => void
  className?: string
  align?: "left" | "right"
}) {
  const active = currentKey === sortKey
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
          align === "right" && "ml-auto",
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

export function HostTable({ hosts, waiting }: HostTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("cpuPct")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  function handleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(k)
      setSortDir(k === "hostName" ? "asc" : "desc")
    }
  }

  const sorted = useMemo(() => {
    const copy = [...hosts]
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
  }, [hosts, sortKey, sortDir])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-opacity",
        waiting && "opacity-60",
      )}
    >
      <Table aria-label="Hosts">
        <TableHeader>
          <TableRow className="border-b bg-muted/40 hover:bg-muted/40">
            <SortHead
              label="Host"
              sortKey="hostName"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
            />
            <TableHead className="w-[110px] text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </TableHead>
            <SortHead
              label="CPU"
              sortKey="cpuPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="w-[200px]"
            />
            <SortHead
              label="Memory"
              sortKey="memoryPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden md:table-cell w-[200px]"
            />
            <SortHead
              label="Disk"
              sortKey="diskPct"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden lg:table-cell w-[200px]"
            />
            <SortHead
              label="Load 15m"
              sortKey="load15"
              currentKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className="hidden lg:table-cell w-[100px]"
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
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                No hosts match your search.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((host) => (
              <TableRow
                key={host.hostName}
                className="group border-b last:border-0 hover:bg-muted/40"
              >
                <TableCell className="py-3">
                  <Link
                    to="/infra/$hostName"
                    params={{ hostName: host.hostName }}
                    className="block focus-visible:outline-none"
                  >
                    <div className="font-mono text-sm font-medium text-foreground group-hover:text-primary">
                      {host.hostName}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {host.osType && <MetaChip>{host.osType}</MetaChip>}
                      {host.hostArch && <MetaChip>{host.hostArch}</MetaChip>}
                      {host.cloudProvider && <MetaChip>{host.cloudProvider}</MetaChip>}
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  <HostStatusBadge lastSeen={host.lastSeen} />
                </TableCell>
                <TableCell>
                  <UsageBar fraction={host.cpuPct} />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <UsageBar fraction={host.memoryPct} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <UsageBar fraction={host.diskPct} />
                </TableCell>
                <TableCell className="hidden lg:table-cell font-mono text-xs tabular-nums text-foreground/80">
                  {formatLoad(host.load15)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span />}
                      className="cursor-default font-mono"
                    >
                      {formatRelative(host.lastSeen)}
                    </TooltipTrigger>
                    <TooltipContent>{host.lastSeen}</TooltipContent>
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
