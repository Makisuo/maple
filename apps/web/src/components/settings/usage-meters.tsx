import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
import {
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  type IconComponent,
} from "@/components/icons"
import type { AggregatedUsage } from "@/lib/billing/usage"
import { formatUsage, usagePercentage } from "@/lib/billing/usage"
import type { PlanLimits } from "@/lib/billing/plans"
import { cn } from "@maple/ui/utils"

interface MeterRowProps {
  icon: IconComponent
  label: string
  usedGB: number
  limitGB: number
}

function MeterRow({ icon: Icon, label, usedGB, limitGB }: MeterRowProps) {
  const pct = usagePercentage(usedGB, limitGB)
  const isUnlimited = limitGB === Infinity
  const limitLabel = isUnlimited ? "Unlimited" : formatUsage(limitGB)

  return (
    <ProgressPrimitive.Root value={pct} className="flex flex-col gap-2">
      <div className="flex w-full items-center gap-2">
        <Icon size={14} className="text-muted-foreground shrink-0" />
        <ProgressPrimitive.Label className="text-xs font-medium">
          {label}
        </ProgressPrimitive.Label>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums font-mono">
          {formatUsage(usedGB)} / {limitLabel}
        </span>
      </div>
      <ProgressPrimitive.Track className="bg-muted h-1.5 relative flex w-full items-center overflow-x-hidden">
        <ProgressPrimitive.Indicator
          className={cn(
            "h-full transition-all",
            pct > 100
              ? "bg-destructive"
              : pct > 80
                ? "bg-amber-500"
                : "bg-primary",
          )}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

interface UsageMetersProps {
  usage: AggregatedUsage
  limits: PlanLimits
  billingPeriodLabel: string
}

export function UsageMeters({
  usage,
  limits,
  billingPeriodLabel,
}: UsageMetersProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Current Usage</CardTitle>
        <CardDescription>{billingPeriodLabel}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <MeterRow
          icon={FileIcon}
          label="Logs"
          usedGB={usage.logsGB}
          limitGB={limits.logsGB}
        />
        <MeterRow
          icon={PulseIcon}
          label="Traces"
          usedGB={usage.tracesGB}
          limitGB={limits.tracesGB}
        />
        <MeterRow
          icon={ChartLineIcon}
          label="Metrics"
          usedGB={usage.metricsGB}
          limitGB={limits.metricsGB}
        />
      </CardContent>
    </Card>
  )
}
