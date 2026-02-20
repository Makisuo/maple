import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
import { Badge } from "@maple/ui/components/ui/badge"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@maple/ui/components/ui/dialog"
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  AlertWarningIcon,
  CheckIcon,
  CopyIcon,
  KeyIcon,
  PlusIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

interface ApiKey {
  id: string
  name: string
  description: string | null
  keyPrefix: string
  revoked: boolean
  createdAt: number
  lastUsedAt: number | null
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return "Never"
  try {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return "Unknown"
  }
}

export function ApiKeysSection() {
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  const listQueryAtom = MapleApiAtomClient.query("apiKeys", "list", {})
  const listResult = useAtomValue(listQueryAtom)
  const refreshKeys = useAtomRefresh(listQueryAtom)

  const createMutation = useAtomSet(MapleApiAtomClient.mutation("apiKeys", "create"), { mode: "promiseExit" })
  const revokeMutation = useAtomSet(MapleApiAtomClient.mutation("apiKeys", "revoke"), { mode: "promiseExit" })

  const keys = Result.builder(listResult)
    .onSuccess((response) =>
      response.keys.map((k) => ({
        id: k.id,
        name: k.name,
        description: k.description,
        keyPrefix: k.keyPrefix,
        revoked: k.revoked,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    )
    .orElse(() => [])

  async function handleCreate() {
    if (!newName.trim()) return
    setIsCreating(true)
    const result = await createMutation({
      payload: {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      },
    })
    if (Exit.isSuccess(result)) {
      setNewSecret(result.value.secret)
      refreshKeys()
    } else {
      toast.error("Failed to create API key")
    }
    setIsCreating(false)
  }

  function handleCreateDialogClose(open: boolean) {
    if (open) {
      setCreateOpen(true)
      return
    }
    setCreateOpen(false)
    setNewName("")
    setNewDescription("")
    setNewSecret(null)
    setSecretCopied(false)
  }

  async function handleCopySecret() {
    if (!newSecret) return
    try {
      await navigator.clipboard.writeText(newSecret)
      setSecretCopied(true)
      toast.success("API key copied to clipboard")
      setTimeout(() => setSecretCopied(false), 2000)
    } catch {
      toast.error("Failed to copy API key")
    }
  }

  function openRevokeDialog(keyId: string) {
    setRevokingKeyId(keyId)
    setRevokeOpen(true)
  }

  async function handleRevoke() {
    if (!revokingKeyId) return
    setIsRevoking(true)
    const result = await revokeMutation({ path: { keyId: revokingKeyId } })
    if (Exit.isSuccess(result)) {
      toast.success("API key revoked")
      refreshKeys()
    } else {
      toast.error("Failed to revoke API key")
    }
    setIsRevoking(false)
    setRevokeOpen(false)
    setRevokingKeyId(null)
  }

  const activeKeys = keys.filter((k) => !k.revoked)
  const revokedKeys = keys.filter((k) => k.revoked)

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle>API Keys</CardTitle>
              <CardDescription>
                Create and manage API keys for programmatic access to Maple. Keys
                are scoped to your current organization.
              </CardDescription>
            </div>
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <PlusIcon data-icon="inline-start" size={14} />
              Create key
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {Result.isInitial(listResult) ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !Result.isSuccess(listResult) ? (
            <p className="text-sm text-muted-foreground">Failed to load API keys</p>
          ) : keys.length === 0 ? (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyIcon size={16} />
                </EmptyMedia>
                <EmptyTitle>No API keys</EmptyTitle>
                <EmptyDescription>
                  Create an API key to authenticate with the Maple API and MCP
                  server.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-4">
              {activeKeys.length > 0 && (
                <div className="space-y-2">
                  {activeKeys.map((key) => (
                    <ApiKeyListItem
                      key={key.id}
                      apiKey={key}
                      onRevoke={() => openRevokeDialog(key.id)}
                    />
                  ))}
                </div>
              )}
              {revokedKeys.length > 0 && (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs font-medium">
                    Revoked
                  </p>
                  {revokedKeys.map((key) => (
                    <ApiKeyListItem key={key.id} apiKey={key} />
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={handleCreateDialogClose}>
        <DialogContent>
          {newSecret ? (
            <>
              <DialogHeader>
                <DialogTitle>API key created</DialogTitle>
                <DialogDescription>
                  Copy your API key now. You won't be able to see it again.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <InputGroup>
                  <InputGroupInput
                    readOnly
                    value={newSecret}
                    className="font-mono text-xs tracking-wide select-all"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={handleCopySecret}
                      aria-label="Copy API key"
                      title={secretCopied ? "Copied!" : "Copy"}
                    >
                      {secretCopied ? (
                        <CheckIcon size={14} className="text-emerald-500" />
                      ) : (
                        <CopyIcon size={14} />
                      )}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <p className="text-muted-foreground text-xs">
                  Store this key in a secure location. It will not be shown
                  again.
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => handleCreateDialogClose(false)}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  API keys are used to authenticate with the Maple API and MCP
                  server.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    placeholder="e.g. CI/CD Pipeline"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newName.trim()) {
                        void handleCreate()
                      }
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-description">
                    Description{" "}
                    <span className="text-muted-foreground font-normal">
                      (optional)
                    </span>
                  </Label>
                  <Input
                    id="api-key-description"
                    placeholder="What is this key used for?"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => handleCreateDialogClose(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={!newName.trim() || isCreating}
                >
                  {isCreating ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <AlertWarningIcon className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Any integrations using this key will
              stop working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleRevoke}
              disabled={isRevoking}
            >
              {isRevoking ? "Revoking..." : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ApiKeyListItem({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKey
  onRevoke?: () => void
}) {
  return (
    <div className="bg-muted/30 flex items-center justify-between border px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{apiKey.name}</span>
            <Badge variant={apiKey.revoked ? "destructive" : "secondary"}>
              {apiKey.revoked ? "Revoked" : "Active"}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{apiKey.keyPrefix}</span>
            {" · "}Created {formatDate(apiKey.createdAt)}
            {apiKey.lastUsedAt && <> · Last used {formatDate(apiKey.lastUsedAt)}</>}
          </p>
        </div>
      </div>
      {!apiKey.revoked && onRevoke && (
        <Button variant="ghost" size="xs" onClick={onRevoke}>
          Revoke
        </Button>
      )}
    </div>
  )
}
