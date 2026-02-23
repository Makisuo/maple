import * as React from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
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
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"
import {
  AGGREGATIONS_BY_SOURCE,
  GROUP_BY_OPTIONS,
  QUERY_BUILDER_METRIC_TYPES,
  queryBadgeColor,
  type QueryBuilderAddOnKey,
  type QueryBuilderDataSource,
  type QueryBuilderMetricType,
  type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricSelectionOption {
  value: string
  label: string
}

interface AutocompleteValues {
  traces: WhereClauseAutocompleteValues
  logs: WhereClauseAutocompleteValues
  metrics: WhereClauseAutocompleteValues
}

interface QueryPanelProps {
  query: QueryBuilderQueryDraft
  index: number
  collapsed: boolean
  canRemove: boolean
  metricSelectionOptions: MetricSelectionOption[]
  autocompleteValues: AutocompleteValues
  onUpdate: (updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => void
  onClone: () => void
  onRemove: () => void
  onToggleCollapse: () => void
  onDataSourceChange: (ds: QueryBuilderDataSource) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMetricSelection(raw: string): {
  metricName: string
  metricType: QueryBuilderMetricType
} | null {
  const [metricName, metricType] = raw.split("::")
  if (!metricName || !metricType) return null
  if (
    !QUERY_BUILDER_METRIC_TYPES.includes(metricType as QueryBuilderMetricType)
  )
    return null
  return { metricName, metricType: metricType as QueryBuilderMetricType }
}

const ADD_ON_KEYS: { key: QueryBuilderAddOnKey; label: string }[] = [
  { key: "groupBy", label: "Group By" },
  { key: "having", label: "Having" },
  { key: "orderBy", label: "Order By" },
  { key: "limit", label: "Limit" },
  { key: "legend", label: "Legend" },
]

// ---------------------------------------------------------------------------
// GroupByAutocomplete (inline)
// ---------------------------------------------------------------------------

function GroupByAutocomplete({
  value,
  onChange,
  dataSource,
}: {
  value: string
  onChange: (value: string) => void
  dataSource: QueryBuilderDataSource
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [isFocused, setIsFocused] = React.useState(false)
  const [isDismissed, setIsDismissed] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)

  const suggestions = React.useMemo(() => {
    const query = value.toLowerCase()
    const options = GROUP_BY_OPTIONS[dataSource].map((opt) => ({
      label: opt.label,
      value: opt.value,
    }))
    if (!query) return options
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query),
    )
  }, [value, dataSource])

  const isOpen = isFocused && !isDismissed && suggestions.length > 0

  React.useEffect(() => {
    setActiveIndex(0)
  }, [suggestions.length, value])

  const applySuggestion = React.useCallback(
    (index: number) => {
      const suggestion = suggestions[index]
      if (!suggestion) return
      onChange(suggestion.value)
      setIsDismissed(true)
    },
    [suggestions, onChange],
  )

  return (
    <div className="relative flex-1 min-w-[140px]">
      <Input
        ref={inputRef}
        value={value}
        placeholder="service.name"
        className="h-8 text-xs"
        onFocus={() => {
          setIsFocused(true)
          setIsDismissed(false)
        }}
        onBlur={() => setIsFocused(false)}
        onChange={(event) => {
          onChange(event.target.value)
          setIsDismissed(false)
        }}
        onKeyDown={(event) => {
          if (!isOpen || suggestions.length === 0) return
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setActiveIndex((c) => (c + 1) % suggestions.length)
            return
          }
          if (event.key === "ArrowUp") {
            event.preventDefault()
            setActiveIndex(
              (c) => (c - 1 + suggestions.length) % suggestions.length,
            )
            return
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault()
            applySuggestion(activeIndex)
            return
          }
          if (event.key === "Escape") {
            event.preventDefault()
            setIsDismissed(true)
          }
        }}
      />
      {isOpen && (
        <div
          role="listbox"
          aria-label="Group by suggestions"
          className="absolute z-50 mt-1 max-h-52 w-full overflow-auto border bg-popover text-popover-foreground shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.value}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center px-2 py-1 text-left text-xs font-mono",
                index === activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/60",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applySuggestion(index)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// QueryPanel
// ---------------------------------------------------------------------------

export function QueryPanel({
  query,
  index,
  collapsed,
  canRemove,
  metricSelectionOptions,
  autocompleteValues,
  onUpdate,
  onClone,
  onRemove,
  onToggleCollapse,
  onDataSourceChange,
}: QueryPanelProps) {
  const badgeColor = queryBadgeColor(index)
  const aggregateOptions = AGGREGATIONS_BY_SOURCE[query.dataSource]

  const metricValue =
    query.metricName && query.metricType
      ? `${query.metricName}::${query.metricType}`
      : undefined

  const isMetrics = query.dataSource === "metrics"

  return (
    <div className="border rounded-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0"
          aria-label={collapsed ? "Expand query" : "Collapse query"}
        >
          {collapsed ? "\u25B6" : "\u25BC"}
        </button>

        <Checkbox
          id={`query-enabled-${query.id}`}
          checked={query.enabled}
          onCheckedChange={(checked) =>
            onUpdate((current) => ({
              ...current,
              enabled: checked === true,
            }))
          }
          className="shrink-0"
        />

        <Badge
          variant="outline"
          className={cn(
            "font-mono text-[11px] text-white border-0 shrink-0",
            badgeColor,
          )}
        >
          {query.name}
        </Badge>

        <Select
          value={query.dataSource}
          onValueChange={(value) =>
            onDataSourceChange(value as QueryBuilderDataSource)
          }
        >
          <SelectTrigger className="h-7 w-24 text-xs border-none bg-transparent shadow-none px-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="traces">Traces</SelectItem>
            <SelectItem value="logs">Logs</SelectItem>
            <SelectItem value="metrics">Metrics</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <Button variant="ghost" size="xs" onClick={onClone}>
          Clone
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={onRemove}
          disabled={!canRemove}
        >
          Remove
        </Button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="px-3 py-3 space-y-3">
          {isMetrics ? (
            <MetricsBody
              query={query}
              aggregateOptions={aggregateOptions}
              metricValue={metricValue}
              metricSelectionOptions={metricSelectionOptions}
              autocompleteValues={autocompleteValues}
              onUpdate={onUpdate}
            />
          ) : (
            <TracesLogsBody
              query={query}
              aggregateOptions={aggregateOptions}
              autocompleteValues={autocompleteValues}
              onUpdate={onUpdate}
            />
          )}

          {/* Add-on toggle bar */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-dashed">
            {ADD_ON_KEYS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() =>
                  onUpdate((current) => ({
                    ...current,
                    addOns: {
                      ...current.addOns,
                      [key]: !current.addOns[key],
                    },
                  }))
                }
                className={cn(
                  "px-2 py-0.5 text-[11px] rounded-sm border transition-colors",
                  query.addOns[key]
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "bg-muted/40 border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Expanded add-on sections */}
          <AddOnSections query={query} onUpdate={onUpdate} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TracesLogsBody
// ---------------------------------------------------------------------------

function TracesLogsBody({
  query,
  aggregateOptions,
  autocompleteValues,
  onUpdate,
}: {
  query: QueryBuilderQueryDraft
  aggregateOptions: Array<{ label: string; value: string }>
  autocompleteValues: AutocompleteValues
  onUpdate: (
    updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft,
  ) => void
}) {
  return (
    <>
      {/* Row 1: Where clause */}
      <div className="flex items-start gap-2">
        <WhereClauseEditor
          rows={1}
          value={query.whereClause}
          dataSource={query.dataSource}
          values={autocompleteValues[query.dataSource]}
          onChange={(nextWhereClause) =>
            onUpdate((current) => ({
              ...current,
              whereClause: nextWhereClause,
            }))
          }
          placeholder='service.name = "checkout" AND status.code = "Error"'
          textareaClassName="min-h-[32px] resize-y text-xs"
          ariaLabel={`Where clause for query ${query.name}`}
        />
        {query.dataSource === "traces" && (
          <Select
            value={
              query.whereClause.includes("root_only = true")
                ? "root"
                : "all"
            }
            onValueChange={(value) =>
              onUpdate((current) => {
                const stripped = current.whereClause
                  .replace(/\s*AND\s*root_only\s*=\s*\w+/gi, "")
                  .replace(/root_only\s*=\s*\w+\s*AND\s*/gi, "")
                  .replace(/root_only\s*=\s*\w+/gi, "")
                  .trim()
                const clause =
                  value === "root"
                    ? stripped
                      ? `${stripped} AND root_only = true`
                      : "root_only = true"
                    : stripped
                return { ...current, whereClause: clause }
              })
            }
          >
            <SelectTrigger className="h-8 w-[120px] text-xs shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Spans</SelectItem>
              <SelectItem value="root">Root Spans</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Row 2: Aggregation + interval */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select
          value={query.aggregation}
          onValueChange={(value) =>
            onUpdate((current) => ({
              ...current,
              aggregation: value ?? current.aggregation,
            }))
          }
        >
          <SelectTrigger className="h-8 w-[160px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {aggregateOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground">every</span>

        <Input
          value={query.stepInterval}
          onChange={(event) =>
            onUpdate((current) => ({
              ...current,
              stepInterval: event.target.value,
            }))
          }
          placeholder="Auto"
          className="h-8 w-20 text-xs"
        />

        <span className="text-xs text-muted-foreground">seconds</span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// MetricsBody
// ---------------------------------------------------------------------------

function MetricsBody({
  query,
  aggregateOptions,
  metricValue,
  metricSelectionOptions,
  autocompleteValues,
  onUpdate,
}: {
  query: QueryBuilderQueryDraft
  aggregateOptions: Array<{ label: string; value: string }>
  metricValue: string | undefined
  metricSelectionOptions: MetricSelectionOption[]
  autocompleteValues: AutocompleteValues
  onUpdate: (
    updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft,
  ) => void
}) {
  const groupByDisplay =
    !query.addOns.groupBy || !query.groupBy.trim() || query.groupBy === "none"
      ? "Everything (no breakdown)"
      : query.groupBy

  return (
    <>
      {/* Row 1: Metric type + name */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground shrink-0">Metric</span>
        <Select
          value={metricValue}
          onValueChange={(value) => {
            const parsed = value ? parseMetricSelection(value) : null
            if (!parsed) return
            onUpdate((current) => ({
              ...current,
              metricName: parsed.metricName,
              metricType: parsed.metricType,
            }))
          }}
        >
          <SelectTrigger className="h-8 flex-1 text-xs">
            <SelectValue placeholder="Select metric" />
          </SelectTrigger>
          <SelectContent>
            {metricSelectionOptions.length === 0 ? (
              <SelectItem value="__none__" disabled>
                No metrics available
              </SelectItem>
            ) : (
              metricSelectionOptions.map((metric) => (
                <SelectItem key={metric.value} value={metric.value}>
                  {metric.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Row 2: Where clause */}
      <WhereClauseEditor
        rows={1}
        value={query.whereClause}
        dataSource={query.dataSource}
        values={autocompleteValues.metrics}
        onChange={(nextWhereClause) =>
          onUpdate((current) => ({
            ...current,
            whereClause: nextWhereClause,
          }))
        }
        placeholder='service.name = "my-service"'
        textareaClassName="min-h-[32px] resize-y text-xs"
        ariaLabel={`Where clause for query ${query.name}`}
      />

      {/* Row 3: AGGREGATE WITHIN TIME SERIES */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
          Aggregate within time series
        </span>
        <Select
          value={query.aggregation}
          onValueChange={(value) =>
            onUpdate((current) => ({
              ...current,
              aggregation: value ?? current.aggregation,
            }))
          }
        >
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {aggregateOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground">every</span>

        <Input
          value={query.stepInterval}
          onChange={(event) =>
            onUpdate((current) => ({
              ...current,
              stepInterval: event.target.value,
            }))
          }
          placeholder="Auto"
          className="h-8 w-20 text-xs"
        />

        <span className="text-xs text-muted-foreground">seconds</span>
      </div>

      {/* Row 4: AGGREGATE ACROSS TIME SERIES */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
          Aggregate across time series
        </span>

        <Select
          value={query.aggregation}
          onValueChange={(value) =>
            onUpdate((current) => ({
              ...current,
              aggregation: value ?? current.aggregation,
            }))
          }
        >
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {aggregateOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground">by</span>

        <Select
          value={
            !query.addOns.groupBy ||
            !query.groupBy.trim() ||
            query.groupBy === "none"
              ? "__none__"
              : query.groupBy
          }
          onValueChange={(value) => {
            if (!value) return
            onUpdate((current) => ({
              ...current,
              groupBy: value === "__none__" ? "none" : value,
              addOns: { ...current.addOns, groupBy: value !== "__none__" },
            }))
          }}
        >
          <SelectTrigger className="h-8 w-[220px] text-xs">
            <span className="truncate">{groupByDisplay}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Everything (no breakdown)</SelectItem>
            <SelectItem value="service.name">ServiceName</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// AddOnSections
// ---------------------------------------------------------------------------

function AddOnSections({
  query,
  onUpdate,
}: {
  query: QueryBuilderQueryDraft
  onUpdate: (
    updater: (q: QueryBuilderQueryDraft) => QueryBuilderQueryDraft,
  ) => void
}) {
  const hasAny = Object.values(query.addOns).some(Boolean)
  if (!hasAny) return null

  return (
    <div className="space-y-2 pt-1">
      {query.addOns.groupBy && query.dataSource !== "metrics" && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-16 shrink-0">
            Group By
          </span>
          <GroupByAutocomplete
            value={query.groupBy}
            onChange={(value) =>
              onUpdate((current) => ({ ...current, groupBy: value }))
            }
            dataSource={query.dataSource}
          />
        </div>
      )}

      {query.addOns.having && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-16 shrink-0">
            Having
          </span>
          <Input
            value={query.having}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                having: event.target.value,
              }))
            }
            placeholder="count > 10"
            className="h-8 text-xs flex-1"
          />
        </div>
      )}

      {query.addOns.orderBy && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-16 shrink-0">
            Order By
          </span>
          <Input
            value={query.orderBy}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                orderBy: event.target.value,
              }))
            }
            placeholder="value"
            className="h-8 text-xs flex-1"
          />
          <Select
            value={query.orderByDirection}
            onValueChange={(value) =>
              onUpdate((current) => ({
                ...current,
                orderByDirection:
                  value === "asc" || value === "desc"
                    ? value
                    : current.orderByDirection,
              }))
            }
          >
            <SelectTrigger className="h-8 w-20 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">desc</SelectItem>
              <SelectItem value="asc">asc</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {query.addOns.limit && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-16 shrink-0">
            Limit
          </span>
          <Input
            value={query.limit}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                limit: event.target.value,
              }))
            }
            placeholder="10"
            className="h-8 w-24 text-xs"
            type="number"
            min={1}
          />
        </div>
      )}

      {query.addOns.legend && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-16 shrink-0">
            Legend
          </span>
          <Input
            value={query.legend}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                legend: event.target.value,
              }))
            }
            placeholder="Human-friendly series name"
            className="h-8 text-xs flex-1"
          />
        </div>
      )}
    </div>
  )
}
