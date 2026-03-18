import { getHttpInfo, HTTP_METHOD_COLORS } from "@maple/ui/lib/http"
import { cn } from "@maple/ui/utils"

interface HttpSpanLabelProps {
  spanName: string
  spanAttributes?: Record<string, string>
  className?: string
  textClassName?: string
}

export function HttpSpanLabel({
  spanName,
  spanAttributes,
  className,
  textClassName,
}: HttpSpanLabelProps) {
  const httpInfo = getHttpInfo(spanName, spanAttributes ?? {})

  if (!httpInfo) {
    return (
      <span className={cn("truncate", className, textClassName)} title={spanName}>
        {spanName}
      </span>
    )
  }

  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5 font-mono", className)}
      title={httpInfo.route || spanName}
    >
      <span
        className={cn(
          "shrink-0 rounded px-1 py-0.5 text-[10px] font-bold leading-none text-white",
          HTTP_METHOD_COLORS[httpInfo.method] || "bg-[#5A5248]",
        )}
      >
        {httpInfo.method}
      </span>
      <span className={cn("truncate", textClassName)}>
        {httpInfo.route || spanName}
      </span>
    </span>
  )
}
