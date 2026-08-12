import { Img } from "@react-email/components"

/**
 * The Maple tree mark, for email headers.
 *
 * A hosted PNG rather than the inline SVG the app uses: Gmail and Outlook strip
 * `<svg>`, so a mail client would render nothing at all. The amber colorway is
 * transparent-backed, so it sits bare on the surface — no tile — matching how the
 * mark renders in-app.
 *
 * Served by the landing site (`apps/landing/public/brand/logo/`, published at
 * `site: "https://maple.dev"`), so the URL is absolute and stage-independent: a
 * mail client has no origin to resolve a relative path against.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
	return (
		<Img
			src="https://maple.dev/brand/logo/maple-mark-amber-256.png"
			alt="Maple"
			width={size}
			height={size}
			style={{ display: "block" }}
		/>
	)
}
