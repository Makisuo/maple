import { useState, type FormEvent } from "react"
import {
  useOrganization,
  useOrganizationList,
} from "@clerk/clerk-react"
import {
  CheckIcon,
  ChevronExpandYIcon,
  PlusIcon,
  ServerIcon,
} from "@/components/icons"
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@maple/ui/components/ui/sidebar"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Button } from "@maple/ui/components/ui/button"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

function OrgAvatar({
  name,
  imageUrl,
}: {
  name: string
  imageUrl?: string | null
}) {
  const initial = name.charAt(0).toUpperCase()
  return imageUrl ? (
    <img
      src={imageUrl}
      alt={name}
      className="size-8 shrink-0 rounded-md object-cover"
    />
  ) : (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold">
      {initial}
    </div>
  )
}

function ClerkOrgSwitcher() {
  const { organization } = useOrganization()
  const { userMemberships, setActive, createOrganization } =
    useOrganizationList({
      userMemberships: { infinite: true },
    })
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newOrgName, setNewOrgName] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const orgName = organization?.name ?? "Select Organization"
  const orgImageUrl = organization?.imageUrl

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
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create organization",
      )
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            />
          }
        >
          <OrgAvatar name={orgName} imageUrl={orgImageUrl} />
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{orgName}</span>
            <span className="truncate text-xs text-muted-foreground">
              Organization
            </span>
          </div>
          <ChevronExpandYIcon size={16} className="ml-auto" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
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
            {errorMessage && (
              <p className="text-sm text-destructive">{errorMessage}</p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={isCreating || !newOrgName.trim()}
            >
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SelfHostedOrgSwitcher() {
  return (
    <SidebarMenuButton size="lg" className="cursor-default hover:bg-transparent active:bg-transparent">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ServerIcon size={16} />
      </div>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">Self Hosted</span>
      </div>
    </SidebarMenuButton>
  )
}

export function OrgSwitcher() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {isClerkAuthEnabled ? <ClerkOrgSwitcher /> : <SelfHostedOrgSwitcher />}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
