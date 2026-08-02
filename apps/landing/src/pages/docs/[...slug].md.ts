/**
 * `/docs/<slug>.md` — the raw source behind every docs page.
 *
 * `doc.body` is emitted verbatim under a title/description header, so this can
 * never drift from what `[...slug].astro` renders. MDX bodies (`local-mode.mdx`)
 * ship with their JSX intact; a component tag is still readable prose to a
 * model, and stripping it would lose content.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { getCollection, type CollectionEntry } from "astro:content"
import { blocks, docHeader, markdown } from "../../lib/page-markdown"

export const getStaticPaths: GetStaticPaths = async () => {
	const docs = await getCollection("docs", ({ data }) => !data.draft)
	return docs.map((doc) => ({ params: { slug: doc.id }, props: { doc } }))
}

export const GET: APIRoute = ({ props }) => {
	const { doc } = props as { doc: CollectionEntry<"docs"> }
	return markdown(blocks(docHeader(doc.data.title, doc.data.description), doc.body ?? ""))
}
