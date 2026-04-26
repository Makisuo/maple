import { useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"
import { Button } from "@maple/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { ArrowPathIcon, HistoryIcon } from "@/components/icons"
import { formatRelativeTime } from "@/lib/format"
import {
  buildRestorePayload,
  useRestoreDashboardVersion,
} from "./use-dashboard-history"
import type { PreviewedVersion } from "@/atoms/dashboard-history-atoms"

interface PreviewBannerProps {
  dashboardId: string
  preview: PreviewedVersion
  onCancel: () => void
  onRestored: () => void
}

export function PreviewBanner({
  dashboardId,
  preview,
  onCancel,
  onRestored,
}: PreviewBannerProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const restore = useRestoreDashboardVersion()

  const performRestore = async () => {
    setPending(true)
    try {
      const result = await restore(buildRestorePayload(dashboardId, preview.versionId) as never)
      if (Exit.isSuccess(result)) {
        toast.success(`Restored from v${preview.versionNumber}`)
        setConfirmOpen(false)
        onRestored()
      } else {
        toast.error("Restore failed")
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
        <HistoryIcon className="size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px] text-foreground/80">
          <span className="font-semibold text-primary">PREVIEW</span>
          <span aria-hidden className="opacity-50">·</span>
          <span>v{preview.versionNumber}</span>
          <span aria-hidden className="opacity-50">·</span>
          <span className="truncate">
            {formatRelativeTime(preview.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => setConfirmOpen(true)}
          >
            <ArrowPathIcon size={14} data-icon="inline-start" />
            Restore this version
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore version v{preview.versionNumber}?</DialogTitle>
            <DialogDescription>
              The current dashboard will be replaced with this version. The
              current state will be saved as a new history entry, so this is
              undoable.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              variant="default"
              onClick={performRestore}
              disabled={pending}
            >
              {pending ? "Restoring…" : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
