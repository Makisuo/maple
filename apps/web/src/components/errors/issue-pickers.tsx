import { useMemo, type RefObject } from "react"

import type { IssueSeverity, WorkflowState } from "@maple/domain/http"
import {
	allowedTransitionsForAll,
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
} from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"

import { QuickPickMenu, type QuickPickItem } from "./quick-pick-menu"
import { SEVERITY_LABEL, SEVERITY_ORDER, SeverityIcon } from "./severity-badge"

/**
 * The two Linear-style controls an error row carries: severity on the left,
 * workflow state on the right. Both open a {@link QuickPickMenu}; this file
 * only knows which rows to offer and what the trigger looks like.
 */

/** Hotkeys shown in the pickers and registered by the hub on the focused row. */
const PICKER_HOTKEY = { severity: "P", state: "S" } as const

/** A row's focus-ring and hover wash, shared so the two triggers feel like one control family. */
const TRIGGER =
	"rounded-md transition-colors hover:bg-foreground/8 data-popup-open:bg-foreground/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"

/** A Select's value must be a string, so "not set" needs a stand-in. */
const NONE = "none" as const
type SeverityChoice = IssueSeverity | typeof NONE

const SEVERITY_ITEMS: ReadonlyArray<QuickPickItem<SeverityChoice>> = [
	{
		value: NONE,
		label: "No severity",
		icon: <SeverityIcon severity={null} />,
		shortcut: "0",
		keywords: "none unset clear",
	},
	...SEVERITY_ORDER.map((severity, index) => ({
		value: severity,
		label: SEVERITY_LABEL[severity],
		icon: <SeverityIcon severity={severity} />,
		shortcut: String(index + 1),
	})),
]

export function SeverityPicker({
	value,
	onChange,
	open,
	onOpenChange,
	fallbackAnchor,
	className,
}: {
	value: IssueSeverity | null
	onChange: (severity: IssueSeverity | null) => void
	open?: boolean
	onOpenChange?: (open: boolean) => void
	fallbackAnchor?: RefObject<HTMLElement | null>
	className?: string
}) {
	const label = value === null ? "Severity not set" : `Severity: ${SEVERITY_LABEL[value]}`
	return (
		<QuickPickMenu
			items={SEVERITY_ITEMS}
			current={value ?? NONE}
			onSelect={(next) => onChange(next === NONE ? null : next)}
			placeholder="Change severity…"
			hotkey={PICKER_HOTKEY.severity}
			label="Severity"
			open={open}
			onOpenChange={onOpenChange}
			fallbackAnchor={fallbackAnchor}
		>
			<button
				type="button"
				data-picker="severity"
				title={`${label} · click to change`}
				aria-label={`${label}. Change severity`}
				className={cn(TRIGGER, "inline-flex size-6 items-center justify-center", className)}
			>
				<SeverityIcon severity={value} size={16} />
			</button>
		</QuickPickMenu>
	)
}

/**
 * `regressed` and `verifying` are set by the ticks, never chosen. They still
 * render as the CURRENT value when an issue is in one; they are only absent
 * from the choices.
 */
const OFFERED_STATES = WORKFLOW_STATE_ORDER.filter((state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state))

export function StatePicker({
	current,
	onChange,
	open,
	onOpenChange,
	fallbackAnchor,
	className,
}: {
	current: WorkflowState
	onChange: (next: WorkflowState) => void
	open?: boolean
	onOpenChange?: (open: boolean) => void
	fallbackAnchor?: RefObject<HTMLElement | null>
	className?: string
}) {
	// The offered moves come from the domain matrix the server enforces, so the
	// picker never shows a transition the API would reject. Unreachable states
	// stay listed but dimmed: the digits keep meaning the same thing on every row.
	const items = useMemo<ReadonlyArray<QuickPickItem<WorkflowState>>>(() => {
		const allowed = new Set<WorkflowState>(allowedTransitionsForAll([current]))
		return OFFERED_STATES.map((state, index) => ({
			value: state,
			label: WORKFLOW_LABEL[state],
			icon: <WorkflowRingIcon state={state} size={14} />,
			shortcut: String(index + 1),
			disabled: state !== current && !allowed.has(state),
		}))
	}, [current])

	return (
		<QuickPickMenu
			items={items}
			current={current}
			onSelect={onChange}
			placeholder="Change status…"
			hotkey={PICKER_HOTKEY.state}
			label="Status"
			open={open}
			onOpenChange={onOpenChange}
			fallbackAnchor={fallbackAnchor}
		>
			<button
				type="button"
				data-picker="state"
				title={`Status: ${WORKFLOW_LABEL[current]} · click to change`}
				className={cn(
					TRIGGER,
					"-ml-1.5 inline-flex h-6 max-w-full items-center gap-1.5 px-1.5 text-[11px] whitespace-nowrap text-muted-foreground hover:text-foreground data-popup-open:text-foreground",
					className,
				)}
			>
				<WorkflowRingIcon state={current} size={12} className="shrink-0" />
				<span className="truncate">{WORKFLOW_LABEL[current]}</span>
			</button>
		</QuickPickMenu>
	)
}
