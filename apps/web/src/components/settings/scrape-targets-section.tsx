import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Button } from "@maple/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
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
import { Switch } from "@maple/ui/components/ui/switch"
import { Badge } from "@maple/ui/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import {
  CircleCheckIcon,
  CircleXmarkIcon,
  FireIcon,
  LoaderIcon,
  PencilIcon,
  PlusIcon,
  PulseIcon,
  TrashIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

interface ScrapeTarget {
  id: string
  name: string
  serviceName: string | null
  url: string
  scrapeIntervalSeconds: number
  labelsJson: string | null
  authType: string
  hasCredentials: boolean
  enabled: boolean
  lastScrapeAt: string | null
  lastScrapeError: string | null
  createdAt: string
  updatedAt: string
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return "just now"
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const AUTH_TYPE_LABELS: Record<string, string> = {
  none: "None",
  bearer: "Bearer Token",
  basic: "Basic Auth",
}

export function ScrapeTargetsSection() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<ScrapeTarget | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)

  // Form state — used for both create and edit
  const [editingTarget, setEditingTarget] = useState<ScrapeTarget | null>(null)
  const [formName, setFormName] = useState("")
  const [formServiceName, setFormServiceName] = useState("")
  const [formUrl, setFormUrl] = useState("")
  const [formInterval, setFormInterval] = useState("15")
  const [formAuthType, setFormAuthType] = useState("none")
  const [formAuthToken, setFormAuthToken] = useState("")
  const [formAuthUsername, setFormAuthUsername] = useState("")
  const [formAuthPassword, setFormAuthPassword] = useState("")

  const listQueryAtom = MapleApiAtomClient.query("scrapeTargets", "list", {})
  const listResult = useAtomValue(listQueryAtom)
  const refreshTargets = useAtomRefresh(listQueryAtom)

  const createMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "create"), { mode: "promiseExit" })
  const updateMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "update"), { mode: "promiseExit" })
  const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "delete"), { mode: "promiseExit" })
  const probeMutation = useAtomSet(MapleApiAtomClient.mutation("scrapeTargets", "probe"), { mode: "promiseExit" })

  const targets = Result.builder(listResult)
    .onSuccess((response) => [...response.targets] as ScrapeTarget[])
    .orElse(() => [])

  async function handleProbe(target: ScrapeTarget) {
    setProbingId(target.id)
    const result = await probeMutation({ path: { targetId: target.id } })
    if (Exit.isSuccess(result)) {
      refreshTargets()
      if (result.value.success) {
        toast.success("Connection successful")
      } else {
        toast.error(`Connection failed: ${result.value.lastScrapeError}`)
      }
    } else {
      toast.error("Failed to test connection")
    }
    setProbingId(null)
  }

  function openAddDialog() {
    setEditingTarget(null)
    setFormName("")
    setFormServiceName("")
    setFormUrl("")
    setFormInterval("15")
    setFormAuthType("none")
    setFormAuthToken("")
    setFormAuthUsername("")
    setFormAuthPassword("")
    setDialogOpen(true)
  }

  function openEditDialog(target: ScrapeTarget) {
    setEditingTarget(target)
    setFormName(target.name)
    setFormServiceName(target.serviceName ?? "")
    setFormUrl(target.url)
    setFormInterval(String(target.scrapeIntervalSeconds))
    setFormAuthType(target.authType)
    setFormAuthToken("")
    setFormAuthUsername("")
    setFormAuthPassword("")
    setDialogOpen(true)
  }

  function buildAuthCredentials(): string | null {
    if (formAuthType === "bearer") {
      if (!formAuthToken.trim()) {
        if (editingTarget?.hasCredentials && editingTarget.authType === "bearer") {
          return null // keep existing
        }
        return null
      }
      return JSON.stringify({ token: formAuthToken.trim() })
    }
    if (formAuthType === "basic") {
      if (!formAuthUsername.trim() && !formAuthPassword.trim()) {
        if (editingTarget?.hasCredentials && editingTarget.authType === "basic") {
          return null // keep existing
        }
        return null
      }
      return JSON.stringify({
        username: formAuthUsername.trim(),
        password: formAuthPassword.trim(),
      })
    }
    return null
  }

  async function handleSave() {
    if (!formName.trim() || !formUrl.trim()) {
      toast.error("Name and URL are required")
      return
    }

    setIsSaving(true)
    const authCredentials = buildAuthCredentials()

    if (editingTarget) {
      const result = await updateMutation({
        path: { targetId: editingTarget.id },
        payload: {
          name: formName.trim(),
          url: formUrl.trim(),
          scrapeIntervalSeconds: Number.parseInt(formInterval, 10) || 15,
          serviceName: formServiceName.trim() || null,
          authType: formAuthType,
          ...(authCredentials !== null ? { authCredentials } : {}),
        },
      })
      if (Exit.isSuccess(result)) {
        toast.success("Scrape target updated")
        setDialogOpen(false)
        refreshTargets()
      } else {
        toast.error("Failed to update scrape target")
      }
    } else {
      const result = await createMutation({
        payload: {
          name: formName.trim(),
          url: formUrl.trim(),
          scrapeIntervalSeconds: Number.parseInt(formInterval, 10) || 15,
          serviceName: formServiceName.trim() || null,
          authType: formAuthType,
          ...(authCredentials !== null ? { authCredentials } : {}),
        },
      })
      if (Exit.isSuccess(result)) {
        toast.success("Scrape target created")
        setDialogOpen(false)
        refreshTargets()
      } else {
        toast.error("Failed to create scrape target")
      }
    }
    setIsSaving(false)
  }

  async function handleDelete(targetId: string) {
    setDeleteConfirmTarget(null)
    setDeletingId(targetId)
    const result = await deleteMutation({ path: { targetId } })
    if (Exit.isSuccess(result)) {
      toast.success("Scrape target deleted")
      refreshTargets()
    } else {
      toast.error("Failed to delete scrape target")
    }
    setDeletingId(null)
  }

  async function handleToggleEnabled(target: ScrapeTarget) {
    setTogglingId(target.id)
    const result = await updateMutation({
      path: { targetId: target.id },
      payload: { enabled: !target.enabled },
    })
    if (Exit.isSuccess(result)) {
      refreshTargets()
    } else {
      toast.error("Failed to update scrape target")
    }
    setTogglingId(null)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-1.5">
              <FireIcon size={14} className="text-muted-foreground" />
              Prometheus
            </CardTitle>
            <CardDescription>
              Scrape metrics from Prometheus exporter endpoints.
            </CardDescription>
          </div>
          <Button size="sm" onClick={openAddDialog}>
            <PlusIcon size={14} />
            Add Target
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {Result.isInitial(listResult) ? (
          <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm justify-center">
            <LoaderIcon size={14} className="animate-spin" />
            Loading...
          </div>
        ) : !Result.isSuccess(listResult) ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            Failed to load scrape targets.
          </div>
        ) : targets.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            No scrape targets configured. Add a Prometheus exporter endpoint to get
            started.
          </div>
        ) : (
          <div className="space-y-3">
            {targets.map((target) => (
              <div
                key={target.id}
                className="flex items-center gap-3 rounded-md border p-3"
              >
                <Switch
                  checked={target.enabled}
                  onCheckedChange={() => handleToggleEnabled(target)}
                  disabled={togglingId === target.id}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {target.name}
                    </span>
                    {target.serviceName && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {target.serviceName}
                      </Badge>
                    )}
                    {target.authType !== "none" && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {AUTH_TYPE_LABELS[target.authType] ?? target.authType}
                      </Badge>
                    )}
                    {target.lastScrapeError ? (
                      <Badge variant="destructive" className="text-[10px] gap-1 px-1.5 py-0">
                        <CircleXmarkIcon size={10} />
                        Error
                      </Badge>
                    ) : target.lastScrapeAt ? (
                      <Badge variant="secondary" className="text-[10px] gap-1 px-1.5 py-0">
                        <CircleCheckIcon size={10} />
                        OK
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        Pending
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs truncate">
                    {target.url}
                    <span className="mx-1.5">·</span>
                    {target.scrapeIntervalSeconds}s interval
                    {target.lastScrapeAt && (
                      <>
                        <span className="mx-1.5">·</span>
                        Last scraped {formatRelativeTime(target.lastScrapeAt)}
                      </>
                    )}
                  </div>
                  {target.lastScrapeError && (
                    <div className="text-destructive text-xs mt-0.5 truncate">
                      {target.lastScrapeError}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleProbe(target)}
                  disabled={probingId === target.id}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  title="Test connection"
                >
                  {probingId === target.id ? (
                    <LoaderIcon size={14} className="animate-spin" />
                  ) : (
                    <PulseIcon size={14} />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => openEditDialog(target)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <PencilIcon size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleteConfirmTarget(target)}
                  disabled={deletingId === target.id}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <TrashIcon size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingTarget ? "Edit Scrape Target" : "Add Scrape Target"}
            </DialogTitle>
            <DialogDescription>
              {editingTarget
                ? "Update the scrape target configuration."
                : "Enter the URL of a Prometheus exporter endpoint. Maple will periodically scrape this endpoint for metrics."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="scrape-name">Name</Label>
              <Input
                id="scrape-name"
                placeholder="e.g. Node Exporter"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scrape-service-name">Service Name</Label>
              <Input
                id="scrape-service-name"
                placeholder="e.g. my-api-server"
                value={formServiceName}
                onChange={(e) => setFormServiceName(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Metrics will appear under this service name. Defaults to the target name if empty.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="scrape-url">URL</Label>
              <Input
                id="scrape-url"
                placeholder="e.g. https://myapp.com:9090/metrics"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scrape-interval">Scrape Interval (seconds)</Label>
              <Input
                id="scrape-interval"
                type="number"
                min={5}
                max={300}
                value={formInterval}
                onChange={(e) => setFormInterval(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Authentication</Label>
              <Select
                value={formAuthType}
                onValueChange={(val: string | null) => {
                  setFormAuthType(val ?? "none")
                  setFormAuthToken("")
                  setFormAuthUsername("")
                  setFormAuthPassword("")
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select auth type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer Token</SelectItem>
                  <SelectItem value="basic">Basic Auth</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formAuthType === "bearer" && (
              <div className="space-y-2">
                <Label htmlFor="scrape-auth-token">Bearer Token</Label>
                <Input
                  id="scrape-auth-token"
                  type="password"
                  placeholder={
                    editingTarget?.hasCredentials && editingTarget.authType === "bearer"
                      ? "Leave blank to keep existing"
                      : "Enter bearer token"
                  }
                  value={formAuthToken}
                  onChange={(e) => setFormAuthToken(e.target.value)}
                />
              </div>
            )}
            {formAuthType === "basic" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="scrape-auth-username">Username</Label>
                  <Input
                    id="scrape-auth-username"
                    placeholder={
                      editingTarget?.hasCredentials && editingTarget.authType === "basic"
                        ? "Leave blank to keep existing"
                        : "Enter username"
                    }
                    value={formAuthUsername}
                    onChange={(e) => setFormAuthUsername(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scrape-auth-password">Password</Label>
                  <Input
                    id="scrape-auth-password"
                    type="password"
                    placeholder={
                      editingTarget?.hasCredentials && editingTarget.authType === "basic"
                        ? "Leave blank to keep existing"
                        : "Enter password"
                    }
                    value={formAuthPassword}
                    onChange={(e) => setFormAuthPassword(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <LoaderIcon size={14} className="animate-spin" />
                  {editingTarget ? "Saving..." : "Adding..."}
                </>
              ) : editingTarget ? (
                "Save Changes"
              ) : (
                "Add Target"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deleteConfirmTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteConfirmTarget(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scrape target</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {deleteConfirmTarget?.name}
              </span>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteConfirmTarget) {
                  void handleDelete(deleteConfirmTarget.id)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
