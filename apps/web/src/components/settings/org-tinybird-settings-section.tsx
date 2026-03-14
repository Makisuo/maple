import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useEffect, useMemo, useState } from "react"
import { Cause, Exit, Option } from "effect"
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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
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
import { AlertWarningIcon } from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
  if (Exit.isSuccess(exit)) return fallback

  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message
  }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message
  }

  const defect = Option.getOrUndefined(Cause.dieOption(exit.cause))
  if (defect instanceof Error && defect.message.trim().length > 0) {
    return defect.message
  }

  return fallback
}

function formatSyncDate(value: string | null): string {
  if (!value) return "Never"

  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value))
  } catch {
    return value
  }
}

interface OrgTinybirdSettingsSectionProps {
  isAdmin: boolean
  hasEntitlement: boolean
}

export function OrgTinybirdSettingsSection({
  isAdmin,
  hasEntitlement,
}: OrgTinybirdSettingsSectionProps) {
  const [host, setHost] = useState("")
  const [token, setToken] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [isResyncing, setIsResyncing] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [isDisabling, setIsDisabling] = useState(false)

  const settingsQueryAtom = MapleApiAtomClient.query("orgTinybirdSettings", "get", {})
  const settingsResult = useAtomValue(settingsQueryAtom)
  const refreshSettings = useAtomRefresh(settingsQueryAtom)

  const upsertMutation = useAtomSet(
    MapleApiAtomClient.mutation("orgTinybirdSettings", "upsert"),
    { mode: "promiseExit" },
  )
  const resyncMutation = useAtomSet(
    MapleApiAtomClient.mutation("orgTinybirdSettings", "resync"),
    { mode: "promiseExit" },
  )
  const deleteMutation = useAtomSet(
    MapleApiAtomClient.mutation("orgTinybirdSettings", "delete"),
    { mode: "promiseExit" },
  )

  const settings = Result.builder(settingsResult)
    .onSuccess((value) => value)
    .orElse(() => null)

  const isBusy = isSaving || isResyncing || isDisabling
  const configured = settings?.configured === true

  const isValidHost = useMemo(() => {
    const trimmed = host.trim()
    if (trimmed.length === 0) return false
    try {
      const url = new URL(trimmed)
      return url.protocol === "https:" || url.protocol === "http:"
    } catch {
      return false
    }
  }, [host])

  useEffect(() => {
    if (settings?.host) {
      setHost(settings.host)
    } else if (settings?.configured === false) {
      setHost("")
    }
  }, [settings?.configured, settings?.host])

  const statusBadge = useMemo(() => {
    if (!configured) {
      return <Badge variant="secondary">Default Maple Tinybird</Badge>
    }
    if (settings?.syncStatus === "out_of_sync") {
      return <Badge variant="secondary">Out of sync</Badge>
    }
    if (settings?.syncStatus === "active") {
      return <Badge variant="outline">Connected</Badge>
    }

    return <Badge variant="destructive">Needs attention</Badge>
  }, [configured, settings?.syncStatus])

  async function handleSave() {
    setIsSaving(true)
    const result = await upsertMutation({
      payload: {
        host,
        token,
      },
    })
    setIsSaving(false)

    if (Exit.isSuccess(result)) {
      setToken("")
      refreshSettings()
      toast.success(configured ? "Tinybird connection updated" : "Tinybird connection saved")
      return
    }

    toast.error(getExitErrorMessage(result, "Failed to save Tinybird settings"))
  }

  async function handleResync() {
    setIsResyncing(true)
    const result = await resyncMutation({})
    setIsResyncing(false)

    if (Exit.isSuccess(result)) {
      refreshSettings()
      toast.success("Tinybird project synced")
      return
    }

    toast.error(getExitErrorMessage(result, "Failed to sync Tinybird project"))
  }

  async function handleDisable() {
    setIsDisabling(true)
    const result = await deleteMutation({})
    setIsDisabling(false)
    setDisableOpen(false)

    if (Exit.isSuccess(result)) {
      setHost("")
      setToken("")
      refreshSettings()
      toast.success("BYO Tinybird disabled")
      return
    }

    toast.error(getExitErrorMessage(result, "Failed to disable BYO Tinybird"))
  }

  if (!isAdmin || !hasEntitlement) {
    return null
  }

  return (
    <>
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>BYO Tinybird</CardTitle>
                <CardDescription>
                  Route this organization&apos;s read queries through its own Tinybird Enterprise project.
                  Maple will keep the Tinybird project definition synced, but your team is responsible
                  for writing compatible data into that project.
                </CardDescription>
              </div>
              {Result.isInitial(settingsResult) ? <Skeleton className="h-6 w-36" /> : statusBadge}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {!Result.isSuccess(settingsResult) && !Result.isInitial(settingsResult) ? (
              <p className="text-sm text-muted-foreground">
                Failed to load Tinybird settings.
              </p>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="tinybird-host">Tinybird host</Label>
                  <Input
                    id="tinybird-host"
                    placeholder="https://api.tinybird.co"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    disabled={isBusy}
                  />
                  {host.trim().length > 0 && !isValidHost ? (
                    <p className="text-destructive text-xs">
                      Enter a valid URL (e.g. https://api.tinybird.co)
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="tinybird-token">Tinybird token</Label>
                  <Input
                    id="tinybird-token"
                    type="password"
                    placeholder={configured ? "Leave blank to keep the current token" : "tbp_..."}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    disabled={isBusy}
                  />
                  <p className="text-muted-foreground text-xs">
                    The token is write-only. Maple never shows the saved token again.
                  </p>
                </div>

                <div className="rounded-lg border px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Current target</span>
                    <span className="font-mono text-xs">{settings?.host ?? "Maple-managed Tinybird"}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Last sync</span>
                    <span>{formatSyncDate(settings?.lastSyncAt ?? null)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Project revision</span>
                    <span className="font-mono text-xs">{settings?.projectRevision ?? "Not configured"}</span>
                  </div>
                  {settings?.syncStatus === "out_of_sync" ? (
                    <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-800">
                      Maple&apos;s Tinybird project definition changed since this org last synced. Resync the
                      project to keep BYO queries working.
                    </div>
                  ) : null}
                  {settings?.lastSyncError ? (
                    <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-destructive">
                      {settings.lastSyncError}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void handleSave()} disabled={isBusy || !isValidHost || (!configured && token.trim().length === 0)}>
                    {isSaving ? "Saving..." : configured ? "Update connection" : "Save connection"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handleResync()}
                    disabled={isBusy || !configured}
                  >
                    {isResyncing ? "Syncing..." : "Resync project"}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setDisableOpen(true)}
                    disabled={isBusy || !configured}
                  >
                    Disable BYO
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <AlertWarningIcon className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>Disable BYO Tinybird?</AlertDialogTitle>
            <AlertDialogDescription>
              This organization will stop using its own Tinybird project immediately and fall back to
              Maple-managed Tinybird for reads.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisabling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void handleDisable()}
              disabled={isDisabling}
            >
              {isDisabling ? "Disabling..." : "Disable BYO"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
