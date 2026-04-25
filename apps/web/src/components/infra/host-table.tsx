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
import { HostStatusBadge } from "./status-badge"
import { InlineMetricBars } from "./primitives/inline-bars"
import { deriveHostStatus, formatLoad, formatRelative, type HostStatus } from "./format"

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

const STRIPE_COLOR: Record<HostStatus, string> = {
  active: "bg-[color-mix(in_oklab,var(--severity-info)_75%,transparent)]",
  idle: "bg-border",
  down: "bg-[color-mix(in_oklab,var(--severity-error)_80%,transparent)]",
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

export function HostTableLoading() {
  return (
    <div className="border-y border-border/70">
      <div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">
        <ColumnHead label="Host" width="flex-1 min-w-[260px]" />
        <ColumnHead label="Status" width="w-[88px]" />
        <ColumnHead label="Usage" width="w-[200px]" />
        <ColumnHead label="Load 15m" align="right" width="w-[80px]" hidden="hidden lg:flex" />
        <ColumnHead label="Last seen" align="right" width="w-[100px]" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
        >
          <div className="flex flex-1 min-w-[260px] gap-3">
            <span className="w-[2px] self-stretch bg-muted/50" />
            <div className="flex-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-1.5 h-3 w-32" />
            </div>
          </div>
          <Skeleton className="h-3 w-16 w-[88px]" />
          <Skeleton className="h-9 w-[200px]" />
          <Skeleton className="hidden lg:block ml-auto h-3 w-12 w-[80px]" />
          <Skeleton className="h-3 w-16 w-[100px]" />
        </div>
      ))}
    </div>
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
        "border-y border-border/70 transition-opacity",
        waiting && "opacity-60",
      )}
      aria-label="Hosts"
    >
      <div className="flex items-center gap-4 border-b border-border/60 px-4 py-2">
        <ColumnHead
          label="Host"
          sortKey="hostName"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          width="flex-1 min-w-[260px]"
        />
        <ColumnHead label="Status" width="w-[88px]" />
        <ColumnHead label="Usage" width="w-[200px]" />
        <ColumnHead
          label="Load 15m"
          sortKey="load15"
          currentKey={sortKey}
          dir={sortDir}
          onSort={handleSort}
          align="right"
          width="w-[80px]"
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
          No hosts match your search.
        </div>
      ) : (
        sorted.map((host) => {
          const status = deriveHostStatus(host.lastSeen)
          return (
            <Link
              key={host.hostName}
              to="/infra/$hostName"
              params={{ hostName: host.hostName }}
              className={cn(
                "group flex items-center gap-4 border-b border-border/40 px-4 py-3",
                "transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
              )}
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
                    {host.hostName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {host.osType && <MetaChip>{host.osType}</MetaChip>}
                    {host.hostArch && (
                      <>
                        <span className="text-foreground/20">·</span>
                        <MetaChip>{host.hostArch}</MetaChip>
                      </>
                    )}
                    {host.cloudProvider && (
                      <>
                        <span className="text-foreground/20">·</span>
                        <MetaChip>{host.cloudProvider}</MetaChip>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="w-[88px]">
                <HostStatusBadge lastSeen={host.lastSeen} />
              </div>
              <div className="w-[200px]">
                <InlineMetricBars
                  cpu={host.cpuPct}
                  memory={host.memoryPct}
                  disk={host.diskPct}
                />
              </div>
              <div className="hidden lg:block w-[80px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
                {formatLoad(host.load15)}
              </div>
              <div className="w-[100px] text-right">
                <Tooltip>
                  <TooltipTrigger
                    render={<span />}
                    className="cursor-default font-mono text-[11px] text-muted-foreground"
                  >
                    {formatRelative(host.lastSeen)}
                  </TooltipTrigger>
                  <TooltipContent>{host.lastSeen}</TooltipContent>
                </Tooltip>
              </div>
            </Link>
          )
        })
      )}
    </div>
  )
}
