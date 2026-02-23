import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import { chartRegistry } from "@maple/ui/components/charts/registry"
import type { ValueUnit } from "@/components/dashboard-builder/types"

type StatAggregate = "sum" | "first" | "count" | "avg" | "max" | "min"

const UNIT_OPTIONS: Array<{ value: ValueUnit; label: string }> = [
  { value: "none", label: "None" },
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "duration_ms", label: "Duration (ms)" },
  { value: "duration_us", label: "Duration (us)" },
  { value: "bytes", label: "Bytes" },
  { value: "requests_per_sec", label: "Requests/sec" },
  { value: "short", label: "Short" },
]

interface WidgetSettingsBarProps {
  visualization: string
  chartId: string
  comparisonMode: "none" | "previous_period"
  includePercentChange: boolean
  debug: boolean
  statAggregate: StatAggregate
  statValueField: string
  unit: ValueUnit
  tableLimit: string
  seriesFieldOptions: string[]
  onChange: (updates: Record<string, unknown>) => void
}

export function WidgetSettingsBar({
  visualization,
  chartId,
  comparisonMode,
  includePercentChange,
  debug,
  statAggregate,
  statValueField,
  unit,
  tableLimit,
  seriesFieldOptions,
  onChange,
}: WidgetSettingsBarProps) {
  const isChart = visualization === "chart"
  const isStat = visualization === "stat"
  const isTable = visualization === "table"

  const chartStyleOptions = isChart
    ? chartRegistry.filter(
        (chart) => chart.id === "query-builder-line" || chart.id === chartId,
      )
    : []

  return (
    <div className="flex flex-wrap items-end gap-4">
      {isChart && (
        <div className="space-y-1 w-48">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Chart Style
          </p>
          <Select
            value={chartId}
            onValueChange={(value) => onChange({ chartId: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {chartStyleOptions.map((chart) => (
                <SelectItem key={chart.id} value={chart.id}>
                  {chart.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1 w-48">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Comparison
        </p>
        <Select
          value={comparisonMode}
          onValueChange={(value) =>
            onChange({
              comparisonMode:
                value === "previous_period" ? "previous_period" : "none",
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="previous_period">Previous period</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isStat && (
        <>
          <div className="space-y-1 w-36">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Aggregate
            </p>
            <Select
              value={statAggregate}
              onValueChange={(value) =>
                onChange({ statAggregate: value as StatAggregate })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first">first</SelectItem>
                <SelectItem value="sum">sum</SelectItem>
                <SelectItem value="count">count</SelectItem>
                <SelectItem value="avg">avg</SelectItem>
                <SelectItem value="max">max</SelectItem>
                <SelectItem value="min">min</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1 w-48">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Value Field
            </p>
            <Select
              value={statValueField || seriesFieldOptions[0]}
              onValueChange={(value) => onChange({ statValueField: value })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select series" />
              </SelectTrigger>
              <SelectContent>
                {seriesFieldOptions.map((field) => (
                  <SelectItem key={field} value={field}>
                    {field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1 w-40">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Unit
            </p>
            <Select
              value={unit}
              onValueChange={(value) =>
                onChange({ unit: value as ValueUnit })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {isTable && (
        <div className="space-y-1 w-36">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Row Limit
          </p>
          <Input
            value={tableLimit}
            onChange={(event) => onChange({ tableLimit: event.target.value })}
            placeholder="50"
            type="number"
            min={1}
          />
        </div>
      )}

      <div className="flex items-center gap-4 ml-auto">
        <div className="flex items-center gap-2">
          <Checkbox
            id="qb-percent-change"
            checked={includePercentChange}
            disabled={comparisonMode === "none"}
            onCheckedChange={(checked) =>
              onChange({ includePercentChange: checked === true })
            }
          />
          <label
            htmlFor="qb-percent-change"
            className="text-[11px] text-muted-foreground"
          >
            % change
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="qb-debug"
            checked={debug}
            onCheckedChange={(checked) =>
              onChange({ debug: checked === true })
            }
          />
          <label
            htmlFor="qb-debug"
            className="text-[11px] text-muted-foreground"
          >
            Debug
          </label>
        </div>
      </div>
    </div>
  )
}
