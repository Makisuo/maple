import { toast } from "sonner"
import { ChevronRightIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import { CollapsibleJsonValue } from "./json-value"

export function CopyableValue({
  value,
  children,
  className,
}: {
  value: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors",
        className
      )}
      onClick={() => {
        navigator.clipboard.writeText(value)
        toast.success("Copied to clipboard")
      }}
      title="Click to copy"
    >
      {children ?? value}
    </span>
  )
}

export function tryParseJson(value: string): unknown | null {
  const trimmed = value.trimStart()
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function AttributesTable({ attributes, title }: { attributes: Record<string, string>; title: string }) {
  const entries = Object.entries(attributes)

  if (entries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-2">
        No {title.toLowerCase()} available
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="rounded-md border divide-y">
        {entries.map(([key, value]) => {
          const parsed = tryParseJson(value)
          return (
            <div key={key} className="px-2 py-1.5">
              <div className="font-mono text-[11px] text-muted-foreground mb-0.5">
                <CopyableValue value={key}>{key}</CopyableValue>
              </div>
              <div className="font-mono text-xs break-all">
                {parsed !== null ? (
                  <CollapsibleJsonValue value={value} parsed={parsed} />
                ) : (
                  <CopyableValue value={value}>{value}</CopyableValue>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function partitionResourceAttributes(attrs: Record<string, string>) {
  const standard: Record<string, string> = {}
  const internal: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("maple_")) {
      internal[key] = value
    } else {
      standard[key] = value
    }
  }
  return { standard, internal }
}

export function ResourceAttributesSection({ attributes }: { attributes: Record<string, string> }) {
  const { standard, internal } = partitionResourceAttributes(attributes)
  const internalCount = Object.keys(internal).length

  return (
    <div className="space-y-2">
      <AttributesTable attributes={standard} title="Resource Attributes" />
      {internalCount > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors group">
            <ChevronRightIcon size={10} className="transition-transform group-data-[state=open]:rotate-90" />
            Maple Internal ({internalCount})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1">
              <AttributesTable attributes={internal} title="Maple Internal" />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
