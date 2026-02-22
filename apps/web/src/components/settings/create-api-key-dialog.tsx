import { useAtomRefresh, useAtomSet } from "@effect-atom/atom-react"
import { useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
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
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { CheckIcon, CopyIcon } from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

interface CreateApiKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (secret: string) => void
}

export function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateApiKeyDialogProps) {
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)

  const listQueryAtom = MapleApiAtomClient.query("apiKeys", "list", {})
  const refreshKeys = useAtomRefresh(listQueryAtom)
  const createMutation = useAtomSet(
    MapleApiAtomClient.mutation("apiKeys", "create"),
    { mode: "promiseExit" },
  )

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
      onCreated?.(result.value.secret)
    } else {
      toast.error("Failed to create API key")
    }
    setIsCreating(false)
  }

  function handleClose(nextOpen: boolean) {
    if (nextOpen) {
      onOpenChange(true)
      return
    }
    onOpenChange(false)
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
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
                Store this key in a secure location. It will not be shown again.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
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
              <Button variant="outline" onClick={() => handleClose(false)}>
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
  )
}
