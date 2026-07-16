import { useCallback, useState } from "react"
import { relativeToAbsolute } from "@/lib/time-utils"
import { useTimeFormat } from "@/hooks/use-time-format"
import { cn } from "@maple/ui/utils"

interface ShorthandInputProps {
	onApply: (range: { startTime: string; endTime: string }, value: string, label: string) => void
}

export function ShorthandInput({ onApply }: ShorthandInputProps) {
	const [value, setValue] = useState("")
	const [error, setError] = useState(false)
	const { timeZone } = useTimeFormat()

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				const range = relativeToAbsolute(value, timeZone)
				if (range) {
					onApply(range, value.toLowerCase(), `Last ${value.toLowerCase()}`)
					setValue("")
					setError(false)
				} else {
					setError(true)
				}
			}
		},
		[value, onApply, timeZone],
	)

	const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		setValue(e.target.value)
		setError(false)
	}, [])

	return (
		<div className="space-y-1.5">
			<div
				className={cn(
					"group flex h-9 items-center gap-2 rounded-md border bg-background/40 pl-3 pr-1.5 transition-colors",
					"focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
					error ? "border-destructive/70" : "border-border/70 hover:border-border",
				)}
			>
				<span className="font-mono text-[11px] text-muted-foreground/70 select-none">›</span>
				<input
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder="1m · 2h · 4d · 6w · today"
					className="flex-1 bg-transparent font-mono text-sm tracking-tight text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
					spellCheck={false}
					autoComplete="off"
				/>
				<kbd
					className={cn(
						"hidden h-5 select-none items-center rounded border border-border/70 bg-muted/40 px-1.5 font-mono text-[10px] text-muted-foreground transition-opacity",
						value.length > 0 && "flex",
					)}
				>
					↵
				</kbd>
			</div>
			<p
				className={cn(
					"px-1 font-mono text-[10px] transition-colors",
					error ? "text-destructive" : "text-muted-foreground/60",
				)}
			>
				{error ? "Try 5m, 2h, 4d, 1w, 2mo, or today" : "Type a duration and press enter"}
			</p>
		</div>
	)
}
