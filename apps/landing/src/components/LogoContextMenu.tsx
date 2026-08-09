import type { ReactNode } from "react"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@maple/ui/components/ui/context-menu"
import { writeClipboardText } from "@maple/ui/lib/clipboard"
import { trackLanding } from "../lib/telemetry"

const MARK_SVG = "/brand/logo/maple-mark-amber.svg"
const KIT = "/brand/maple-brand-kit.zip"

/**
 * Right-click on the header logo.
 *
 * Someone who wants our logo right-clicks it — that is the first thing they try,
 * and until now it produced the browser's own menu offering to save a React
 * component's DOM. This replaces it on the logo only; the rest of the page keeps
 * the native menu.
 *
 * "Copy as SVG" fetches the published file rather than serialising the rendered
 * `MapleMark` node. Serialising would hand over whatever the page happened to
 * compute — `currentColor` resolved to the nav's amber, React's own attribute
 * casing, no XML declaration — which is close to the real asset but not equal to
 * it. Fetching means the clipboard and the download are the same bytes.
 */
export function LogoContextMenu({ children }: { children: ReactNode }) {
	const copyMark = async () => {
		let ok = false
		try {
			const response = await fetch(MARK_SVG)
			ok = response.ok && (await writeClipboardText(await response.text()))
		} catch {
			ok = false
		}
		trackLanding("brand_asset_copied", { asset: MARK_SVG, copied: ok })
	}

	const download = (href: string) => () => {
		trackLanding("brand_asset_downloaded", { asset: href })
		// `download` on an anchor we synthesise, rather than a real link in the
		// menu: the menu item is a button for keyboard and screen-reader purposes,
		// and wrapping an anchor in it would nest two interactive roles.
		const a = document.createElement("a")
		a.href = href
		a.download = ""
		a.click()
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger render={<div className="flex items-center">{children}</div>} />
			<ContextMenuContent className="w-56 p-1">
				<ContextMenuItem onClick={() => void copyMark()}>Copy logo as SVG</ContextMenuItem>
				<ContextMenuItem onClick={download(MARK_SVG)}>Download logo (SVG)</ContextMenuItem>
				<ContextMenuItem onClick={download(KIT)}>Download brand kit (.zip)</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() => {
						window.location.href = "/brand"
					}}
				>
					Brand guidelines
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	)
}
