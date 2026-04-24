import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@maple/ui/components/ui/tooltip"

import { GridIcon } from "@/components/icons"
import {
  deriveHostStatus,
  formatPercent,
  formatRelative,
  severityLevel,
  type HostStatus,
  type SeverityLevel,
} from "./format"
import type { HostRow } from "./host-table"

interface FleetGridProps {
  hosts: ReadonlyArray<HostRow>
}

type CellTone = SeverityLevel | "stale"

const CELL_BG: Record<CellTone, string> = {
  ok: "bg-[color-mix(in_oklab,var(--severity-info)_72%,transparent)] hover:bg-[var(--severity-info)]",
  warn: "bg-[color-mix(in_oklab,var(--severity-warn)_72%,transparent)] hover:bg-[var(--severity-warn)]",
  crit: "bg-[color-mix(in_oklab,var(--severity-error)_72%,transparent)] hover:bg-[var(--severity-error)]",
  stale:
    "bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--muted-foreground)_24%,transparent)_0_3px,transparent_3px_6px)] hover:bg-muted-foreground/30",
}

const CELL_RING: Record<CellTone, string> = {
  ok: "ring-[color-mix(in_oklab,var(--severity-info)_40%,transparent)]",
  warn: "ring-[color-mix(in_oklab,var(--severity-warn)_40%,transparent)]",
  crit: "ring-[color-mix(in_oklab,var(--severity-error)_40%,transparent)]",
  stale: "ring-border/40",
}

const SORT_OPTIONS = [
  { value: "worst", label: "Worst first" },
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
  { value: "disk", label: "Disk" },
  { value: "name", label: "Name" },
] as const

type SortKey = (typeof SORT_OPTIONS)[number]["value"]

interface AnnotatedHost {
  host: HostRow
  worst: number
  status: HostStatus
  tone: CellTone
}

function annotate(host: HostRow): AnnotatedHost {
  const status = deriveHostStatus(host.lastSeen)
  const worst = Math.max(host.cpuPct ?? 0, host.memoryPct ?? 0, host.diskPct ?? 0)
  const tone: CellTone = status === "active" ? severityLevel(worst) : "stale"
  return { host, worst, status, tone }
}

function sortHosts(rows: ReadonlyArray<AnnotatedHost>, key: SortKey): AnnotatedHost[] {
  const copy = [...rows]
  switch (key) {
    case "worst":
      copy.sort((a, b) => b.worst - a.worst)
      break
    case "cpu":
      copy.sort((a, b) => (b.host.cpuPct ?? 0) - (a.host.cpuPct ?? 0))
      break
    case "memory":
      copy.sort((a, b) => (b.host.memoryPct ?? 0) - (a.host.memoryPct ?? 0))
      break
    case "disk":
      copy.sort((a, b) => (b.host.diskPct ?? 0) - (a.host.diskPct ?? 0))
      break
    case "name":
      copy.sort((a, b) => a.host.hostName.localeCompare(b.host.hostName))
      break
  }
  return copy
}

export function FleetGrid({ hosts }: FleetGridProps) {
  const [sortKey, setSortKey] = useState<SortKey>("worst")

  const annotated = useMemo(() => hosts.map(annotate), [hosts])
  const sorted = useMemo(() => sortHosts(annotated, sortKey), [annotated, sortKey])

  const counts = useMemo(() => {
    const c: Record<CellTone, number> = { ok: 0, warn: 0, crit: 0, stale: 0 }
    for (const a of annotated) c[a.tone]++
    return c
  }, [annotated])

  return (
    <section className="space-y-3 rounded-lg border bg-card/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <GridIcon size={14} />
          <span className="text-[11px] font-medium uppercase tracking-wider">Fleet</span>
          <span className="text-[11px]">
            {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
          </span>
        </div>
        <div
          role="tablist"
          aria-label="Sort fleet"
          className="flex items-center gap-0.5 rounded-md border bg-background/80 p-0.5"
        >
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={sortKey === opt.value}
              onClick={() => setSortKey(opt.value)}
              className={cn(
                "rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
                sortKey === opt.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(28px, 1fr))" }}
      >
        {sorted.map(({ host, status, tone, worst }) => (
          <Tooltip key={host.hostName}>
            <TooltipTrigger
              render={
                <Link
                  to="/infra/$hostName"
                  params={{ hostName: host.hostName }}
                  aria-label={`${host.hostName} — ${status}, worst ${formatPercent(worst)}`}
                />
              }
              className={cn(
                "aspect-square rounded-[4px] ring-1 ring-inset transition-all",
                "hover:scale-110 hover:ring-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground",
                CELL_BG[tone],
                CELL_RING[tone],
              )}
            />
            <TooltipContent
              side="top"
              className="space-y-1 text-xs"
            >
              <div className="font-mono font-medium">{host.hostName}</div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
                <span className="text-muted-foreground">CPU</span>
                <span>{formatPercent(host.cpuPct)}</span>
                <span className="text-muted-foreground">Memory</span>
                <span>{formatPercent(host.memoryPct)}</span>
                <span className="text-muted-foreground">Disk</span>
                <span>{formatPercent(host.diskPct)}</span>
              </div>
              <div className="border-t pt-1 text-[10px] text-muted-foreground">
                {status === "active" ? "Active" : status === "idle" ? "Idle" : "Down"}{" "}
                · last seen {formatRelative(host.lastSeen)}
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <LegendDot tone="ok" label="Healthy" count={counts.ok} />
        <LegendDot tone="warn" label="Elevated" count={counts.warn} />
        <LegendDot tone="crit" label="Saturated" count={counts.crit} />
        <LegendDot tone="stale" label="Stale" count={counts.stale} />
        <span className="ml-auto text-[10px]">Cell color = max(CPU, memory, disk)</span>
      </div>
    </section>
  )
}

function LegendDot({
  tone,
  label,
  count,
}: {
  tone: CellTone
  label: string
  count: number
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "size-2.5 rounded-[3px] ring-1 ring-inset",
          CELL_BG[tone],
          CELL_RING[tone],
        )}
      />
      <span>{label}</span>
      <span className="font-mono tabular-nums text-foreground/70">{count}</span>
    </span>
  )
}
