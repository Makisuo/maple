import { Button } from "@maple/ui/components/ui/button"
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XmarkIcon } from "@/components/icons"
import {
	FUNNEL_MAX_STEPS,
	FUNNEL_SESSION_DIMENSIONS,
	FUNNEL_SESSION_DIMENSION_LABEL,
	emptyEventStep,
	type FunnelSessionDimension,
	type FunnelStep,
} from "./definition"

// The step builder: an ordered list of up to ten steps, each an event name, a
// page path, or — first step only — a session's acquisition dimension. Shared
// by the /analytics Funnels view and the dashboard funnel widget's config rail,
// so it owns no fetching: the event-name and page-path suggestions come in as
// props and every edit goes straight back out through `onChange`.

export interface FunnelStepSuggestion {
	readonly name: string
	/** Shown beside the name when known — event count or page views. */
	readonly count?: number
}

interface FunnelStepBuilderProps {
	steps: ReadonlyArray<FunnelStep>
	onChange: (steps: ReadonlyArray<FunnelStep>) => void
	/** `track()` event names for the event-step autocomplete. */
	eventNames?: ReadonlyArray<FunnelStepSuggestion>
	/** Page paths for the page-step autocomplete. */
	pagePaths?: ReadonlyArray<FunnelStepSuggestion>
	/** Tighter spacing for a settings rail. */
	compact?: boolean
	className?: string
}

type StepKind = FunnelStep["kind"]

const KIND_LABEL = {
	event: "Event",
	page: "Page",
	session: "Session",
} satisfies Record<StepKind, string>

/** Change a step's kind, carrying nothing over: the value fields do not mean the same thing. */
function withKind(step: FunnelStep, kind: StepKind): FunnelStep {
	if (step.kind === kind) return step
	switch (kind) {
		case "event":
			return { kind: "event", eventName: "" }
		case "page":
			return { kind: "page", pagePath: "" }
		case "session":
			return { kind: "session", dimension: "referrerHost", value: "" }
	}
}

const move = <T,>(items: ReadonlyArray<T>, from: number, to: number): ReadonlyArray<T> => {
	if (to < 0 || to >= items.length) return items
	const next = [...items]
	const [item] = next.splice(from, 1)
	next.splice(to, 0, item!)
	return next
}

export function FunnelStepBuilder({
	steps,
	onChange,
	eventNames = [],
	pagePaths = [],
	compact = false,
	className,
}: FunnelStepBuilderProps) {
	const update = (index: number, step: FunnelStep) =>
		onChange(steps.map((current, i) => (i === index ? step : current)))
	const remove = (index: number) => onChange(steps.filter((_, i) => i !== index))
	const add = () => onChange([...steps, emptyEventStep()])

	// A session step is only valid first. Rather than let the query 400, the
	// kind is unavailable past step 1 and moving a session step down demotes it
	// to an event step at the same position.
	const reorder = (from: number, to: number) => {
		const next = move(steps, from, to)
		onChange(next.map((step, i) => (i > 0 && step.kind === "session" ? withKind(step, "event") : step)))
	}

	return (
		<div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2", className)}>
			{steps.map((step, index) => (
				<StepRow
					key={index}
					index={index}
					step={step}
					total={steps.length}
					compact={compact}
					eventNames={eventNames}
					pagePaths={pagePaths}
					onChange={(next) => update(index, next)}
					onRemove={() => remove(index)}
					onMoveUp={() => reorder(index, index - 1)}
					onMoveDown={() => reorder(index, index + 1)}
				/>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={add}
				disabled={steps.length >= FUNNEL_MAX_STEPS}
				className="w-fit"
			>
				<PlusIcon size={14} />
				Add step
				{steps.length >= FUNNEL_MAX_STEPS ? (
					<span className="text-muted-foreground">(max {FUNNEL_MAX_STEPS})</span>
				) : null}
			</Button>
		</div>
	)
}

function StepRow({
	index,
	step,
	total,
	compact,
	eventNames,
	pagePaths,
	onChange,
	onRemove,
	onMoveUp,
	onMoveDown,
}: {
	index: number
	step: FunnelStep
	total: number
	compact: boolean
	eventNames: ReadonlyArray<FunnelStepSuggestion>
	pagePaths: ReadonlyArray<FunnelStepSuggestion>
	onChange: (step: FunnelStep) => void
	onRemove: () => void
	onMoveUp: () => void
	onMoveDown: () => void
}) {
	const kinds: ReadonlyArray<StepKind> = index === 0 ? ["event", "page", "session"] : ["event", "page"]
	const kindItems = Object.fromEntries(kinds.map((kind) => [kind, KIND_LABEL[kind]]))

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 rounded-md border bg-card",
				compact ? "px-1.5 py-1" : "px-2 py-1.5",
			)}
		>
			<span
				className={cn(
					"grid shrink-0 place-items-center rounded-sm bg-muted font-mono text-[10px] tabular-nums text-muted-foreground",
					compact ? "size-5" : "size-6",
				)}
				aria-label={`Step ${index + 1}`}
			>
				{index + 1}
			</span>

			<Select
				items={kindItems}
				value={step.kind}
				onValueChange={(value) => {
					if (value === "event" || value === "page" || value === "session")
						onChange(withKind(step, value))
				}}
			>
				<SelectTrigger size="sm" className="w-24 min-w-0 shrink-0" aria-label="Step type">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{kinds.map((kind) => (
						<SelectItem key={kind} value={kind}>
							{KIND_LABEL[kind]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<div className="flex min-w-0 flex-1 items-center gap-1.5">
				{step.kind === "event" ? (
					<SuggestingInput
						value={step.eventName}
						onChange={(eventName) => onChange({ kind: "event", eventName })}
						suggestions={eventNames}
						placeholder="Event name, e.g. signup_completed"
						ariaLabel={`Step ${index + 1} event name`}
						empty="No events recorded in this window — type a name."
					/>
				) : step.kind === "page" ? (
					<SuggestingInput
						value={step.pagePath}
						onChange={(pagePath) =>
							onChange(
								step.host
									? { kind: "page", pagePath, host: step.host }
									: { kind: "page", pagePath },
							)
						}
						suggestions={pagePaths}
						placeholder="Page path, e.g. /pricing"
						ariaLabel={`Step ${index + 1} page path`}
						empty="No page paths in this window — type a path."
						mono
					/>
				) : (
					<>
						<Select
							items={FUNNEL_SESSION_DIMENSION_LABEL}
							value={step.dimension}
							onValueChange={(value) => {
								if (
									value &&
									FUNNEL_SESSION_DIMENSIONS.includes(value as FunnelSessionDimension)
								) {
									onChange({ ...step, dimension: value as FunnelSessionDimension })
								}
							}}
						>
							<SelectTrigger
								size="sm"
								className="w-32 min-w-0 shrink-0"
								aria-label="Session dimension"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FUNNEL_SESSION_DIMENSIONS.map((dimension) => (
									<SelectItem key={dimension} value={dimension}>
										{FUNNEL_SESSION_DIMENSION_LABEL[dimension]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input
							size="sm"
							value={step.value}
							onChange={(event) => onChange({ ...step, value: event.target.value })}
							placeholder={sessionValuePlaceholder(step.dimension)}
							aria-label={`Step ${index + 1} session value`}
							className="min-w-0 flex-1 font-mono text-xs"
						/>
					</>
				)}
			</div>

			<div className="flex shrink-0 items-center">
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onMoveUp}
					disabled={index === 0}
					aria-label="Move step up"
				>
					<ArrowUpIcon size={12} />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onMoveDown}
					disabled={index === total - 1}
					aria-label="Move step down"
				>
					<ArrowDownIcon size={12} />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onRemove}
					aria-label="Remove step"
				>
					<XmarkIcon size={12} />
				</Button>
			</div>
		</div>
	)
}

function sessionValuePlaceholder(dimension: FunnelSessionDimension): string {
	switch (dimension) {
		case "referrerHost":
			return "e.g. news.ycombinator.com"
		case "utmSource":
			return "e.g. twitter"
		case "utmMedium":
			return "e.g. cpc"
		case "utmCampaign":
			return "e.g. launch-week"
		case "country":
			return "e.g. DE"
		case "host":
			return "e.g. app.example.com"
	}
}

/**
 * A free-text input with suggestions: the value is whatever was typed, and
 * picking a suggestion just types it. Freeform matters — a funnel is often
 * built for an event that has not fired yet in this window (or ever, on a
 * fresh org), and a strict picker would make that impossible to express.
 */
function SuggestingInput({
	value,
	onChange,
	suggestions,
	placeholder,
	ariaLabel,
	empty,
	mono = false,
}: {
	value: string
	onChange: (value: string) => void
	suggestions: ReadonlyArray<FunnelStepSuggestion>
	placeholder: string
	ariaLabel: string
	empty: string
	mono?: boolean
}) {
	const names = suggestions.map((suggestion) => suggestion.name)
	const countOf = new Map(suggestions.map((suggestion) => [suggestion.name, suggestion.count]))
	return (
		<Combobox
			items={names}
			inputValue={value}
			onInputValueChange={(next) => onChange(next)}
			value={names.includes(value) ? value : null}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next)
			}}
		>
			<ComboboxInput
				placeholder={placeholder}
				aria-label={ariaLabel}
				size="sm"
				className={cn("min-w-0 flex-1", mono && "font-mono text-xs")}
				showTrigger={names.length > 0}
			/>
			<ComboboxContent>
				<ComboboxEmpty>{empty}</ComboboxEmpty>
				<ComboboxList>
					{(name: string) => (
						<ComboboxItem key={name} value={name}>
							<span className="flex min-w-0 items-center gap-2">
								<span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-xs")}>
									{name}
								</span>
								{countOf.get(name) !== undefined ? (
									<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
										{formatNumber(countOf.get(name)!)}
									</span>
								) : null}
							</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}
