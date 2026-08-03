import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { cn } from "@maple/ui/lib/utils"

import { ALERT_TEMPLATES, BlankRuleIcon, type AlertTemplate } from "@/lib/alerts/templates"
import { ChartLineIcon, ChevronRightIcon } from "@/components/icons"

interface RuleTemplatesOverlayProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onPick: (template: AlertTemplate) => void
	onStartBlank: () => void
}

/**
 * First-touch picker shown when a user lands on /alerts/create with no
 * pre-fills. Five named presets + "Start blank" + "From a dashboard chart".
 * Each preset card calls `onPick(template)`; the parent applies the template
 * and closes the overlay. Dismissible via backdrop, Escape, or the explicit
 * Skip link.
 */
export function RuleTemplatesOverlay({
	open,
	onOpenChange,
	onPick,
	onStartBlank,
}: RuleTemplatesOverlayProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="w-[860px] max-w-[92vw]">
				<DialogHeader>
					<DialogTitle>Start with a template</DialogTitle>
					<DialogDescription>
						These cover the most common alerts. Pick one — every field stays editable after.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 px-6 pb-2 md:grid-cols-3">
					{ALERT_TEMPLATES.map((template) => (
						<TemplateTile key={template.id} template={template} onPick={onPick} />
					))}
					<TileShell onClick={onStartBlank}>
						<TileHead
							icon={<BlankRuleIcon size={18} />}
							title="Start blank"
							subtitle="Build a rule from scratch."
						/>
						<p className="text-muted-foreground text-xs">
							Begin with the defaults and pick a signal yourself.
						</p>
					</TileShell>
					<TileShell asLink to="/dashboards" onClick={() => onOpenChange(false)}>
						<TileHead
							icon={<ChartLineIcon size={18} />}
							title="From a dashboard chart"
							subtitle="Convert an existing visualization."
						/>
						<p className="text-muted-foreground text-xs">
							Open a dashboard, then choose “Create alert” from a chart's menu.
						</p>
					</TileShell>
				</div>
				<div className="flex items-center justify-end px-6 py-4">
					<Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
						Skip — use defaults
					</Button>
				</div>
			</DialogPopup>
		</Dialog>
	)
}

function TemplateTile({
	template,
	onPick,
}: {
	template: AlertTemplate
	onPick: (template: AlertTemplate) => void
}) {
	const Icon = template.icon
	return (
		<TileShell onClick={() => onPick(template)}>
			<TileHead icon={<Icon size={18} />} title={template.title} subtitle={template.description} />
			<div className="mt-auto flex items-center justify-between">
				<code className="font-mono text-[11px] text-muted-foreground">{template.summary}</code>
				<ChevronRightIcon
					size={14}
					className="text-muted-foreground transition-transform group-hover:translate-x-0.5"
				/>
			</div>
		</TileShell>
	)
}

function TileHead({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-2">
				<span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
					{icon}
				</span>
				<span className="font-medium text-sm">{title}</span>
			</div>
			<p className="text-muted-foreground text-xs leading-snug">{subtitle}</p>
		</div>
	)
}

type TileShellBaseProps = {
	children: React.ReactNode
	className?: string
}

type TileShellButtonProps = TileShellBaseProps & {
	onClick: () => void
	asLink?: false
	to?: never
}

type TileShellLinkProps = TileShellBaseProps & {
	asLink: true
	to: string
	onClick?: () => void
}

function TileShell(props: TileShellButtonProps | TileShellLinkProps) {
	const baseClass = cn(
		"group flex h-full flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
		"hover:border-primary/40 hover:bg-primary/[0.03] focus-visible:outline-none",
		"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
		props.className,
	)
	if (props.asLink) {
		return (
			<Link to={props.to} onClick={props.onClick} className={baseClass}>
				{props.children}
			</Link>
		)
	}
	return (
		<button type="button" onClick={props.onClick} className={baseClass}>
			{props.children}
		</button>
	)
}
