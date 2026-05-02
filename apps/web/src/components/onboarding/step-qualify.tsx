import { Button } from "@maple/ui/components/ui/button"
import { ArrowLeftIcon, CircleCheckIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { ROLE_OPTIONS, type RoleOption } from "@/atoms/quick-start-atoms"

const ROLE_LABELS: Record<RoleOption, string> = {
	engineer: "Software engineer",
	devops_sre: "DevOps / SRE / Platform",
	eng_leader: "Engineering leader",
	founder: "Founder / CTO",
}

export const QUALIFY_QUESTIONS = {
	role: {
		intro: "Welcome to Maple",
		title: "What's your role?",
		description: "We'll tailor docs and code snippets to your stack.",
		options: ROLE_OPTIONS,
		labels: ROLE_LABELS,
		columns: 2,
	},
} as const

export type QualifyQuestionId = keyof typeof QUALIFY_QUESTIONS

export function StepQualifyQuestion<T extends string>({
	intro,
	title,
	description,
	options,
	labels,
	columns,
	value,
	onSelect,
	onContinue,
	onBack,
}: {
	intro: string
	title: string
	description?: string | null
	options: readonly T[]
	labels: Record<T, string>
	columns: 2 | 4
	value: T | null
	onSelect: (val: T) => void
	onContinue: () => void
	onBack?: () => void
}) {
	return (
		<div className="flex-1 flex flex-col items-center justify-center px-6 py-12 overflow-auto">
			<div className="w-full max-w-xl flex flex-col gap-10">
				<div className="text-center space-y-3">
					<span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
						{intro}
					</span>
					<h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
					{description && (
						<p className="text-muted-foreground text-[15px] leading-relaxed max-w-md mx-auto">
							{description}
						</p>
					)}
				</div>

				<div
					className={cn(
						"grid gap-2.5",
						columns === 2 ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4",
					)}
				>
					{options.map((opt) => {
						const active = value === opt
						return (
							<button
								key={opt}
								type="button"
								onClick={() => onSelect(opt)}
								className={cn(
									"relative flex items-center justify-center rounded-xl border px-4 py-3.5 text-sm font-medium transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "border-primary bg-primary/5 text-primary"
										: "border-border hover:border-foreground/30",
								)}
							>
								{labels[opt]}
								{active && (
									<CircleCheckIcon
										size={14}
										className="absolute top-2 right-2 text-primary"
									/>
								)}
							</button>
						)
					})}
				</div>

				<div className="flex items-center justify-between gap-3">
					{onBack ? (
						<Button variant="ghost" onClick={onBack} className="gap-2">
							<ArrowLeftIcon size={14} />
							Back
						</Button>
					) : (
						<span />
					)}
					<Button size="lg" disabled={!value} onClick={onContinue} className="min-w-[180px]">
						Continue
						<span className="ml-2">&rarr;</span>
					</Button>
				</div>
			</div>
		</div>
	)
}
