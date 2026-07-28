import type { AlertDestinationDocument } from "@maple/domain/http"
import { PROVIDERS, ProviderLogo } from "@/components/alerts/destination-provider"
import {
	AlertWarningIcon,
	CheckIcon,
	DotsVerticalIcon,
	LoaderIcon,
	PencilIcon,
	TrashIcon,
} from "@/components/icons"
import { formatRelativeTime } from "@maple/ui/time-format"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/utils"

interface DestinationCardProps {
	destination: AlertDestinationDocument
	isAdmin: boolean
	isTesting: boolean
	isDeleting: boolean
	onToggle: (destination: AlertDestinationDocument) => void
	onTest: (destination: AlertDestinationDocument) => void
	onEdit: (destination: AlertDestinationDocument) => void
	onDelete: (destination: AlertDestinationDocument) => void
}

export function DestinationCard({
	destination,
	isAdmin,
	isTesting,
	isDeleting,
	onToggle,
	onTest,
	onEdit,
	onDelete,
}: DestinationCardProps) {
	const provider = PROVIDERS[destination.type]

	return (
		<Card
			className={cn("group relative overflow-hidden p-0 transition-colors", "hover:border-border/80")}
		>
			<div className="relative flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
				<div
					className={cn(
						"flex min-w-0 items-start gap-4 transition-opacity",
						!destination.enabled && "opacity-60",
					)}
				>
					<ProviderLogo type={destination.type} size={44} />

					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-2">
							<span className="truncate text-sm font-semibold tracking-tight">
								{destination.name}
							</span>
							<span
								className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
								style={{
									// color-mix (not hex-alpha concat) so `light-dark()` accentText values work.
									borderColor: `color-mix(in srgb, ${provider.accentText ?? provider.accent} 33%, transparent)`,
									color: provider.accentText ?? provider.accent,
									backgroundColor: provider.accentBg,
								}}
							>
								{provider.label}
							</span>
						</div>

						<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
							<span className="truncate font-mono text-[13px] text-foreground/70">
								{destination.summary}
							</span>
							<span aria-hidden className="text-muted-foreground/50">
								·
							</span>
							<span>
								tested{" "}
								{destination.lastTestedAt
									? formatRelativeTime(destination.lastTestedAt)
									: "never"}
							</span>
							{!destination.enabled && (
								<>
									<span aria-hidden className="text-muted-foreground/50">
										·
									</span>
									<span className="font-medium uppercase tracking-wide text-muted-foreground/80">
										Disabled
									</span>
								</>
							)}
						</div>

						{destination.lastTestError && (
							<div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
								<AlertWarningIcon size={12} className="mt-0.5 shrink-0" />
								<span className="break-words">{destination.lastTestError}</span>
							</div>
						)}
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-2">
					<Switch
						checked={destination.enabled}
						onCheckedChange={() => onToggle(destination)}
						disabled={!isAdmin}
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={() => onTest(destination)}
						disabled={!isAdmin || isTesting}
					>
						{isTesting ? (
							<LoaderIcon size={14} className="animate-spin" />
						) : (
							<CheckIcon size={14} />
						)}
						Send test
					</Button>
					{isAdmin && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button variant="ghost" size="icon-sm" className="shrink-0" />}
							>
								<DotsVerticalIcon size={14} />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => onEdit(destination)}>
									<PencilIcon size={14} />
									Edit
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => onDelete(destination)}
									disabled={isDeleting}
								>
									<TrashIcon size={14} />
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>
		</Card>
	)
}
