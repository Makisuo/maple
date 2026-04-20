import * as React from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Kbd, KbdGroup } from "@maple/ui/components/ui/kbd"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { cn } from "@maple/ui/lib/utils"

interface IssueCommentComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  className?: string
}

export function IssueCommentComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  className,
}: IssueCommentComposerProps) {
  const canSubmit = !disabled && value.trim().length > 0

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (canSubmit) onSubmit()
    }
  }

  return (
    <div className={cn("mt-4 space-y-2", className)}>
      <Textarea
        id="comment-input"
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Context, findings, links…"
        disabled={disabled}
        className="resize-y"
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
          <span className="ml-1">to comment</span>
        </KbdGroup>
        <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
          Comment
        </Button>
      </div>
    </div>
  )
}
