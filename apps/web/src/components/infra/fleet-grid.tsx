import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@maple/ui/components/ui/tooltip"

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
  ok: "bg-[color-mix(in_oklab,var(--severity-info)_55%,transparent)] hover:bg-[var(--severity-info)]",
  warn: "bg-[color-mix(in_oklab,var(--severity-warn)_70%,transparent)] hover:bg-[var(--severity-warn)]",
  crit: "bg-[color-mix(in_oklab,var(--severity-error)_72%,transparent)] hover:bg-[var(--severity-error)]",
  stale:
    "bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--muted-foreground)_18%,transparent)_0_3px,transparent_3px_6px)] hover:bg-muted-foreground/30",
}

const CELL_RING: Record<CellTone, string> = {
  ok: "ring-[color-mix(in_oklab,var(--severity-info)_30%,transparent)]",
  warn: "ring-[color-mix(in_oklab,var(--severity-warn)_35%,transparent)]",
  crit: "ring-[color-mix(in_oklab,var(--severity-error)_40%,transparent)]",
  stale: "ring-border/40",
}

const GLYPH_TONE: Record<CellTone, string> = {
  ok: "text-background/80",
  warn: "text-background/85",
  crit: "text-background/85",
  stale: "text-muted-foreground/60",
}

const SORT_OPTIONS = [
  { value: "worst", label: "Worst" },
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Mem" },
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
    <section aria-label="Fleet ribbon" className="rounded-md border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="text-[12px] font-medium text-foreground">Fleet</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[11px] text-muted-foreground">Sort</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSortKey(opt.value)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] transition-colors",
                sortKey === opt.value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-4">
        <div
          className="grid gap-[3px]"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(28px, 1fr))" }}
        >
          {sorted.map(({ host, status, tone, worst }, idx) => {
            const glyph = host.hostName.charAt(0).toUpperCase() || "·"
            return (
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
                    "group relative flex aspect-square items-center justify-center ring-1 ring-inset transition-all",
                    "hover:scale-[1.12] hover:z-10 hover:ring-foreground/40",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground",
                    CELL_BG[tone],
                    CELL_RING[tone],
                  )}
                  style={{ animationDelay: `${Math.min(idx * 6, 240)}ms` }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "font-mono text-[8px] font-semibold uppercase tracking-tight transition-opacity",
                      GLYPH_TONE[tone],
                      "opacity-60 group-hover:opacity-95",
                    )}
                  >
                    {glyph}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="space-y-1 text-xs">
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
                    {status === "active" ? "Active" : status === "idle" ? "Idle" : "Down"} ·{" "}
                    {formatRelative(host.lastSeen)}
                  </div>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <LegendDot tone="ok" label="Healthy" count={counts.ok} />
        <LegendDot tone="warn" label="Elevated" count={counts.warn} />
        <LegendDot tone="crit" label="Saturated" count={counts.crit} />
        <LegendDot tone="stale" label="Stale" count={counts.stale} />
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          cell = max(cpu, memory, disk)
        </span>
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
          "size-2 rounded-[2px] ring-1 ring-inset",
          CELL_BG[tone],
          CELL_RING[tone],
        )}
      />
      <span>{label}</span>
      <span className="tabular-nums text-foreground/70">{count}</span>
    </span>
  )
}
