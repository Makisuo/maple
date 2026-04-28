import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ArrowRightIcon } from "@/components/icons"

interface TemplateCardProps {
	id: string
	name: string
	description: string
	tags: readonly string[]
	requirements: readonly string[]
	disabled?: boolean
	onUse: () => void
}

export function TemplateCard({
	name,
	description,
	tags,
	requirements,
	disabled = false,
	onUse,
}: TemplateCardProps) {
	return (
		<div className="group ring-1 ring-border hover:ring-border-active bg-card flex flex-col gap-2 p-4 rounded-md transition-all">
			<div className="flex items-start justify-between gap-2">
				<span className="text-sm font-semibold text-foreground">{name}</span>
			</div>
			<p className="text-xs text-dim leading-relaxed">{description}</p>
			{requirements.length > 0 && (
				<div className="flex flex-wrap items-center gap-1 mt-1">
					{requirements.map((req) => (
						<Badge key={req} variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium">
							{req}
						</Badge>
					))}
				</div>
			)}
			{tags.length > 0 && (
				<div className="flex flex-wrap items-center gap-1">
					{tags.map((tag) => (
						<Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-medium">
							{tag}
						</Badge>
					))}
				</div>
			)}
			<div className="flex justify-end mt-2">
				<Button size="sm" variant="outline" disabled={disabled} onClick={onUse}>
					Use template
					<ArrowRightIcon size={14} data-icon="inline-end" />
				</Button>
			</div>
		</div>
	)
}
