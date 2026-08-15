/**
 * Social previews for share links, served by the SPA's own Worker.
 *
 * Two halves of one feature:
 *
 *   - `shareOgMetaRewriter` inlines a link's real `og:*` tags into the shell.
 *     Crawlers do not run JavaScript, so a client-rendered head is invisible to
 *     every chat client that unfurls a link — the tags have to be in the HTML
 *     the Worker returns, and this is the only server in that path.
 *   - `renderShareOgImage` answers the image those tags point at.
 *
 * Neither half decides anything. The API owns every judgement — whether a link
 * is public, whether it is still live, what its board is called — and this
 * module renders what it is handed. That is also why the token never reaches
 * the image URL: the meta response carries a signed, opaque image id instead,
 * and the image endpoint hands that back to the API to resolve.
 *
 * Failure is always "leave the page alone". An unfurl that falls back to the
 * generic Maple card is a worse preview; a rewrite that throws is a broken
 * dashboard, and the page is what people actually came for.
 */
import { ogCardNode } from "./card"
import { renderOgCard, type AssetFetcher, type EmbeddedImage } from "./render"
import { ogMetaAdditions, ogMetaReplacements, type ShareOgMeta } from "./share-links"

/**
 * The slice of Cloudflare's `HTMLRewriter` this module uses.
 *
 * Declared rather than pulled from `@cloudflare/workers-types`: this app's
 * tsconfig is a browser one (`lib: DOM`), and the Workers global types
 * redeclare `Request`/`Response` incompatibly, so importing them to describe
 * one class would retype the entire SPA around it.
 */
interface RewriterElement {
	getAttribute(name: string): string | null
	setAttribute(name: string, value: string): void
	setInnerContent(content: string): void
	append(content: string, options?: { html?: boolean }): void
}
interface Rewriter {
	on(selector: string, handlers: { element(element: RewriterElement): void }): Rewriter
	transform(response: Response): Response
}
declare const HTMLRewriter: new () => Rewriter

/** Long enough that a page load rarely pays for the round trip, short enough that a rename lands. */
const META_CACHE_SECONDS = 300

/**
 * How long the API has to answer before the document goes out with generic
 * tags. The page must not wait on a preview: nobody opening a dashboard cares
 * what its link unfurls as.
 */
const API_TIMEOUT_MS = 1500

const postJson = (apiBaseUrl: string, path: string, body: unknown): Promise<Response> =>
	fetch(new URL(path, apiBaseUrl), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(API_TIMEOUT_MS),
	})

const digest = async (value: string): Promise<string> => {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Cache entry shape. `meta` absent is the cached "this link has no preview". */
interface CachedMeta {
	readonly meta?: ShareOgMeta
}

/**
 * A link's preview tags, or `undefined` for every link that has none — an
 * org-only link, a revoked one, an unknown one, or an API that did not answer.
 *
 * Cached in the Worker's own cache rather than through `fetch` semantics,
 * because this is a POST and POSTs are not cacheable. The key is a GET against
 * a synthetic host built from a digest of the token, so the token is never a
 * cache key and cannot be read back out of one.
 */
export const fetchShareOgMeta = async (
	apiBaseUrl: string,
	token: string,
): Promise<ShareOgMeta | undefined> => {
	const cache = await caches.open("share-og-meta")
	const key = new Request(`https://share-og-meta.invalid/${await digest(token)}`)

	const cached = await cache.match(key)
	if (cached !== undefined) return ((await cached.json()) as CachedMeta).meta

	let meta: ShareOgMeta | undefined
	try {
		const response = await postJson(apiBaseUrl, "/v2/share/og-meta", { token })
		meta = response.ok ? ((await response.json()) as ShareOgMeta) : undefined
	} catch {
		// A timeout or a network failure is not cached: the next request should
		// try again rather than serve the generic card for the next five minutes.
		return undefined
	}

	// The negative answer is cached too, and for the same reason as the positive
	// one — an org-only board is the case a crawler retries hardest. It is stored
	// as a body rather than as a 204, because the Cache API refuses to store a
	// null-body status and the `put` rejects.
	try {
		await cache.put(
			key,
			new Response(JSON.stringify({ meta } satisfies CachedMeta), {
				headers: {
					"content-type": "application/json",
					"cache-control": `max-age=${META_CACHE_SECONDS}`,
				},
			}),
		)
	} catch {
		// Caching is an optimisation. Failing to store the answer must not fail
		// the document the answer was for.
	}

	return meta
}

/** Rewrites the shell's placeholder tags in place. */
export const shareOgMetaRewriter = (meta: ShareOgMeta, origin: string): Rewriter => {
	const replacements = ogMetaReplacements(meta, origin)

	return new HTMLRewriter()
		.on("title", {
			element(element) {
				element.setInnerContent(meta.title)
			},
		})
		.on("meta", {
			element(element) {
				const key = element.getAttribute("property") ?? element.getAttribute("name")
				const replacement = key === null ? undefined : replacements.get(key)
				if (replacement !== undefined) element.setAttribute("content", replacement)
			},
		})
		.on("head", {
			element(element) {
				element.append(ogMetaAdditions(meta), { html: true })
			},
		})
}

/** Big enough for a 30px avatar at 2×; anything larger is not a logo. */
const MAX_LOGO_BYTES = 512 * 1024

/**
 * The org's logo, fetched so the renderer never has to.
 *
 * The URL comes from the org directory by way of our own API, but it is still
 * an outbound fetch driven by stored data, so it is bounded on every axis that
 * matters: https only, one timeout, one size cap, and a failure that costs the
 * card its avatar rather than its render.
 */
const fetchOrgLogo = async (url: string): Promise<EmbeddedImage | undefined> => {
	try {
		if (new URL(url).protocol !== "https:") return undefined
		const response = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
		if (!response.ok) return undefined

		const data = new Uint8Array(await response.arrayBuffer())
		return data.byteLength > MAX_LOGO_BYTES ? undefined : { src: url, data }
	} catch {
		return undefined
	}
}

/**
 * The preview image itself.
 *
 * 404 with no body for everything that is not a live public link — the same
 * uniformity the share API keeps, for the same reason: an image URL must not
 * answer "did this link exist" for someone who kept a copy after it was
 * revoked.
 */
export const renderShareOgImage = async (
	apiBaseUrl: string,
	ogId: string,
	assets: AssetFetcher,
): Promise<Response> => {
	const notFound = new Response(null, { status: 404 })

	let card: Parameters<typeof ogCardNode>[0]
	try {
		const response = await postJson(apiBaseUrl, "/v2/share/og-card", { ogId })
		if (!response.ok) return notFound
		card = (await response.json()) as typeof card
	} catch {
		return notFound
	}

	const logoUrl = card.org?.imageUrl
	const logo = logoUrl === undefined ? undefined : await fetchOrgLogo(logoUrl)
	// A logo that would not load is dropped rather than left as a reference the
	// renderer cannot resolve: the org then draws as its lettered tile.
	const org = card.org === undefined ? undefined : logo === undefined ? { name: card.org.name } : card.org

	const png = await renderOgCard(ogCardNode({ ...card, org }), assets, logo === undefined ? [] : [logo])

	return new Response(png as BodyInit, {
		headers: {
			"content-type": "image/png",
			// Long enough at the edge that a link doing the rounds costs one render,
			// short enough that a renamed board catches up within the day.
			"cache-control": "public, max-age=300, s-maxage=86400",
		},
	})
}
