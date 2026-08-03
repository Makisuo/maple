/**
 * `/use-cases/<slug>.md` — the use-case registry, serialized.
 *
 * English-only for the same reason as `features/[slug].md.ts` — see the note
 * there before changing how messages are resolved.
 *
 * The story is the argument on these pages, so each step keeps its surface,
 * route and elapsed clock: "T+0:40 · /traces" is the claim about how little
 * time it took, and it survives the loss of the screenshots.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import type { UseCase } from "../../lib/page-registry"
import { featureBySlug } from "../../lib/features"
import { useCaseBySlug, useCases } from "../../lib/use-cases"
import { absolute, blocks, docHeader, markdown } from "../../lib/page-markdown"

export const getStaticPaths: GetStaticPaths = () =>
	useCases.map((useCase) => ({ params: { slug: useCase.slug }, props: { useCase } }))

export const GET: APIRoute = ({ props, site }) => {
	const { useCase } = props as { useCase: UseCase }

	const story = blocks(
		`## ${useCase.storyTitle()}`,
		useCase.storyLede(),
		`Signal: ${useCase.signal}. ${useCase.constantLabel}: ${useCase.constant}.`,
		...useCase.steps.map(
			(step) =>
				`### ${step.elapsed} · ${step.surface} (${step.route}) — ${step.title()}\n\n${step.body()}`,
		),
		useCase.outcomeLine(),
		useCase.outcomeMetrics.map((metric) => `- **${metric.value}** ${metric.label()}`).join("\n"),
	)

	const related = blocks(
		"## Related",
		[
			...useCase.related.map(
				(slug) =>
					`- [${useCaseBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/use-cases/${slug}.md`)})`,
			),
			...useCase.relatedFeatures.map(
				(slug) =>
					`- [${featureBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/features/${slug}.md`)})`,
			),
		].join("\n"),
	)

	return markdown(
		blocks(
			docHeader(useCase.heroTitle(), useCase.heroLede()),
			story,
			`## ${useCase.capTitle()}`,
			...useCase.capabilities.map((cap) => `### ${cap.op} — ${cap.title()}\n\n${cap.body()}`),
			related,
		),
	)
}
