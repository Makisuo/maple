import { useState } from "react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import { CheckIcon, CopyIcon, ServerIcon } from "@/components/icons"
import type { HostDetailSummaryResponse } from "@maple/domain/http"
import { formatRelative } from "./format"

interface HostMetadataPanelProps {
  summary: HostDetailSummaryResponse["data"]
}

interface RowProps {
  label: string
  value: string | null | undefined
  copyValue?: string
  mono?: boolean
  tooltip?: string
}

function Row({ label, value, copyValue, mono = true, tooltip }: RowProps) {
  const [copied, setCopied] = useState(false)
  if (!value) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue ?? value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const valueNode = (
    <span className={cn("text-right break-all text-foreground/80", mono ? "font-mono" : "")}>
      {value}
    </span>
  )

  return (
    <div className="group flex items-start justify-between gap-3 py-1.5">
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5 text-[11px]">
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger render={<span />} className="cursor-default">
              {valueNode}
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        ) : (
          valueNode
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy ${label}`}
          className={cn(
            "flex size-5 items-center justify-center rounded text-muted-foreground transition-all",
            "opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground",
            copied && "opacity-100 text-[var(--severity-info)]",
          )}
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
        </button>
      </div>
    </div>
  )
}

interface SectionProps {
  title: string
  children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
  return (
    <div className="space-y-0.5 py-2 first:pt-0 last:pb-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
        {title}
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  )
}

export function HostMetadataPanel({ summary }: HostMetadataPanelProps) {
  if (!summary) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ServerIcon size={14} className="text-muted-foreground" />
          Resource attributes
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        <Section title="Identity">
          <Row label="host.name" value={summary.hostName} />
        </Section>
        <Section title="Platform">
          <Row label="os.type" value={summary.osType} />
          <Row label="host.arch" value={summary.hostArch} />
        </Section>
        <Section title="Cloud">
          <Row label="cloud.provider" value={summary.cloudProvider} />
          <Row label="cloud.region" value={summary.cloudRegion} />
        </Section>
        <Section title="Lifecycle">
          <Row
            label="first seen"
            value={formatRelative(summary.firstSeen)}
            copyValue={summary.firstSeen}
            tooltip={summary.firstSeen}
            mono={false}
          />
          <Row
            label="last seen"
            value={formatRelative(summary.lastSeen)}
            copyValue={summary.lastSeen}
            tooltip={summary.lastSeen}
            mono={false}
          />
        </Section>
      </CardContent>
    </Card>
  )
}
