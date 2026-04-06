import { useEffect, useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { UpsertDigestSubscriptionRequest } from "@maple/domain/http"
import { useUser } from "@clerk/clerk-react"

import { Button } from "@maple/ui/components/ui/button"
import { Switch } from "@maple/ui/components/ui/switch"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { EnvelopeIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"

export function NotificationsSection() {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress

  const subscriptionQueryAtom = MapleApiAtomClient.query("digest", "getSubscription", {})
  const subscriptionResult = useAtomValue(subscriptionQueryAtom)
  const refreshSubscription = useAtomRefresh(subscriptionQueryAtom)

  const upsertMutation = useAtomSet(
    MapleApiAtomClient.mutation("digest", "upsertSubscription"),
    { mode: "promiseExit" },
  )

  const [enabled, setEnabled] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)

  const previewMutation = useAtomSet(
    MapleApiAtomClient.mutation("digest", "preview"),
    { mode: "promiseExit" },
  )

  useEffect(() => {
    if (initialized) return
    if (Result.isSuccess(subscriptionResult)) {
      setEnabled(subscriptionResult.value.enabled)
      setInitialized(true)
    } else if (!Result.isInitial(subscriptionResult)) {
      setEnabled(true)
      setInitialized(true)
    }
  }, [subscriptionResult, initialized])

  async function handleToggle(checked: boolean) {
    if (!email) return

    setEnabled(checked)
    setIsSaving(true)

    const result = await upsertMutation({
      payload: new UpsertDigestSubscriptionRequest({ email, enabled: checked }),
    })

    if (Exit.isSuccess(result)) {
      refreshSubscription()
      toast.success(checked ? "Weekly digest enabled" : "Weekly digest disabled")
    } else {
      toast.error("Failed to update notification preferences")
      setEnabled(!checked)
    }
    setIsSaving(false)
  }

  async function handlePreview() {
    setIsPreviewing(true)
    const result = await previewMutation({})
    if (Exit.isSuccess(result)) {
      const win = window.open("", "_blank")
      if (win) {
        win.document.write(result.value.html)
        win.document.close()
      }
    } else {
      toast.error("Failed to generate digest preview")
    }
    setIsPreviewing(false)
  }

  if (!initialized || !user) {
    return (
      <div className="max-w-xl">
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-1">
      <div
        className={cn(
          "flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors",
          enabled ? "border-primary/20 bg-primary/[0.02]" : "border-border",
        )}
      >
        <div className="flex items-center gap-3">
          <div className="text-muted-foreground">
            <EnvelopeIcon size={18} />
          </div>
          <div>
            <p className="text-sm font-medium">Email</p>
            <p className="text-muted-foreground text-xs">Weekly digest via email</p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={isSaving || !email}
        />
      </div>
      {enabled && (
        <Button
          variant="outline"
          size="sm"
          onClick={handlePreview}
          disabled={isPreviewing}
        >
          {isPreviewing ? "Generating..." : "Preview Digest"}
        </Button>
      )}
    </div>
  )
}
