/**
 * `/features/<slug>.md` — the feature registry, serialized.
 *
 * English-only and un-prefixed, unlike the `ja/` and `ko/` HTML twins. The
 * registry stores copy as uncalled `Msg` thunks; an endpoint runs outside the
 * per-render AsyncLocalStorage Paraglide resolves against, so calling one here
 * yields the source locale. That is what we want — `page-registry.ts` documents
 * the same behaviour as a hazard for `getStaticPaths`, so don't "fix" it.
 *
 * Screenshots are dropped: their `alt` text describes a capture rather than
 * making the argument, which is noise in a text-only representation.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { featureBySlug, features } from "../../lib/features"
import type { Feature } from "../../lib/page-registry"
import { useCaseBySlug } from "../../lib/use-cases"
import { absolute, blocks, docHeader, markdown } from "../../lib/page-markdown"

export const getStaticPaths: GetStaticPaths = () =>
	features.map((feature) => ({ params: { slug: feature.slug }, props: { feature } }))

export const GET: APIRoute = ({ props, site }) => {
	const { feature } = props as { feature: Feature }

	const facts = feature.panel
		? blocks(
				`## ${feature.panel.title()}`,
				feature.panel.lede(),
				feature.panel.facts.map(({ key, value }) => `- **${key}**: ${value}`).join("\n"),
			)
		: undefined

	const related = blocks(
		"## Related",
		[
			...feature.related.map(
				(slug) =>
					`- [${featureBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/features/${slug}.md`)})`,
			),
			...feature.relatedUseCases.map(
				(slug) =>
					`- [${useCaseBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/use-cases/${slug}.md`)})`,
			),
		].join("\n"),
	)

	return markdown(
		blocks(
			docHeader(feature.heroTitle(), feature.heroLede()),
			facts,
			`## ${feature.capTitle()}`,
			...feature.capabilities.map((cap) => `### ${cap.op} — ${cap.title()}\n\n${cap.body()}`),
			related,
		),
	)
}
