import { motion } from "motion/react"
import { Button } from "@maple/ui/components/ui/button"
import {
	ArrowLeftIcon,
	ChartLineIcon,
	CircleCheckIcon,
	RocketIcon,
	ServerIcon,
	SquareTerminalIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { ROLE_OPTIONS, type RoleOption } from "@/atoms/quick-start-atoms"

const ROLE_LABELS: Record<RoleOption, string> = {
	engineer: "Software engineer",
	devops_sre: "DevOps / SRE / Platform",
	eng_leader: "Engineering leader",
	founder: "Founder / CTO",
}

const ROLE_ICONS: Record<
	RoleOption,
	React.ComponentType<{ size?: number; className?: string }>
> = {
	engineer: SquareTerminalIcon,
	devops_sre: ServerIcon,
	eng_leader: ChartLineIcon,
	founder: RocketIcon,
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

const GRID_VARIANTS = {
	hidden: {},
	show: {
		transition: { staggerChildren: 0.05, delayChildren: 0.05 },
	},
}

const ITEM_VARIANTS = {
	hidden: { opacity: 0, y: 6 },
	show: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const },
	},
}

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
	const iconMap = ROLE_ICONS as unknown as Record<
		string,
		React.ComponentType<{ size?: number; className?: string }>
	>

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

				<motion.div
					variants={GRID_VARIANTS}
					initial="hidden"
					animate="show"
					className={cn(
						"grid gap-2.5",
						columns === 2 ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4",
					)}
				>
					{options.map((opt) => {
						const active = value === opt
						const Icon = iconMap[opt]
						return (
							<motion.button
								key={opt}
								type="button"
								variants={ITEM_VARIANTS}
								onClick={() => onSelect(opt)}
								whileTap={{ scale: 0.98 }}
								className={cn(
									"group relative flex flex-col items-center justify-center gap-2.5 rounded-xl border px-4 py-5 text-sm font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "border-primary bg-primary/5 text-primary"
										: "border-border hover:border-foreground/30 hover:bg-foreground/[0.02]",
								)}
							>
								{Icon && (
									<div
										className={cn(
											"flex size-9 items-center justify-center rounded-lg transition-colors duration-200",
											active
												? "bg-primary/10 text-primary"
												: "bg-muted/60 text-muted-foreground group-hover:bg-muted",
										)}
									>
										<Icon size={18} />
									</div>
								)}
								<span className="text-[13px] leading-tight text-center">
									{labels[opt]}
								</span>
								{active && (
									<motion.span
										className="absolute top-2 right-2 text-primary"
										initial={{ scale: 0, opacity: 0 }}
										animate={{ scale: 1, opacity: 1 }}
										transition={{
											type: "spring",
											stiffness: 380,
											damping: 22,
										}}
									>
										<CircleCheckIcon size={14} />
									</motion.span>
								)}
							</motion.button>
						)
					})}
				</motion.div>

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
