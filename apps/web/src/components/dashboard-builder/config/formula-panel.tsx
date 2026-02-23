import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import type { QueryBuilderFormulaDraft } from "@/lib/query-builder/model"

interface FormulaPanelProps {
  formula: QueryBuilderFormulaDraft
  onUpdate: (updater: (f: QueryBuilderFormulaDraft) => QueryBuilderFormulaDraft) => void
  onRemove: () => void
}

export function FormulaPanel({ formula, onUpdate, onRemove }: FormulaPanelProps) {
  return (
    <div className="border border-dashed border-l-2 border-l-chart-3 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className="font-mono text-xs bg-chart-3/10 border-chart-3/30"
        >
          {formula.name}
        </Badge>
        <Button variant="ghost" size="xs" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={formula.expression}
          onChange={(event) =>
            onUpdate((current) => ({ ...current, expression: event.target.value }))
          }
          placeholder="A / B, (A + B) / 2"
          className="font-mono flex-1"
        />
        <Input
          value={formula.legend}
          onChange={(event) =>
            onUpdate((current) => ({ ...current, legend: event.target.value }))
          }
          placeholder="Legend"
          className="w-48"
        />
      </div>
    </div>
  )
}
