import { Suspense, type ComponentType } from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

interface ChartPreviewProps {
  component: ComponentType<{ className?: string }>
}

export function ChartPreview({ component: Component }: ChartPreviewProps) {
  return (
    <div className="aspect-[4/3] w-full overflow-hidden">
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <Component className="h-full w-full aspect-auto" />
      </Suspense>
    </div>
  )
}
