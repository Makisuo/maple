import { Atom } from "@/lib/effect-atom"

export interface PreviewedVersion {
  readonly versionId: string
  readonly versionNumber: number
  readonly createdAt: string
  readonly createdBy: string
}

/**
 * Whether the right-side history panel is open. Module-level singleton —
 * only one dashboard page is mounted at a time.
 */
export const historyPanelOpenAtom = Atom.make(false)

/**
 * The version currently being previewed. When non-null the dashboard renders
 * the snapshot read-only and shows the preview banner. The snapshot itself
 * is fetched on demand by the preview component (keyed off versionId).
 */
export const previewedVersionAtom = Atom.make<PreviewedVersion | null>(null)
