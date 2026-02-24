import { useState, useMemo } from "react"
import { toast } from "sonner"
import { ChevronRightIcon, CopyIcon } from "@/components/icons"
import { highlightCode } from "@/lib/sugar-high"

interface CollapsibleJsonValueProps {
  value: string
  parsed: unknown
}

export function CollapsibleJsonValue({ value, parsed }: CollapsibleJsonValueProps) {
  const [expanded, setExpanded] = useState(false)

  const highlighted = useMemo(() => {
    if (!expanded) return ""
    const pretty = JSON.stringify(parsed, null, 2)
    return highlightCode(pretty)
  }, [expanded, parsed])

  const preview = value.length > 80 ? value.slice(0, 80) + "…" : value

  return (
    <div>
      <button
        type="button"
        className="flex items-start gap-1 w-full text-left font-mono text-xs break-all cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "Collapse" : "Expand JSON"}
      >
        <ChevronRightIcon
          size={12}
          className={`shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        {!expanded && <span>{preview}</span>}
        {expanded && <span className="text-muted-foreground">JSON</span>}
      </button>
      {expanded && (
        <div className="mt-1 rounded-md bg-muted/30 border overflow-hidden">
          <div className="flex items-center justify-end px-2 py-1 border-b">
            <button
              type="button"
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                navigator.clipboard.writeText(value)
                toast.success("Copied to clipboard")
              }}
            >
              <CopyIcon size={10} />
              Copy
            </button>
          </div>
          <div className="max-h-64 overflow-auto p-2">
            <pre className="text-xs leading-relaxed">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
