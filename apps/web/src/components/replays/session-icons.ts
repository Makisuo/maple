import {
	ChromeIcon,
	ComputerIcon,
	EdgeIcon,
	FirefoxIcon,
	GlobeIcon,
	MobileIcon,
	OperaIcon,
	SafariIcon,
	TabletIcon,
	type IconComponent,
} from "@/components/icons"

// parseUserAgent (packages/browser-session) emits exactly Edge/Opera/Chrome/
// Firefox/Safari/Unknown, but match by substring so decorated values like
// "Mobile Safari" or "Chrome 138" still resolve. Order mirrors the parser's:
// Edge/Opera UAs also contain "Chrome", and Chrome UAs contain "Safari".
export function browserIconFor(name: string): IconComponent {
	const n = name.toLowerCase()
	if (n.includes("edg")) return EdgeIcon
	if (n.includes("opera") || n.includes("opr")) return OperaIcon
	if (n.includes("chrome")) return ChromeIcon
	if (n.includes("firefox")) return FirefoxIcon
	if (n.includes("safari")) return SafariIcon
	return GlobeIcon
}

export function deviceIconFor(type: string): IconComponent {
	const t = type.toLowerCase()
	if (t === "mobile" || t === "phone") return MobileIcon
	if (t === "tablet") return TabletIcon
	return ComputerIcon
}
