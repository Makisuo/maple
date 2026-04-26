import { useMemo } from "react"
import { Result } from "@/lib/effect-atom"
import { HistoryIcon, XmarkIcon } from "@/components/icons"
import { useDashboardVersions } from "./use-dashboard-history"
import { VersionListItem } from "./version-list-item"
import type { PreviewedVersion } from "@/atoms/dashboard-history-atoms"

interface DashboardHistoryPanelProps {
  dashboardId: string
  previewed: PreviewedVersion | null
  onPreview: (versionId: string) => void
  onClose: () => void
}

export function DashboardHistoryPanel({
  dashboardId,
  previewed,
  onPreview,
  onClose,
}: DashboardHistoryPanelProps) {
  const result = useDashboardVersions(dashboardId)

  const versions = useMemo(
    () => (Result.isSuccess(result) ? [...result.value.versions] : []),
    [result],
  )

  const isLoading = !Result.isSuccess(result) && !Result.isFailure(result)
  const isError = Result.isFailure(result)
  const latestVersionId = versions[0]?.id ?? null

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <HistoryIcon className="size-4" />
        <h2 className="text-sm font-medium tracking-tight">History</h2>
        <span className="ml-1 font-mono text-[10px] text-muted-foreground">
          {versions.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Close history panel"
        >
          <XmarkIcon className="size-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading && (
          <div className="px-4 py-6 text-xs text-muted-foreground">
            Loading history…
          </div>
        )}

        {isError && (
          <div className="px-4 py-6 text-xs text-destructive">
            Couldn't load history. Try reopening the panel.
          </div>
        )}

        {!isLoading && !isError && versions.length === 0 && (
          <div className="px-4 py-12 text-center">
            <div className="mx-auto mb-3 grid size-9 place-items-center rounded-full bg-muted">
              <HistoryIcon className="size-4 text-muted-foreground" />
            </div>
            <p className="text-xs font-medium text-foreground">
              No history yet
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Each save is captured here so you can revisit or restore.
            </p>
          </div>
        )}

        {!isLoading && !isError && versions.length > 0 && (
          <ol className="relative">
            {/* Continuous timeline rail. Sits behind the markers — uses the
                same color as the panel border for a quiet ledger feel. */}
            <span
              aria-hidden
              className="absolute left-4 top-3 bottom-3 w-px bg-border"
            />
            {versions.map((version) => (
              <VersionListItem
                key={version.id}
                version={version}
                isPreviewing={previewed?.versionId === version.id}
                isCurrent={
                  previewed === null && version.id === latestVersionId
                }
                onPreview={() => onPreview(version.id)}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}
