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
import { WidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"
import { formatCellValue } from "@/components/dashboard-builder/widgets/table-widget"
import { resolveFieldPath } from "@/lib/resolve-field-path"
import type {
  WidgetDataState,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"

interface ListWidgetProps {
  dataState: WidgetDataState
  display: WidgetDisplayConfig
  mode: WidgetMode
  onRemove: () => void
  onClone?: () => void
  onConfigure?: () => void
}

type ColumnDef = {
  field: string
  header: string
  unit?: string
  width?: number
  align?: "left" | "center" | "right"
}

export const ListWidget = memo(function ListWidget({
  dataState,
  display,
  mode,
  onRemove,
  onClone,
  onConfigure,
}: ListWidgetProps) {
  const title = display.title || "List"
  const rows =
    dataState.status === "ready" && Array.isArray(dataState.data)
      ? (dataState.data as Record<string, unknown>[])
      : []
  const columns = display.columns ?? []

  const effectiveColumns: ColumnDef[] =
    columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0])
            .filter((key) => {
              const val = rows[0][key]
              return val == null || typeof val !== "object" || Array.isArray(val)
            })
            .map((key) => ({ field: key, header: key }))
        : []

  return (
    <WidgetShell
      title={title}
      mode={mode}
      onRemove={onRemove}
      onClone={onClone}
      onConfigure={onConfigure}
      contentClassName="flex-1 min-h-0 overflow-auto p-0"
    >
      {dataState.status === "loading" ? (
        <div className="p-3 flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : dataState.status === "error" ? (
        <div className="flex items-center justify-center h-full flex-col gap-1">
          <span className="text-xs text-muted-foreground">Unable to load</span>
          {dataState.message && (
            <span className="text-[10px] text-destructive/70 max-w-[90%] text-center truncate">
              {dataState.message}
            </span>
          )}
        </div>
      ) : (
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
                  {effectiveColumns.map((col) => {
                    const value = resolveFieldPath(row, col.field)
                    const displayValue = Array.isArray(value)
                      ? value.join(", ")
                      : formatCellValue(value, col.unit)
                    return (
                      <TableCell
                        key={col.field}
                        className="text-xs"
                        style={{ textAlign: col.align ?? "left" }}
                      >
                        {displayValue}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
    </WidgetShell>
  )
})
