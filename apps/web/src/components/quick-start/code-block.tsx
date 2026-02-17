import { useState } from "react"
import { toast } from "sonner"
import { CopyIcon, CheckIcon } from "@/components/icons"
import { cn } from "@/lib/utils"

interface CodeBlockProps {
  code: string
  language?: string
  className?: string
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

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
    <div className={cn("relative rounded-md bg-muted", className)}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
        {language && (
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? (
            <CheckIcon size={14} className="text-emerald-500 animate-in zoom-in-50 duration-200" />
          ) : (
            <CopyIcon size={14} />
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}
