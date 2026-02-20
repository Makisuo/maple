import { Result, useAtomValue } from "@effect-atom/atom-react"
import {
  CircleWarningIcon,
  CirclePercentageIcon,
  ServerIcon,
  PulseIcon,
} from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type GetErrorsSummaryInput } from "@/api/tinybird/errors"
import { getErrorsSummaryResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`
  }
  return num.toLocaleString()
}

function formatPercentage(rate: number): string {
  if (rate < 0.01) {
    return "0%"
  }
  if (rate < 1) {
    return `${rate.toFixed(2)}%`
  }
  return `${rate.toFixed(1)}%`
}

interface ErrorsSummaryCardsProps {
  filters: GetErrorsSummaryInput
}

export function ErrorsSummaryCards({ filters }: ErrorsSummaryCardsProps) {
  const summaryResult = useAtomValue(getErrorsSummaryResultAtom({ data: filters }))

  return Result.builder(summaryResult)
    .onInitial(() => (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-32 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
    ))
    .onError(() => (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Total Errors", icon: CircleWarningIcon },
          { title: "Error Rate", icon: CirclePercentageIcon },
          { title: "Affected Services", icon: ServerIcon },
          { title: "Affected Traces", icon: PulseIcon },
        ].map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon size={16} className="text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground">Unable to load</div>
            </CardContent>
          </Card>
        ))}
      </div>
    ))
    .onSuccess((response, result) => {
      const summary = response.data
      const cardConfig = [
        {
          title: "Total Errors",
          value: summary?.totalErrors ?? 0,
          format: formatNumber,
          icon: CircleWarningIcon,
          description: "Error spans in time range",
        },
        {
          title: "Error Rate",
          value: summary?.errorRate ?? 0,
          format: formatPercentage,
          icon: CirclePercentageIcon,
          description: "Errors / total spans",
        },
        {
          title: "Affected Services",
          value: summary?.affectedServicesCount ?? 0,
          format: formatNumber,
          icon: ServerIcon,
          description: "Services with errors",
        },
        {
          title: "Affected Traces",
          value: summary?.affectedTracesCount ?? 0,
          format: formatNumber,
          icon: PulseIcon,
          description: "Traces containing errors",
        },
      ]

      return (
        <div className={`grid gap-4 md:grid-cols-2 lg:grid-cols-4 ${result.waiting ? "opacity-60" : ""}`}>
          {cardConfig.map((card) => (
            <Card key={card.title}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                <card.icon size={16} className="text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{card.format(card.value)}</div>
                <p className="text-xs text-muted-foreground">{card.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )
    })
    .render()
}
