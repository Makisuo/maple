import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import type { StatusCodeBreakdownItem } from "@/api/tinybird/endpoint-detail"

function getStatusColorClass(code: string): string {
  const num = Number.parseInt(code, 10)
  if (num >= 500) return "bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400"
  if (num >= 400) return "bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400"
  if (num >= 300) return "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400"
  if (num >= 200) return "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400"
  return ""
}

interface EndpointStatusBreakdownProps {
  data: StatusCodeBreakdownItem[]
}

export function EndpointStatusBreakdown({ data }: EndpointStatusBreakdownProps) {
  const total = data.reduce((sum, item) => sum + item.count, 0)
  const sorted = [...data]
    .filter((item) => item.statusCode && item.statusCode !== "")
    .sort((a, b) => b.count - a.count)

  if (sorted.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No status code data available
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status Code</TableHead>
          <TableHead className="text-right">Count</TableHead>
          <TableHead className="text-right">Percentage</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((item) => {
          const pct = total > 0 ? (item.count / total) * 100 : 0
          return (
            <TableRow key={item.statusCode}>
              <TableCell>
                <Badge
                  variant="secondary"
                  className={`font-mono text-xs ${getStatusColorClass(item.statusCode)}`}
                >
                  {item.statusCode}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {item.count.toLocaleString()}
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-muted-foreground">
                {pct.toFixed(1)}%
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
