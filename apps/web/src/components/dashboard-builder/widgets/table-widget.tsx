import { memo } from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type {
  WidgetDataState,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"
import { formatDuration, formatNumber } from "@/lib/format"

interface TableWidgetProps {
  dataState: WidgetDataState
  display: WidgetDisplayConfig
  mode: WidgetMode
  onRemove: () => void
  onClone?: () => void
  onConfigure?: () => void
}

export function formatCellValue(value: unknown, unit?: string): string {
  if (value == null) return "-"
  const num = Number(value)
  if (Number.isNaN(num)) return String(value)

  switch (unit) {
    case "duration_ms":
      return formatDuration(num)
    case "duration_us":
      return formatDuration(num / 1000)
    case "percent":
      return `${num.toFixed(1)}%`
    case "number":
      return formatNumber(num)
    case "requests_per_sec":
      return `${num.toFixed(1)}/s`
    default:
      return String(value)
  }
}

export const TableWidget = memo(function TableWidget({
  dataState,
  display,
  mode,
  onRemove,
  onClone,
  onConfigure,
}: TableWidgetProps) {
  const displayName = display.title || "Table"
  const rows =
    dataState.status === "ready" && Array.isArray(dataState.data)
      ? (dataState.data as Record<string, unknown>[])
      : []
  const columns = display.columns ?? []

  type ColumnDef = {
    field: string
    header: string
    unit?: string
    width?: number
    align?: "left" | "center" | "right"
  }

  // If no columns configured, auto-detect from first row
  const effectiveColumns: ColumnDef[] =
    columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0]).map((key) => ({
            field: key,
            header: key,
          }))
        : []

  return (
    <WidgetFrame
      title={displayName}
      dataState={dataState}
      mode={mode}
      onRemove={onRemove}
      onClone={onClone}
      onConfigure={onConfigure}
      contentClassName="flex-1 min-h-0 overflow-auto p-0"
      loadingSkeleton={
        <div className="p-3 flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            {effectiveColumns.map((col) => (
              <TableHead
                key={col.field}
                className="text-xs"
                style={{
                  textAlign: col.align ?? "left",
                  width: col.width ? `${col.width}px` : undefined,
                }}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={effectiveColumns.length}
                className="text-center text-xs text-muted-foreground"
              >
                No data
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, i) => (
              <TableRow key={i}>
                {effectiveColumns.map((col) => (
                  <TableCell
                    key={col.field}
                    className="text-xs"
                    style={{ textAlign: col.align ?? "left" }}
                  >
                    {formatCellValue(row[col.field], col.unit)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </WidgetFrame>
  )
})
