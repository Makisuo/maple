import * as React from "react"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"

interface TraceTimelineSearchProps {
  query: string
  onQueryChange: (query: string) => void
  matchCount: number
  totalCount: number
  inputRef: React.RefObject<HTMLInputElement | null>
}

export function TraceTimelineSearch({
  query,
  onQueryChange,
  matchCount,
  totalCount,
  inputRef,
}: TraceTimelineSearchProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
      <MagnifierIcon size={13} className="text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search spans..."
        className="flex-1 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground/50 outline-none"
      />
      {query && (
        <>
          <span className="text-[10px] font-mono text-muted-foreground shrink-0 tabular-nums">
            {matchCount} of {totalCount}
          </span>
          <button
            onClick={() => onQueryChange("")}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <XmarkIcon size={12} />
          </button>
        </>
      )}
    </div>
  )
}
