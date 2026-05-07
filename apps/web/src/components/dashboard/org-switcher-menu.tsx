import { useState, type FormEvent, type ReactElement } from "react"
import { useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { CheckIcon, PlusIcon } from "@/components/icons"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Button } from "@maple/ui/components/ui/button"

export function OrgAvatar({
	name,
	imageUrl,
	className,
}: {
	name: string
	imageUrl?: string | null
	className?: string
}) {
	const initial = name.charAt(0).toUpperCase()
	const baseClass = className ?? "size-8"
	return imageUrl ? (
		<img
			src={imageUrl}
			alt={name}
			className={`${baseClass} shrink-0 rounded-md object-cover`}
		/>
	) : (
		<div
			className={`${baseClass} flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold`}
		>
			{initial}
		</div>
	)
}

export function ClerkOrgSwitcherMenu({
	trigger,
	contentSide = "bottom",
	contentAlign = "start",
}: {
	trigger: ReactElement
	contentSide?: "top" | "right" | "bottom" | "left"
	contentAlign?: "start" | "center" | "end"
}) {
	const { organization } = useOrganization()
	const { userMemberships, setActive, createOrganization } = useOrganizationList({
		userMemberships: { infinite: true },
	})
	const [showCreateDialog, setShowCreateDialog] = useState(false)
	const [newOrgName, setNewOrgName] = useState("")
	const [isCreating, setIsCreating] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)

	const switchOrganization = async (nextOrgId: string) => {
		if (!setActive || organization?.id === nextOrgId) return
		await setActive({ organization: nextOrgId })
		window.location.reload()
	}

	const handleCreateOrg = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		if (isCreating || !createOrganization) return

		setIsCreating(true)
		setErrorMessage(null)

		try {
			const newOrg = await createOrganization({ name: newOrgName.trim() })
			await switchOrganization(newOrg.id)
			return
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to create organization")
		} finally {
			setIsCreating(false)
		}
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger render={trigger} />
				<DropdownMenuContent
					side={contentSide}
					align={contentAlign}
					sideOffset={4}
					className="min-w-56"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Organizations</DropdownMenuLabel>
						{userMemberships?.data?.map((mem) => (
							<DropdownMenuItem
								key={mem.organization.id}
								onClick={() => void switchOrganization(mem.organization.id)}
							>
								<OrgAvatar
									name={mem.organization.name}
									imageUrl={mem.organization.imageUrl}
								/>
								<span className="truncate">{mem.organization.name}</span>
								{organization?.id === mem.organization.id && (
									<CheckIcon size={16} className="ml-auto" />
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem onClick={() => setShowCreateDialog(true)}>
							<PlusIcon size={16} />
							Create Organization
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog
				open={showCreateDialog}
				onOpenChange={(open) => {
					setShowCreateDialog(open)
					if (!open) {
						setNewOrgName("")
						setErrorMessage(null)
					}
				}}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Create Organization</DialogTitle>
						<DialogDescription>
							Create a new organization to collaborate with your team.
						</DialogDescription>
					</DialogHeader>
					<form className="space-y-3" onSubmit={handleCreateOrg}>
						<Input
							placeholder="Organization name"
							value={newOrgName}
							onChange={(e) => setNewOrgName(e.target.value)}
							disabled={isCreating}
							required
							autoFocus
						/>
						{errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
						<Button type="submit" className="w-full" disabled={isCreating || !newOrgName.trim()}>
							{isCreating ? "Creating..." : "Create"}
						</Button>
					</form>
				</DialogContent>
			</Dialog>
		</>
	)
}
