import { useOrganization, useAuth } from "@clerk/clerk-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Badge } from "@maple/ui/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import {
  PlusIcon,
  DotsVerticalIcon,
  TrashIcon,
  ShieldIcon,
  UserIcon,
  EnvelopeIcon,
  AlertWarningIcon,
} from "@/components/icons"

function getInitials(firstName?: string | null, lastName?: string | null) {
  const first = firstName?.[0] ?? ""
  const last = lastName?.[0] ?? ""
  return (first + last).toUpperCase() || "?"
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

function roleBadge(role: string) {
  if (role === "org:admin") {
    return <Badge variant="outline">Admin</Badge>
  }
  return <Badge variant="secondary">Member</Badge>
}

export function MembersSection() {
  const { orgRole, userId } = useAuth()
  const { organization, memberships, invitations, isLoaded } = useOrganization({
    memberships: { infinite: true },
    invitations: { infinite: true, status: ["pending"] },
  })

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<string>("org:member")
  const [inviteLoading, setInviteLoading] = useState(false)

  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<{
    id: string
    name: string
    destroy: () => Promise<unknown>
  } | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)

  const isAdmin = orgRole === "org:admin"

  async function handleInvite() {
    if (!organization || !inviteEmail.trim()) return
    setInviteLoading(true)
    try {
      await organization.inviteMember({
        emailAddress: inviteEmail.trim(),
        role: inviteRole as "org:admin" | "org:member",
      })
      toast.success(`Invitation sent to ${inviteEmail}`)
      setInviteEmail("")
      setInviteRole("org:member")
      setInviteOpen(false)
      invitations?.revalidate?.()
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to send invitation"
      toast.error(message)
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleRoleChange(
    currentRole: string,
    update: (params: { role: string }) => Promise<unknown>,
  ) {
    const newRole =
      currentRole === "org:admin" ? "org:member" : "org:admin"
    try {
      await update({ role: newRole })
      toast.success(`Role updated to ${newRole === "org:admin" ? "Admin" : "Member"}`)
      memberships?.revalidate?.()
    } catch {
      toast.error("Failed to update role")
    }
  }

  async function handleRemoveMember() {
    if (!memberToRemove) return
    setRemoveLoading(true)
    try {
      await memberToRemove.destroy()
      toast.success(`${memberToRemove.name} has been removed`)
      memberships?.revalidate?.()
    } catch {
      toast.error("Failed to remove member")
    } finally {
      setRemoveLoading(false)
      setRemoveDialogOpen(false)
      setMemberToRemove(null)
    }
  }

  async function handleRevokeInvitation(
    revoke: () => Promise<unknown>,
    email: string,
  ) {
    try {
      await revoke()
      toast.success(`Invitation to ${email} revoked`)
      invitations?.revalidate?.()
    } catch {
      toast.error("Failed to revoke invitation")
    }
  }

  if (!isLoaded) {
    return (
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!organization) {
    return (
      <div className="max-w-2xl">
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <UserIcon size={20} />
            </EmptyMedia>
            <EmptyTitle>No organization</EmptyTitle>
            <EmptyDescription>
              Select or create an organization to manage members.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const memberList = memberships?.data ?? []
  const invitationList = invitations?.data ?? []

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="space-y-1">
            <CardTitle>Members</CardTitle>
            <CardDescription>
              Manage who has access to this organization.
            </CardDescription>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <PlusIcon size={14} />
              Invite member
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {memberList.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  <UserIcon size={20} />
                </EmptyMedia>
                <EmptyTitle>No members</EmptyTitle>
                <EmptyDescription>
                  This organization has no members yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  {isAdmin && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberList.map((member) => {
                  const userData = member.publicUserData
                  const isCurrentUser = userData?.userId === userId
                  const memberName =
                    [userData?.firstName, userData?.lastName]
                      .filter(Boolean)
                      .join(" ") || userData?.identifier || "Unknown"

                  return (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar size="sm">
                            <AvatarImage src={userData?.imageUrl} />
                            <AvatarFallback>
                              {getInitials(
                                userData?.firstName,
                                userData?.lastName,
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="text-xs font-medium truncate">
                              {memberName}
                              {isCurrentUser && (
                                <span className="text-muted-foreground ml-1">
                                  (you)
                                </span>
                              )}
                            </div>
                            <div className="text-muted-foreground text-xs truncate">
                              {userData?.identifier}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{roleBadge(member.role)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDate(member.createdAt)}
                      </TableCell>
                      {isAdmin && (
                        <TableCell>
                          {!isCurrentUser && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button variant="ghost" size="icon" className="size-7" />
                                }
                              >
                                <DotsVerticalIcon size={14} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() =>
                                    handleRoleChange(
                                      member.role,
                                      (params) => member.update(params),
                                    )
                                  }
                                >
                                  <ShieldIcon size={14} />
                                  {member.role === "org:admin"
                                    ? "Change to Member"
                                    : "Change to Admin"}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => {
                                    setMemberToRemove({
                                      id: member.id,
                                      name: memberName,
                                      destroy: () => member.destroy(),
                                    })
                                    setRemoveDialogOpen(true)
                                  }}
                                >
                                  <TrashIcon size={14} />
                                  Remove member
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {invitationList.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending Invitations</CardTitle>
            <CardDescription>
              Invitations that have been sent but not yet accepted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  {isAdmin && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitationList.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar size="sm">
                          <AvatarFallback>
                            <EnvelopeIcon size={12} />
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-xs">{invitation.emailAddress}</span>
                      </div>
                    </TableCell>
                    <TableCell>{roleBadge(invitation.role)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">Pending</Badge>
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive text-xs"
                          onClick={() =>
                            handleRevokeInvitation(
                              () => invitation.revoke(),
                              invitation.emailAddress,
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>
              Send an invitation to join {organization.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="invite-email" className="text-xs font-medium">
                Email address
              </Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role" className="text-xs font-medium">
                Role
              </Label>
              <Select
                value={inviteRole}
                onValueChange={(val) => val && setInviteRole(val)}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue placeholder="Select role">
                    {inviteRole === "org:admin" ? "Admin" : "Member"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org:member">Member</SelectItem>
                  <SelectItem value="org:admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInviteOpen(false)}
              disabled={inviteLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleInvite}
              disabled={inviteLoading || !inviteEmail.trim()}
            >
              {inviteLoading ? "Sending..." : "Send invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <AlertWarningIcon className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>Remove member?</AlertDialogTitle>
            <AlertDialogDescription>
              {memberToRemove?.name} will lose access to this organization
              immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleRemoveMember}
              disabled={removeLoading}
            >
              {removeLoading ? "Removing..." : "Remove member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
