import { useState } from "react"
import type { ReactNode } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Input } from "@maple/ui/components/ui/input"
import { cn } from "@maple/ui/utils"
import { comparatorLabels, isRangeComparator, signalLabels, type RuleFormState } from "@/lib/alerts/form-utils"
import type { AlertComparator, AlertSeverity, AlertSignalType } from "@maple/domain/http"

/*
 * Sentence-builder: renders the rule config as an editable sentence.
 *
 *   Trigger a [Warning] alert when [error rate] is [>] [5]% over [5] min
 *   after [2] consecutive breaches.
 *
 * Each bracketed chunk pops a tiny editor. Keeps the rule readable at a
 * glance and makes it feel like an object rather than a form field spray.
 */

const tokenBase =
	"inline-flex min-h-[28px] items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-medium transition-colors cursor-pointer select-none"

const tokenTone: Record<"default" | "signal" | "severity-warn" | "severity-crit" | "threshold", string> = {
	default: "border-border/80 bg-background hover:border-primary/50 hover:bg-accent/40",
	signal: "border-primary/40 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/15",
	"severity-warn":
		"border-severity-warn/40 bg-severity-warn/10 text-severity-warn hover:border-severity-warn/60",
	"severity-crit": "border-destructive/40 bg-destructive/10 text-destructive hover:border-destructive/60",
	threshold: "border-border/80 bg-muted/40 font-mono hover:border-primary/50 hover:bg-accent/40",
}

function SignalToken({
	value,
	onChange,
}: {
	value: AlertSignalType
	onChange: (v: AlertSignalType) => void
}) {
	const [open, setOpen] = useState(false)
	const options: { value: AlertSignalType; label: string; hint: string }[] = [
		{ value: "error_rate", label: "error rate", hint: "failed spans / total spans" },
		{ value: "p95_latency", label: "P95 latency", hint: "95th percentile request time" },
		{ value: "p99_latency", label: "P99 latency", hint: "99th percentile request time" },
		{ value: "apdex", label: "Apdex", hint: "user-satisfaction score" },
		{ value: "throughput", label: "throughput", hint: "requests per minute" },
		{ value: "metric", label: "metric", hint: "a specific OTel metric" },
		{ value: "query", label: "custom query", hint: "traces / logs / metrics expression" },
	]
	const current = options.find((o) => o.value === value)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<button type="button" className={cn(tokenBase, tokenTone.signal)}>
						<span>{current?.label ?? signalLabels[value]}</span>
						<span aria-hidden className="text-[10px] opacity-60">
							▾
						</span>
					</button>
				}
			/>
			<PopoverContent className="w-[280px] p-1" align="start">
				<div className="flex flex-col gap-0.5">
					{options.map((opt) => {
						const active = opt.value === value
						return (
							<button
								key={opt.value}
								type="button"
								onClick={() => {
									onChange(opt.value)
									setOpen(false)
								}}
								className={cn(
									"flex flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
									active ? "bg-primary/10 text-primary" : "hover:bg-accent",
								)}
							>
								<span className="text-sm font-medium">{opt.label}</span>
								<span className="text-xs text-muted-foreground">{opt.hint}</span>
							</button>
						)
					})}
				</div>
			</PopoverContent>
		</Popover>
	)
}

function ComparatorToken({
	value,
	onChange,
}: {
	value: AlertComparator
	onChange: (v: AlertComparator) => void
}) {
	const [open, setOpen] = useState(false)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<button
						type="button"
						className={cn(tokenBase, tokenTone.threshold, "min-w-[42px] justify-center")}
					>
						{comparatorLabels[value]}
					</button>
				}
			/>
			<PopoverContent className="w-[140px] p-1" align="start">
				<div className="flex flex-col gap-0.5">
					{Object.entries(comparatorLabels).map(([val, label]) => (
						<button
							key={val}
							type="button"
							onClick={() => {
								onChange(val as AlertComparator)
								setOpen(false)
							}}
							className={cn(
								"rounded-md px-2 py-1 text-left font-mono text-sm transition-colors",
								val === value ? "bg-primary/10 text-primary" : "hover:bg-accent",
							)}
						>
							{label}
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	)
}

function NumberToken({
	value,
	onChange,
	suffix,
	widthClass = "w-[96px]",
	placeholder,
	ariaLabel,
}: {
	value: string
	onChange: (v: string) => void
	suffix?: ReactNode
	widthClass?: string
	placeholder?: string
	ariaLabel?: string
}) {
	const [open, setOpen] = useState(false)
	const display = value.trim() === "" ? (placeholder ?? "—") : value
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<button
						type="button"
						aria-label={ariaLabel}
						className={cn(tokenBase, tokenTone.threshold, "min-w-[44px] justify-center")}
					>
						<span>{display}</span>
						{suffix && <span className="text-muted-foreground">{suffix}</span>}
					</button>
				}
			/>
			<PopoverContent className="w-auto p-2" align="start">
				<Input
					autoFocus
					type="number"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") setOpen(false)
					}}
					className={widthClass}
					placeholder={placeholder}
				/>
			</PopoverContent>
		</Popover>
	)
}

function SeverityToken({ value, onChange }: { value: AlertSeverity; onChange: (v: AlertSeverity) => void }) {
	const [open, setOpen] = useState(false)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<button
						type="button"
						className={cn(
							tokenBase,
							value === "critical" ? tokenTone["severity-crit"] : tokenTone["severity-warn"],
						)}
					>
						<span
							className={cn(
								"size-1.5 rounded-full",
								value === "critical" ? "bg-destructive" : "bg-severity-warn",
							)}
						/>
						<span className="capitalize">{value}</span>
						<span aria-hidden className="text-[10px] opacity-60">
							▾
						</span>
					</button>
				}
			/>
			<PopoverContent className="w-[160px] p-1" align="start">
				{(["warning", "critical"] as const).map((s) => (
					<button
						key={s}
						type="button"
						onClick={() => {
							onChange(s)
							setOpen(false)
						}}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm capitalize transition-colors",
							s === value ? "bg-primary/10 text-primary" : "hover:bg-accent",
						)}
					>
						<span
							className={cn(
								"size-1.5 rounded-full",
								s === "critical" ? "bg-destructive" : "bg-severity-warn",
							)}
						/>
						{s}
					</button>
				))}
			</PopoverContent>
		</Popover>
	)
}

function signalUnitSuffix(signal: AlertSignalType): string | undefined {
	switch (signal) {
		case "error_rate":
			return "%"
		case "p95_latency":
		case "p99_latency":
			return "ms"
		case "apdex":
			return ""
		case "throughput":
			return "/min"
		default:
			return undefined
	}
}

export function RuleSentenceBuilder({
	form,
	onChange,
}: {
	form: RuleFormState
	onChange: (next: RuleFormState) => void
}) {
	const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
		onChange({ ...form, [key]: value })

	const suffix = signalUnitSuffix(form.signalType)

	return (
		<div className="relative overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-primary/[0.04] via-transparent to-transparent p-5 md:p-6">
			<div className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-primary/40" />
			<div className="mb-3 flex items-center justify-between">
				<div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
					Rule
				</div>
				<div className="text-[11px] text-muted-foreground/70">Click any token to edit</div>
			</div>

			<p className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-base leading-[2] text-foreground">
				<span className="text-muted-foreground">Trigger a</span>
				<SeverityToken value={form.severity} onChange={(v) => set("severity", v)} />
				<span className="text-muted-foreground">alert when</span>
				<SignalToken value={form.signalType} onChange={(v) => set("signalType", v)} />
				<span className="text-muted-foreground">is</span>
				<ComparatorToken value={form.comparator} onChange={(v) => set("comparator", v)} />
				<NumberToken
					value={form.threshold}
					onChange={(v) => set("threshold", v)}
					suffix={suffix}
					placeholder="5"
					ariaLabel="Threshold"
				/>
				{isRangeComparator(form.comparator) && (
					<>
						<span className="text-muted-foreground">and</span>
						<NumberToken
							value={form.thresholdUpper}
							onChange={(v) => set("thresholdUpper", v)}
							suffix={suffix}
							placeholder="10"
							ariaLabel="Upper threshold"
						/>
					</>
				)}
				<span className="text-muted-foreground">over</span>
				<NumberToken
					value={form.windowMinutes}
					onChange={(v) => set("windowMinutes", v)}
					suffix="min"
					placeholder="5"
					ariaLabel="Window in minutes"
				/>
				<span className="text-muted-foreground">after</span>
				<NumberToken
					value={form.consecutiveBreachesRequired}
					onChange={(v) => set("consecutiveBreachesRequired", v)}
					placeholder="2"
					ariaLabel="Consecutive breaches"
				/>
				<span className="text-muted-foreground">consecutive breaches.</span>
			</p>
		</div>
	)
}
