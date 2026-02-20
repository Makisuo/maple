import { useState } from "react"
import { toast } from "sonner"
import { CopyIcon, CheckIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { highlightCode } from "@/lib/sugar-high"

interface CodeBlockProps {
  code: string
  language?: string
  className?: string
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const highlighted = highlightCode(code)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      toast.success("Copied to clipboard")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Failed to copy")
    }
  }

  return (
    <div className={cn("relative overflow-clip rounded-md border border-border bg-muted", className)}>
      <div className="flex items-center justify-between px-3 py-1.5 text-muted-foreground">
        {language && (
          <span className="text-[10px] font-medium uppercase tracking-wider">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="ml-auto flex items-center gap-1 text-xs hover:text-foreground transition-colors"
        >
          {copied ? (
            <CheckIcon size={14} className="text-emerald-500 animate-in zoom-in-50 duration-200" />
          ) : (
            <CopyIcon size={14} />
          )}
        </button>
      </div>
      <div className="overflow-x-auto bg-background/50 p-3">
        <pre className="text-xs leading-relaxed">
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      </div>
    </div>
  )
}
