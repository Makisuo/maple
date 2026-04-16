import { toast } from "sonner"
import { cn } from "@maple/ui/utils"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@maple/ui/components/ui/hover-card"
import { tryParseJson, CopyableValue } from "@/components/attributes"
import { CollapsibleJsonValue } from "@/components/attributes/json-value"
import type { ChipTone } from "@/lib/log-attributes"

const TONE_CLASSES: Record<ChipTone, string> = {
  error:
    "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15",
  warn:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/15",
  info: "bg-muted text-foreground/80 border-border hover:bg-muted/80",
  muted:
    "bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted/70",
}

const MAX_VALUE_CHARS = 24

function truncateValue(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value
  return value.slice(0, MAX_VALUE_CHARS - 1) + "…"
}

function shortKey(key: string): string {
  if (key === "http.status_code" || key === "http.response.status_code") return "status"
  if (key === "http.method" || key === "http.request.method") return "method"
  if (key === "http.url" || key === "url.full") return "url"
  if (key === "http.route" || key === "url.path") return "path"
  return key
}

export interface LogAttributeChipProps {
  attrKey: string
  value: string
  tone: ChipTone
}

export function LogAttributeChip({ attrKey, value, tone }: LogAttributeChipProps) {
  const clipboard = useClipboard()
  const parsed = tryParseJson(value)
  const displayValue = parsed !== null ? "{…}" : truncateValue(value)
  const displayKey = shortKey(attrKey)

  const handleCopy = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    clipboard.copy(`${attrKey}=${value}`)
    toast.success(`Copied ${attrKey}`)
  }

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleCopy}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                handleCopy(e)
              }
            }}
            className={cn(
              "inline-flex items-center gap-1 h-[18px] px-1.5 rounded border text-[10px] font-mono leading-none whitespace-nowrap shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              TONE_CLASSES[tone],
            )}
            title={`${attrKey}=${value}`}
          />
        }
      >
        <span className="opacity-70">{displayKey}</span>
        <span className="opacity-40">:</span>
        <span>{displayValue}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 p-0">
        <div className="px-3 py-2 border-b">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Attribute
          </div>
          <div className="font-mono text-xs break-all">
            <CopyableValue value={attrKey}>{attrKey}</CopyableValue>
          </div>
        </div>
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Value
          </div>
          <div className="font-mono text-xs break-all">
            {parsed !== null ? (
              <CollapsibleJsonValue value={value} parsed={parsed} />
            ) : (
              <CopyableValue value={value}>{value}</CopyableValue>
            )}
          </div>
        </div>
        <div className="px-3 py-2 border-t bg-muted/30 rounded-b-xl">
          <button
            type="button"
            disabled
            className="text-[11px] text-muted-foreground/60 cursor-not-allowed"
            title="Coming soon"
          >
            Pin as column · Coming soon
          </button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
