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
import { Kbd } from "@maple/ui/components/ui/kbd"
import { MagnifierIcon } from "@/components/icons"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { useAutocompleteValuesContextOptional } from "@/hooks/use-autocomplete-values"
import { useAppHotkey } from "@/hooks/use-app-hotkey"

interface AdvancedFilterDialogProps {
	initialValue: string
	onApply: (value: string) => void
}

export function AdvancedFilterDialog({ initialValue, onApply }: AdvancedFilterDialogProps) {
	const [open, setOpenState] = React.useState(false)
	const [value, setValue] = React.useState(initialValue)
	const autocompleteValues = useAutocompleteValuesContextOptional()

	// Kick off the lazy autocomplete fetches while the dialog animates open so
	// values are ready by the time the editor is focused.
	const setOpen = (next: boolean) => {
		if (next) autocompleteValues?.activate?.()
		setOpenState(next)
	}

	React.useEffect(() => {
		if (open) {
			setValue(initialValue)
		}
	}, [open, initialValue])

	useAppHotkey("filter.advanced", () => setOpen(true))

	// Cmd+Enter to apply when the modal is open — form-scoped, so it stays a
	// plain listener instead of a registry shortcut.
	React.useEffect(() => {
		if (!open) return
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
						data-shortcut-focus="search"
					>
						<MagnifierIcon
							className={hasActiveFilter ? "text-primary" : "text-muted-foreground"}
						/>
						<span>Advanced Filter</span>
						<Kbd>F</Kbd>
					</Button>
				}
			/>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Advanced Filter</DialogTitle>
					<DialogDescription>
						Write SQL-like queries to filter traces. Use{" "}
						<kbd className="bg-muted px-1 py-0.5 rounded text-foreground">Ctrl+Space</kbd> for
						autocomplete. Press{" "}
						<kbd className="bg-muted px-1 py-0.5 rounded text-foreground">Cmd+Enter</kbd> to
						apply.
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
						highlight
						onChange={setValue}
						placeholder='service.name = "checkout" AND attr.http.route != "/health"'
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
