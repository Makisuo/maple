import { useRouter } from "@tanstack/react-router"
import { LayersIcon } from "@/components/icons"
import { FILTER_SECTION_LABEL } from "@maple/ui/components/filters/filter-styles"
import { cn } from "@maple/ui/lib/utils"
import { setGlobalNamespace } from "@/lib/services/common/global-namespace"

/**
 * Replaces a sidebar's Namespace filter section while the org-global namespace
 * pin is active — the page-level filter is ignored (not rewritten) until the
 * pin is cleared here or in the org menu. Styled as a regular section so it
 * reads as part of the sidebar, not a callout.
 */
export function PinnedNamespaceNotice({ namespace }: { namespace: string }) {
	const router = useRouter()

	return (
		<div>
			<div
				className={cn(
					"flex w-full items-center justify-between gap-2 py-2 text-muted-foreground",
					FILTER_SECTION_LABEL,
				)}
			>
				<span className="truncate">Namespace</span>
				<button
					type="button"
					className="font-medium normal-case tracking-normal text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => {
						setGlobalNamespace(null)
						void router.invalidate()
					}}
				>
					Clear
				</button>
			</div>
			<div className="flex items-center gap-2 py-1 text-sm">
				<LayersIcon size={14} className="shrink-0 text-muted-foreground" />
				<span className="truncate">{namespace}</span>
				<span
					title="Pinned for the whole app in the org menu"
					className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
				>
					Pinned
				</span>
			</div>
		</div>
	)
}
