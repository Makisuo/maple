import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@maple/ui/components/ui/dialog"
import { Button } from "@maple/ui/components/ui/button"
import { MagnifierIcon } from "@/components/icons"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"

interface AdvancedFilterDialogProps {
  initialValue: string
  onApply: (value: string) => void
  autocompleteValues?: WhereClauseAutocompleteValues
  onActiveAttributeKey?: (key: string | null) => void
}

export function AdvancedFilterDialog({
  initialValue,
  onApply,
  autocompleteValues,
  onActiveAttributeKey,
}: AdvancedFilterDialogProps) {
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState(initialValue)

  React.useEffect(() => {
    if (open) {
      setValue(initialValue)
    }
  }, [open, initialValue])

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Open with 'f' if not typing in an input
      if (
        e.key.toLowerCase() === "f" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.target instanceof Element &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) &&
        !(e.target as HTMLElement).isContentEditable
      ) {
        e.preventDefault()
        setOpen(true)
      }

      // Cmd+Enter to apply when modal is open
      if (open && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onApply(value)
        setOpen(false)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, value, onApply])

  const handleApply = () => {
    onApply(value)
    setOpen(false)
  }

  const handleClear = () => {
    setValue("")
    onApply("")
    setOpen(false)
  }

  const hasActiveFilter = initialValue.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={hasActiveFilter ? "secondary" : "outline"}
            className="gap-2"
          >
            <MagnifierIcon
              className={hasActiveFilter ? "text-primary" : "text-muted-foreground"}
            />
            <span>Advanced Filter</span>
            <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
              F
            </kbd>
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Advanced Filter</DialogTitle>
          <DialogDescription>
            Write SQL-like queries to filter traces. Use <kbd className="bg-muted px-1 py-0.5 rounded text-foreground">Ctrl+Space</kbd> for autocomplete. Press <kbd className="bg-muted px-1 py-0.5 rounded text-foreground">Cmd+Enter</kbd> to apply.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <WhereClauseEditor
            className="w-full"
            rows={8}
            value={value}
            dataSource="traces"
            autocompleteScope="trace_search"
            maxSuggestions={20}
            values={autocompleteValues}
            onActiveAttributeKey={onActiveAttributeKey}
            onChange={setValue}
            placeholder='service.name = "checkout" AND attr.http.route = "/orders/:id"'
            textareaClassName="font-mono text-sm leading-relaxed resize-y min-h-[200px]"
            ariaLabel="Advanced traces where clause"
          />
        </div>
        <DialogFooter>
          <div className="flex w-full items-center justify-between sm:justify-between">
            <Button variant="ghost" onClick={handleClear} className="text-muted-foreground">
              Clear Filter
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleApply}>Apply Filter</Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
