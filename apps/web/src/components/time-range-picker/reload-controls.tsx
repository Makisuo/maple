import { Button } from "@maple/ui/components/ui/button"
import { Switch } from "@maple/ui/components/ui/switch"

import { ArrowPathIcon, RadioCheckedIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"

import { LIVE_REFRESH_INTERVAL_MS, useOptionalPageRefreshContext, usePageRefreshContext } from "./page-refresh-context"

export function ReloadControls() {
  const { liveEnabled, isReloading, reload, setLiveEnabled } = usePageRefreshContext()

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={reload} disabled={isReloading}>
        <ArrowPathIcon className={cn("size-3.5", isReloading && "animate-spin")} />
        <span>Reload</span>
      </Button>
      <label className="flex h-7 items-center gap-2 border border-border bg-background px-2.5 text-xs">
        <Switch
          size="sm"
          checked={liveEnabled}
          onCheckedChange={setLiveEnabled}
          aria-label="Enable live mode"
        />
        <span className="font-medium">Live</span>
        <span className="text-[10px] text-muted-foreground">
          {Math.floor(LIVE_REFRESH_INTERVAL_MS / 1000)}s
        </span>
        <RadioCheckedIcon
          className={cn(
            "size-3 text-severity-info transition-opacity",
            liveEnabled ? "opacity-100" : "opacity-0",
          )}
        />
      </label>
    </>
  )
}

export function LiveIndicatorDot({ className }: { className?: string }) {
  const ctx = useOptionalPageRefreshContext()
  if (!ctx?.liveEnabled) return null

  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 items-center justify-center",
        className,
      )}
    >
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-severity-info opacity-60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-severity-info" />
    </span>
  )
}

export function LivePopoverFooter() {
  const ctx = useOptionalPageRefreshContext()
  if (!ctx) return null

  const { liveEnabled, isReloading, reload, setLiveEnabled } = ctx

  return (
    <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Switch
          size="sm"
          checked={liveEnabled}
          onCheckedChange={setLiveEnabled}
          aria-label="Enable live mode"
        />
        <span className="font-medium">Live</span>
        <span className="text-[10px] text-muted-foreground">
          {Math.floor(LIVE_REFRESH_INTERVAL_MS / 1000)}s
        </span>
      </label>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={reload}
        disabled={isReloading}
        className="h-7 gap-1.5 text-xs"
      >
        <ArrowPathIcon className={cn("size-3.5", isReloading && "animate-spin")} />
        Reload
      </Button>
    </div>
  )
}
