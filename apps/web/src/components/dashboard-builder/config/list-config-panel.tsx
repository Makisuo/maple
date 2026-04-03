import * as React from "react"
import { Reorder, useDragControls } from "motion/react"
import { Atom, useAtom } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
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
import { useAutocompleteContext } from "@/hooks/use-autocomplete-context"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"
import { useWidgetBuilderData } from "@/hooks/use-widget-builder-data"
import type { ValueUnit } from "@/components/dashboard-builder/types"
import { Switch } from "@maple/ui/components/ui/switch"
import { getListPerformanceHints } from "@/lib/query-builder/performance-hints"
import { GripDotsIcon } from "@/components/icons"

type ListDataSource = "traces" | "logs"

interface ListColumnDraft {
  field: string
  header: string
  unit?: ValueUnit
  align?: "left" | "center" | "right"
}

// Props interface removed — ListConfigPanel now reads from context

const TRACE_DEFAULT_COLUMNS: ListColumnDraft[] = [
  { field: "serviceName", header: "Service" },
  { field: "spanName", header: "Span" },
  { field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
  { field: "statusCode", header: "Status" },
]

const LOG_DEFAULT_COLUMNS: ListColumnDraft[] = [
  { field: "timestamp", header: "Time" },
  { field: "severityText", header: "Severity" },
  { field: "serviceName", header: "Service" },
  { field: "body", header: "Message" },
]

// These are the fields returned by the query engine's list query
// (raw traces table, not the materialized view)
const TRACE_FIELDS = [
  "traceId",
  "timestamp",
  "spanId",
  "serviceName",
  "spanName",
  "durationMs",
  "statusCode",
  "spanKind",
  "hasError",
]

const LOG_FIELDS = [
  "timestamp",
  "severityText",
  "severityNumber",
  "serviceName",
  "body",
  "traceId",
  "spanId",
]

const UNIT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "none", label: "None" },
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "duration_ms", label: "Duration (ms)" },
  { value: "duration_us", label: "Duration (us)" },
  { value: "bytes", label: "Bytes" },
  { value: "requests_per_sec", label: "Req/s" },
]

export { TRACE_DEFAULT_COLUMNS, LOG_DEFAULT_COLUMNS }
export type { ListColumnDraft, ListDataSource }

function DraggableColumnRow({
  id,
  column,
  index,
  showFieldSuggestions,
  onFocusField,
  onBlurField,
  allSuggestedFields,
  updateColumn,
  removeColumn,
}: {
  id: string
  column: ListColumnDraft
  index: number
  showFieldSuggestions: boolean
  onFocusField: () => void
  onBlurField: () => void
  allSuggestedFields: string[]
  updateColumn: (index: number, updates: Partial<ListColumnDraft>) => void
  removeColumn: (index: number) => void
}) {
  const controls = useDragControls()

  return (
    <Reorder.Item
      value={id}
      dragListener={false}
      dragControls={controls}
      as="div"
      className="flex items-center gap-2 rounded-md bg-background py-1 relative"
      whileDrag={{
        scale: 1.02,
        boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
        zIndex: 50,
      }}
      transition={{ duration: 0.15 }}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground touch-none"
        onPointerDown={(e) => controls.start(e)}
      >
        <GripDotsIcon size={14} />
      </button>
      <div className="relative flex-1">
        <Input
          value={column.field}
          onChange={(e) => updateColumn(index, { field: e.target.value })}
          onFocus={onFocusField}
          onBlur={onBlurField}
          placeholder="Field path"
          className="text-xs h-8"
        />
        {showFieldSuggestions && (
          <div className="absolute top-full left-0 z-50 mt-1 w-full max-h-48 overflow-auto rounded-md border bg-popover shadow-md">
            {allSuggestedFields
              .filter(
                (f) =>
                  !column.field || f.toLowerCase().includes(column.field.toLowerCase()),
              )
              .slice(0, 20)
              .map((field) => (
                <button
                  key={field}
                  type="button"
                  className="w-full px-2 py-1 text-left text-xs hover:bg-accent truncate"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    updateColumn(index, {
                      field,
                      header: field.split(".").pop() ?? field,
                    })
                  }}
                >
                  {field}
                </button>
              ))}
          </div>
        )}
      </div>
      <Input
        value={column.header}
        onChange={(e) => updateColumn(index, { header: e.target.value })}
        placeholder="Header"
        className="text-xs h-8 w-28"
      />
      <Select
        items={UNIT_OPTIONS}
        value={column.unit ?? "none"}
        onValueChange={(value) =>
          updateColumn(index, {
            unit: value === "none" ? undefined : (value as ValueUnit),
          })
        }
      >
        <SelectTrigger className="h-8 w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {UNIT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={{ left: "Left", center: "Center", right: "Right" }}
        value={column.align ?? "left"}
        onValueChange={(value) =>
          updateColumn(index, { align: value as "left" | "center" | "right" })
        }
      >
        <SelectTrigger className="h-8 w-20 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="left">Left</SelectItem>
          <SelectItem value="center">Center</SelectItem>
          <SelectItem value="right">Right</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
        onClick={() => removeColumn(index)}
      >
        &times;
      </Button>
    </Reorder.Item>
  )
}

export function ListConfigPanel() {
  const { state, actions: { setState } } = useWidgetBuilder()
  const { autocompleteValues } = useWidgetBuilderData()
  const { setActiveAttributeKey, setActiveResourceAttributeKey } = useAutocompleteContext()

  const listDataSource = state.listDataSource
  const whereClause = state.listWhereClause
  const limit = state.listLimit
  const rootOnly = state.listRootOnly
  const columns = state.listColumns

  const onChange = (updates: {
    listDataSource?: ListDataSource
    listWhereClause?: string
    listLimit?: string
    listRootOnly?: boolean
    listColumns?: ListColumnDraft[]
  }) => setState((current) => ({ ...current, ...updates }))
  const showFieldSuggestionsAtom = React.useMemo(() => Atom.make<number | null>(null), [])
  const [showFieldSuggestions, setShowFieldSuggestions] = useAtom(showFieldSuggestionsAtom)

  // Stable IDs for Reorder — kept in sync with columns array.
  // addColumn/removeColumn/reorderColumns update the ref before calling onChange,
  // so a length mismatch here means an external reset (e.g. parent replaced columns).
  const columnIdsRef = React.useRef<string[]>(columns.map(() => crypto.randomUUID()))
  if (columnIdsRef.current.length !== columns.length) {
    columnIdsRef.current = columns.map(() => crypto.randomUUID())
  }

  const columnIds = columnIdsRef.current

  const knownFields = listDataSource === "traces" ? TRACE_FIELDS : LOG_FIELDS
  // Query engine list returns full SpanAttributes/ResourceAttributes maps,
  // so dynamic attribute key suggestions are valid for both traces and logs.
  const attributePrefix = listDataSource === "traces" ? "spanAttributes." : "logAttributes."
  const resourcePrefix = "resourceAttributes."

  const dynamicAttributeKeys = React.useMemo(() => {
    const vals = autocompleteValues[listDataSource]
    const keys: string[] = []
    if (vals && "attributeKeys" in vals && Array.isArray(vals.attributeKeys)) {
      for (const k of vals.attributeKeys) {
        keys.push(`${attributePrefix}${k}`)
      }
    }
    if (vals && "resourceAttributeKeys" in vals && Array.isArray(vals.resourceAttributeKeys)) {
      for (const k of vals.resourceAttributeKeys) {
        keys.push(`${resourcePrefix}${k}`)
      }
    }
    return keys
  }, [autocompleteValues, listDataSource, attributePrefix])

  const allSuggestedFields = React.useMemo(
    () => [...knownFields, ...dynamicAttributeKeys],
    [knownFields, dynamicAttributeKeys],
  )

  const handleDataSourceChange = (ds: ListDataSource) => {
    const newCols = ds === "traces" ? TRACE_DEFAULT_COLUMNS : LOG_DEFAULT_COLUMNS
    columnIdsRef.current = newCols.map(() => crypto.randomUUID())
    onChange({
      listDataSource: ds,
      listWhereClause: "",
      listColumns: newCols,
    })
  }

  const updateColumn = (index: number, updates: Partial<ListColumnDraft>) => {
    const next = columns.map((col, i) => (i === index ? { ...col, ...updates } : col))
    onChange({ listColumns: next })
  }

  const removeColumn = (index: number) => {
    columnIdsRef.current = columnIdsRef.current.filter((_, i) => i !== index)
    onChange({ listColumns: columns.filter((_, i) => i !== index) })
  }

  const addColumn = (field?: string) => {
    columnIdsRef.current = [...columnIdsRef.current, crypto.randomUUID()]
    const newCol: ListColumnDraft = {
      field: field ?? "",
      header: field ?? "",
    }
    onChange({ listColumns: [...columns, newCol] })
    setShowFieldSuggestions(null)
  }

  const reorderColumns = (newIdOrder: string[]) => {
    const reordered = newIdOrder.map((id) => {
      const idx = columnIds.indexOf(id)
      return columns[idx]!
    })
    columnIdsRef.current = newIdOrder
    onChange({ listColumns: reordered })
  }

  return (
    <div className="space-y-5">
      {/* Data source */}
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Data Source
        </p>
        <div className="flex h-9 rounded-md border bg-muted/40 p-0.5 w-fit">
          {(["traces", "logs"] as const).map((ds) => (
            <button
              key={ds}
              type="button"
              onClick={() => handleDataSourceChange(ds)}
              className={cn(
                "px-4 text-xs rounded-sm transition-colors capitalize",
                listDataSource === ds
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {ds}
            </button>
          ))}
        </div>
      </div>

      {/* Root spans only (traces only) */}
      {listDataSource === "traces" && (
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Root spans only
            </p>
            <p className="text-[10px] text-muted-foreground">
              Uses pre-aggregated data for faster queries
            </p>
          </div>
          <Switch
            checked={rootOnly}
            onCheckedChange={(checked) => onChange({ listRootOnly: checked })}
          />
        </div>
      )}

      {/* Where clause */}
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Filter
        </p>
        <WhereClauseEditor
          rows={1}
          value={whereClause}
          dataSource={listDataSource}
          values={autocompleteValues[listDataSource]}
          onActiveAttributeKey={setActiveAttributeKey}
          onActiveResourceAttributeKey={setActiveResourceAttributeKey}
          onChange={(value) => onChange({ listWhereClause: value })}
          placeholder={
            listDataSource === "traces"
              ? 'service.name = "api" AND has_error = true'
              : 'service.name = "api" AND severity = "ERROR"'
          }
          textareaClassName="min-h-[32px] resize-y text-xs"
          ariaLabel="List filter"
        />
        {(() => {
          if (listDataSource !== "traces") return null
          const parsedLimit = Number.parseInt(limit, 10)
          const hints = getListPerformanceHints(
            whereClause,
            Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25,
            rootOnly,
          )
          const slow = hints.filter((h) => h.speed === "slow")
          const fast = hints.filter((h) => h.speed === "fast")
          if (slow.length === 0 && fast.length === 0) return null
          return (
            <div className="mt-1.5 space-y-1.5">
              {slow.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                  {slow.map((h) => (
                    <p key={h.key} className="text-[11px] text-amber-500">
                      {h.reason}
                    </p>
                  ))}
                </div>
              )}
              {fast.length > 0 && (
                <div className="space-y-1 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                  {fast.map((h) => (
                    <p key={h.key} className="text-[11px] text-emerald-500">
                      {h.reason}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Limit */}
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Limit
        </p>
        <Input
          value={limit}
          onChange={(e) => onChange({ listLimit: e.target.value })}
          placeholder="25"
          type="number"
          min={1}
          max={200}
          className="w-32"
        />
        <p className="text-[10px] text-muted-foreground">
          Max 200. Recommended: 25-50 for dashboard widgets.
        </p>
      </div>

      {/* Columns */}
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Columns
        </p>

        <Reorder.Group
          axis="y"
          values={columnIds}
          onReorder={reorderColumns}
          as="div"
          className="space-y-2"
        >
          {columns.map((col, i) => (
            <DraggableColumnRow
              key={columnIds[i]}
              id={columnIds[i]!}
              column={col}
              index={i}
              showFieldSuggestions={showFieldSuggestions === i}
              onFocusField={() => setShowFieldSuggestions(i)}
              onBlurField={() => setTimeout(() => setShowFieldSuggestions(null), 150)}
              allSuggestedFields={allSuggestedFields}
              updateColumn={updateColumn}
              removeColumn={removeColumn}
            />
          ))}
        </Reorder.Group>

        <Button variant="outline" size="sm" onClick={() => addColumn()}>
          + Column
        </Button>
      </div>
    </div>
  )
}
