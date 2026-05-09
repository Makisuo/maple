import type { AlertDestinationDocument } from "@maple/domain/http"
import { PROVIDERS, ProviderLogo } from "@/components/alerts/destination-provider"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import {
	AlertWarningIcon,
	CheckIcon,
	DotsVerticalIcon,
	LoaderIcon,
	PencilIcon,
	TrashIcon,
} from "@/components/icons"
import { formatRelativeTime } from "@/lib/format"
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
	const isHealthy = destination.enabled && !destination.lastTestError

	return (
		<Card
			className={cn("group relative overflow-hidden p-0 transition-colors", "hover:border-border/80")}
		>
			<span
				aria-hidden
				className="pointer-events-none absolute -left-12 -top-12 size-32 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-60"
				style={{ background: provider.accentBg }}
			/>

			<div className="relative flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
				<div className="flex min-w-0 items-start gap-4">
					<ProviderLogo type={destination.type} size={44} />

					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-2">
							<span className="truncate text-sm font-semibold tracking-tight">
								{destination.name}
							</span>
							<span
								className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
								style={{
									borderColor: `${provider.accentText ?? provider.accent}55`,
									color: provider.accentText ?? provider.accent,
									backgroundColor: provider.accentBg,
								}}
							>
								{provider.label}
							</span>
							<AlertStatusBadge
								state={destination.enabled ? "ok" : "disabled"}
								label={destination.enabled ? "Enabled" : "Disabled"}
							/>
							{isHealthy && destination.lastTestedAt && (
								<span className="relative inline-flex items-center" aria-hidden>
									<span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-emerald-400 opacity-75" />
									<span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
								</span>
							)}
						</div>

						<div className="truncate font-mono text-[13px] text-muted-foreground">
							{destination.summary}
						</div>

						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/80">
							<span>
								Last tested{" "}
								<span className="text-foreground/70">
									{destination.lastTestedAt
										? formatRelativeTime(destination.lastTestedAt)
										: "never"}
								</span>
							</span>
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
