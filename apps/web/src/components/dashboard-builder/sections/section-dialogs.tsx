import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { TrashIcon } from "@/components/icons"

// Both destructive section actions offer the same shape of choice: keep the
// widgets somewhere sensible, or delete them along with their container. Naming
// the destination in the button label ("Move to Overview") is what stops the
// choice from reading as "delete" vs "delete differently" — the whole point is
// that one of these options is not destructive at all.

interface DeleteSectionDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	sectionTitle: string
	widgetCount: number
	onConfirm: (action: "ungroup" | "delete") => void
}

export function DeleteSectionDialog({
	open,
	onOpenChange,
	sectionTitle,
	widgetCount,
	onConfirm,
}: DeleteSectionDialogProps) {
	const confirm = (action: "ungroup" | "delete") => {
		onConfirm(action)
		onOpenChange(false)
	}

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogMedia className="bg-destructive/10">
						<TrashIcon className="text-destructive" />
					</AlertDialogMedia>
					<AlertDialogTitle>Delete “{sectionTitle}”?</AlertDialogTitle>
					<AlertDialogDescription>
						{widgetCount === 0
							? "This group is empty, so nothing else will be removed."
							: `This group holds ${widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`}. Keep them on the dashboard, or delete them with the group.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					{widgetCount > 0 && (
						<AlertDialogAction variant="outline" onClick={() => confirm("ungroup")}>
							Keep widgets
						</AlertDialogAction>
					)}
					<AlertDialogAction variant="destructive" onClick={() => confirm("delete")}>
						{widgetCount === 0 ? "Delete group" : "Delete group & widgets"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

interface DeleteTabDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	tabTitle: string
	/** The tab widgets move into — named in the button so the choice is concrete. */
	destinationTitle: string
	widgetCount: number
	onConfirm: (action: "move" | "delete") => void
}

export function DeleteTabDialog({
	open,
	onOpenChange,
	tabTitle,
	destinationTitle,
	widgetCount,
	onConfirm,
}: DeleteTabDialogProps) {
	const confirm = (action: "move" | "delete") => {
		onConfirm(action)
		onOpenChange(false)
	}

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogMedia className="bg-destructive/10">
						<TrashIcon className="text-destructive" />
					</AlertDialogMedia>
					<AlertDialogTitle>Delete tab “{tabTitle}”?</AlertDialogTitle>
					<AlertDialogDescription>
						{widgetCount === 0
							? "This tab is empty, so nothing else will be removed."
							: `This tab holds ${widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`}.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					{widgetCount > 0 && (
						<AlertDialogAction variant="outline" onClick={() => confirm("move")}>
							Move to “{destinationTitle}”
						</AlertDialogAction>
					)}
					<AlertDialogAction variant="destructive" onClick={() => confirm("delete")}>
						{widgetCount === 0 ? "Delete tab" : "Delete tab & widgets"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
