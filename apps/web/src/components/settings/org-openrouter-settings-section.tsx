import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useState } from "react"
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
import { OrgOpenrouterSettingsUpsertRequest } from "@maple/domain/http"

function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
  if (Exit.isSuccess(exit)) return fallback

  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
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

  const defect = Cause.squash(exit.cause)
  if (defect instanceof Error && defect.message.trim().length > 0) {
    return defect.message
  }

  return fallback
}

function formatDate(value: string | null): string {
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

interface OrgOpenRouterSettingsSectionProps {
  isAdmin: boolean
  hasEntitlement: boolean
}

export function OrgOpenRouterSettingsSection({
  isAdmin,
  hasEntitlement,
}: OrgOpenRouterSettingsSectionProps) {
  const [apiKey, setApiKey] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [isDisabling, setIsDisabling] = useState(false)

  const settingsQueryAtom = MapleApiAtomClient.query("orgOpenrouterSettings", "get", {})
  const settingsResult = useAtomValue(settingsQueryAtom)
  const refreshSettings = useAtomRefresh(settingsQueryAtom)

  const upsertMutation = useAtomSet(
    MapleApiAtomClient.mutation("orgOpenrouterSettings", "upsert"),
    { mode: "promiseExit" },
  )
  const deleteMutation = useAtomSet(
    MapleApiAtomClient.mutation("orgOpenrouterSettings", "delete"),
    { mode: "promiseExit" },
  )

  const settings = Result.builder(settingsResult)
    .onSuccess((value) => value)
    .orElse(() => null)

  const configured = settings?.configured === true
  const isBusy = isSaving || isDisabling

  async function handleSave() {
    if (apiKey.trim().length === 0) {
      toast.error("Enter an OpenRouter API key")
      return
    }
    setIsSaving(true)
    const result = await upsertMutation({
      payload: new OrgOpenrouterSettingsUpsertRequest({ apiKey }),
    })
    setIsSaving(false)

    if (Exit.isSuccess(result)) {
      setApiKey("")
      refreshSettings()
      toast.success(configured ? "OpenRouter API key updated" : "OpenRouter API key saved")
      return
    }

    toast.error(getExitErrorMessage(result, "Failed to save OpenRouter API key"))
  }

  async function handleDisable() {
    setIsDisabling(true)
    const result = await deleteMutation({})
    setIsDisabling(false)
    setDisableOpen(false)

    if (Exit.isSuccess(result)) {
      setApiKey("")
      refreshSettings()
      toast.success("OpenRouter API key removed")
      return
    }

    toast.error(getExitErrorMessage(result, "Failed to remove OpenRouter API key"))
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
                <CardTitle>OpenRouter API key</CardTitle>
                <CardDescription>
                  Route this organization&apos;s AI chat calls through your own OpenRouter account.
                  Leave blank to use Maple&apos;s default key.
                </CardDescription>
              </div>
              {Result.isInitial(settingsResult) ? (
                <Skeleton className="h-6 w-28" />
              ) : configured ? (
                <Badge variant="outline">Configured</Badge>
              ) : (
                <Badge variant="secondary">Using Maple default</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {!Result.isSuccess(settingsResult) && !Result.isInitial(settingsResult) ? (
              <p className="text-sm text-muted-foreground">
                Failed to load OpenRouter settings.
              </p>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="openrouter-api-key">API key</Label>
                  <Input
                    id="openrouter-api-key"
                    type="password"
                    placeholder={configured ? "Enter a new key to replace the saved one" : "sk-or-v1-..."}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={isBusy}
                    autoComplete="off"
                  />
                  <p className="text-muted-foreground text-xs">
                    Your key is encrypted at rest and never shown again. Grab one from{" "}
                    <a
                      href="https://openrouter.ai/keys"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      openrouter.ai/keys
                    </a>
                    .
                  </p>
                </div>

                {configured ? (
                  <div className="rounded-lg border px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Saved key</span>
                      <span className="font-mono text-xs">
                        •••• {settings?.last4 ?? "????"}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Last updated</span>
                      <span>{formatDate(settings?.updatedAt ?? null)}</span>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void handleSave()}
                    disabled={isBusy || apiKey.trim().length === 0}
                  >
                    {isSaving ? "Saving..." : configured ? "Update key" : "Save key"}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setDisableOpen(true)}
                    disabled={isBusy || !configured}
                  >
                    Remove key
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
            <AlertDialogTitle>Remove OpenRouter API key?</AlertDialogTitle>
            <AlertDialogDescription>
              AI chat will fall back to Maple&apos;s default OpenRouter key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisabling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void handleDisable()}
              disabled={isDisabling}
            >
              {isDisabling ? "Removing..." : "Remove key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
