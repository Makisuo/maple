import { useRouter } from "@tanstack/react-router"
import { setGlobalNamespace } from "@/lib/services/common/global-namespace"

/**
 * Replaces a sidebar's Namespace filter section while the org-global namespace
 * pin is active — the page-level filter is ignored (not rewritten) until the
 * pin is cleared here or in the org menu.
 */
export function PinnedNamespaceNotice({ namespace }: { namespace: string }) {
	const router = useRouter()

	return (
		<div className="rounded-md border bg-muted/40 px-3 py-2">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium text-muted-foreground">Namespace</span>
				<button
					type="button"
					className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					onClick={() => {
						setGlobalNamespace(null)
						void router.invalidate()
					}}
				>
					Clear
				</button>
			</div>
			<div className="mt-0.5 truncate text-sm font-medium">{namespace}</div>
			<p className="mt-1 text-xs text-muted-foreground">Pinned for the whole app in the org menu.</p>
		</div>
	)
}
