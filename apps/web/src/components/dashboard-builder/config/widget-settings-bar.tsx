import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/utils"
import { chartRegistry } from "@maple/ui/components/charts/registry"
import type { ValueUnit, VisualizationType } from "@/components/dashboard-builder/types"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"
import type { StatAggregate } from "@/lib/query-builder/widget-builder-utils"

export type LegendPosition = "bottom" | "right" | "hidden"

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

const VISUALIZATION_OPTIONS: Array<{ value: VisualizationType; label: string }> = [
  { value: "chart", label: "Chart" },
  { value: "stat", label: "Stat" },
  { value: "table", label: "Table" },
  { value: "list", label: "List" },
]

export function WidgetSettingsBar() {
  const {
    state,
    actions: { setState },
    meta: { seriesFieldOptions },
  } = useWidgetBuilder()

  const {
    visualization,
    title,
    description,
    chartId,
    stacked,
    curveType,
    comparisonMode,
    includePercentChange,
    debug,
    statAggregate,
    statValueField,
    unit,
    tableLimit,
    legendPosition,
  } = state

  const onChange = (updates: Record<string, unknown>) =>
    setState((current) => ({ ...current, ...updates }))

  const isChart = visualization === "chart"
  const isStat = visualization === "stat"
  const isTable = visualization === "table"
  const isList = visualization === "list"

  const chartStyleOptions = isChart
    ? chartRegistry
        .filter((chart) => chart.tags?.includes("query-builder"))
        .map((chart) => ({
          ...chart,
          name: chart.category === "line" ? "Line" : chart.category === "bar" ? "Bar" : chart.category === "area" ? "Area" : chart.name,
        }))
    : []

  const chartCategory = isChart ? chartRegistry.find((c) => c.id === chartId)?.category : undefined
  const showStackedToggle = isChart && (chartCategory === "bar" || chartCategory === "area")
  const showCurveToggle = isChart && (chartCategory === "line" || chartCategory === "area")

  const effectiveStatValueField =
    isStat &&
    seriesFieldOptions.length > 0 &&
    (!statValueField || !seriesFieldOptions.includes(statValueField))
      ? seriesFieldOptions[0]
      : statValueField

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        Panel Options
      </p>

      {/* Name */}
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Name
        </p>
        <Input
          value={title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="Untitled widget"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Description
        </p>
        <textarea
          value={description}
          onChange={(event) => onChange({ description: event.target.value })}
          placeholder="Add a description..."
          rows={2}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
        />
      </div>

      <div className="h-px bg-border" />

      {/* Type */}
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Type
        </p>
        <div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
          {VISUALIZATION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange({ visualization: opt.value })}
              className={cn(
                "flex-1 text-xs rounded-sm transition-colors",
                visualization === opt.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isChart && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Chart Style
          </p>
          <Select
            items={Object.fromEntries(chartStyleOptions.map((c) => [c.id, c.name]))}
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

      {showStackedToggle && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Layout
          </p>
          <div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => onChange({ stacked: false })}
              className={cn(
                "flex-1 text-xs rounded-sm transition-colors",
                !stacked
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {chartCategory === "bar" ? "Grouped" : "Overlapping"}
            </button>
            <button
              type="button"
              onClick={() => onChange({ stacked: true })}
              className={cn(
                "flex-1 text-xs rounded-sm transition-colors",
                stacked
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Stacked
            </button>
          </div>
        </div>
      )}

      {showCurveToggle && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Curve
          </p>
          <div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => onChange({ curveType: "linear" })}
              className={cn(
                "flex-1 text-xs rounded-sm transition-colors",
                curveType === "linear"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Linear
            </button>
            <button
              type="button"
              onClick={() => onChange({ curveType: "monotone" })}
              className={cn(
                "flex-1 text-xs rounded-sm transition-colors",
                curveType === "monotone"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Smooth
            </button>
          </div>
        </div>
      )}

      {(isChart || isStat) && <div className="h-px bg-border" />}

      {/* Y-Axis Unit (for chart) / Unit (for stat) */}
      {(isChart || isStat) && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {isChart ? "Y-Axis Unit" : "Unit"}
          </p>
          <Select
            items={UNIT_OPTIONS}
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
      )}

      {/* Legend position (chart only) */}
      {isChart && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Legend
          </p>
          <div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
            {(["bottom", "right", "hidden"] as const).map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => onChange({ legendPosition: pos })}
                className={cn(
                  "flex-1 text-xs rounded-sm transition-colors capitalize",
                  legendPosition === pos
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {pos === "hidden" ? "Hidden" : pos === "right" ? "Right" : "Bottom"}
              </button>
            ))}
          </div>
        </div>
      )}

      {isStat && (
        <>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Aggregate
            </p>
            <Select
              items={{ first: "first", sum: "sum", count: "count", avg: "avg", max: "max", min: "min" }}
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

          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Value Field
            </p>
            <Select
              value={effectiveStatValueField || seriesFieldOptions[0]}
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
        </>
      )}

      {isTable && (
        <div className="space-y-1.5">
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

      {!isList && (
        <>
          <div className="h-px bg-border" />

          {/* Comparison */}
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Comparison
            </p>
            <Select
              items={{ none: "None", previous_period: "Previous period" }}
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

          <div className="h-px bg-border" />

          {/* Checkboxes */}
          <div className="flex flex-col gap-3">
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
                className="text-xs text-muted-foreground"
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
                className="text-xs text-muted-foreground"
              >
                Debug
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
