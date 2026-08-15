/**
 * The pure half of share social previews: which URLs are involved, and what
 * tags a link's metadata turns into.
 *
 * Split from `share-preview.ts` so the parsing and the tag mapping are testable
 * without `HTMLRewriter`, `caches` or a wasm renderer — none of which exist
 * outside a Worker isolate.
 */

const SHARE_PATH_PREFIX = "/share/"
const OG_IMAGE_PREFIX = "/share/og/"
const OG_IMAGE_SUFFIX = ".png"

export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

export interface ShareOgMeta {
	readonly title: string
	readonly description: string
	readonly imagePath: string
}

/**
 * The share token in a `/share/<token>` path, or `undefined` for anything else.
 *
 * `/share/og/…` is excluded explicitly: it lives under the same prefix but is
 * the *image* for a link, and treating its id as a token would send a value
 * that is deliberately not a credential to an endpoint that expects one.
 */
export const shareTokenFromPath = (pathname: string): string | undefined => {
	if (!pathname.startsWith(SHARE_PATH_PREFIX) || pathname.startsWith(OG_IMAGE_PREFIX)) return undefined
	const token = decodeURIComponent(pathname.slice(SHARE_PATH_PREFIX.length)).split("/")[0]
	return token === undefined || token.length === 0 ? undefined : token
}

/** The image id in a `/share/og/<ogId>.png` path, or `undefined`. */
export const ogIdFromPath = (pathname: string): string | undefined => {
	if (!pathname.startsWith(OG_IMAGE_PREFIX) || !pathname.endsWith(OG_IMAGE_SUFFIX)) return undefined
	const ogId = decodeURIComponent(
		pathname.slice(OG_IMAGE_PREFIX.length, pathname.length - OG_IMAGE_SUFFIX.length),
	)
	return ogId.length === 0 || ogId.includes("/") ? undefined : ogId
}

export const escapeAttribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/**
 * New `content` values, keyed by the `property`/`name` of the tag they replace.
 *
 * Replacing rather than appending: `index.html` already carries a full set for
 * the generic card, and a document with two `og:title` tags leaves the winner
 * up to whichever crawler is reading it.
 */
export const ogMetaReplacements = (meta: ShareOgMeta, origin: string): ReadonlyMap<string, string> => {
	const imageUrl = new URL(meta.imagePath, origin).toString()
	return new Map([
		["og:title", meta.title],
		["twitter:title", meta.title],
		["og:description", meta.description],
		["twitter:description", meta.description],
		["og:image", imageUrl],
		["twitter:image", imageUrl],
	])
}

/**
 * Tags the shell has no placeholder for.
 *
 * The image dimensions are not in `index.html` because the generic card's are
 * not this image's, and a crawler that reserves space before fetching needs the
 * right ones.
 */
export const ogMetaAdditions = (meta: ShareOgMeta): string =>
	`<meta property="og:image:width" content="${OG_IMAGE_WIDTH}" />` +
	`<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}" />` +
	`<meta property="og:image:alt" content="${escapeAttribute(meta.title)}" />`
