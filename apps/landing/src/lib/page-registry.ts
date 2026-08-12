/**
 * Shared types and helpers for the feature and use-case registries.
 *
 * Two rules govern everything in this file and its two consumers:
 *
 * 1. **Messages are stored as thunks, never as called values.** Paraglide
 *    resolves the active locale per call, through an AsyncLocalStorage the
 *    astro integration sets up around each page render. A module-scope
 *    `title: m.x()` would evaluate once at module-eval time and freeze
 *    whichever locale happened to render first — so every page in the build
 *    would inherit it. Store the function reference and let the template call
 *    it. `NavBar.tsx` already uses this exact `() => string` shape.
 *
 *    The same rule is why `getStaticPaths()` must never call a message either:
 *    it runs outside that storage and always resolves to the source locale.
 *
 * 2. **No `.astro` and no `astro:i18n` imports here.** `NavBar.tsx` is a
 *    `client:load` island that reads these registries, so anything imported
 *    here ships to the browser. Component references live in
 *    `components/page/slots.ts`, which only the templates import; paths are
 *    built by the pure helpers below rather than by `getRelativeLocaleUrl`.
 */

type Locale = "en" | "ja" | "ko"

/** A Paraglide message, uncalled. See rule 1 above. */
type Msg = () => string

/**
 * Ids resolved to components in `components/page/slots.ts`. Strings rather
 * than imports so this module stays free of `.astro`.
 */
export type ArtifactId =
	| "trace-visualization"
	| "browser-sessions"
	| "log-stream"
	| "logs-volume"
	| "service-map"
	| "mcp-transcript"
	| "k8s-heatmap"
	| "alert-firing"

export type SectionId = "k8s-console" | "k8s-views" | "k8s-correlation" | "k8s-install"

/**
 * A plate. `src` unset renders MediaFrame's placeholder, which prints the
 * capture spec and swaps to the real asset later with no layout shift.
 *
 * `alt`/`caption` are literal English, matching the homepage's own plates.
 * They describe what a capture shows rather than making an argument, and the
 * screenshots themselves are English-only.
 */
interface Plate {
	src?: string
	/** The capture's intrinsic size — MediaFrame never crops, so this is the aspect. */
	width: number
	height: number
	alt: string
	/** Placeholder-only: what to capture. */
	caption?: string
}

/** One row of the operator gutter. `op` is a literal product string. */
interface Capability {
	op: string
	title: Msg
	body: Msg
}

interface SurfacePanelSpec {
	/** Frame head, left: the route. Literal. */
	route: string
	/** Frame head, right: one real constant from the shot. Literal. */
	constant: string
	plate: Plate
	/** Key/value facts. Both sides literal — product vocabulary, not prose. */
	facts: { key: string; value: string }[]
	title: Msg
	lede: Msg
}

interface ArtifactSpec {
	id: ArtifactId
	title: Msg
	lede: Msg
	wide?: boolean
}

export interface Feature {
	slug: string
	navLabel: Msg
	navDesc: Msg
	seoTitle: Msg
	seoDescription: Msg
	heroTitle: Msg
	heroLede: Msg
	/** Null on pages whose surface is carried by a bespoke section instead. */
	panel: SurfacePanelSpec | null
	/** One per page. Two live artifacts plus the amber CTA reads speckled. */
	artifact: ArtifactSpec | null
	extraSections: SectionId[]
	capTitle: Msg
	capabilities: Capability[]
	/** Hand-picked, so no slug ends up with zero inbound links. */
	related: string[]
	relatedUseCases: string[]
	/** Drives hreflang. Every page ships in all three today. */
	locales: readonly Locale[]
}

export interface StoryStepSpec {
	surface: string
	route: string
	elapsed: string
	title: Msg
	body: Msg
	plate: Plate
}

export interface UseCase {
	slug: string
	navLabel: Msg
	navDesc: Msg
	seoTitle: Msg
	seoDescription: Msg
	heroTitle: Msg
	heroLede: Msg
	/** The literal signal that opens the story, shown in the hero. */
	signal: string
	/** The one thing that holds across every step. Literal. */
	constant: string
	constantLabel: string
	storyTitle: Msg
	storyLede: Msg
	/** Capture aspect shared by this story's plates, e.g. "1280 / 660". */
	storyAspect: string
	steps: StoryStepSpec[]
	outcomeLine: Msg
	/** Values are literal; only the labels are translated. */
	outcomeMetrics: { value: string; label: Msg }[]
	capTitle: Msg
	capabilities: Capability[]
	related: string[]
	relatedFeatures: string[]
	locales: readonly Locale[]
}

/**
 * Path helpers. Pure, so both the Astro templates and the React nav island can
 * use them and agree — NavBar builds hrefs with the same `/${locale}${path}`
 * shape, and `getRelativeLocaleUrl` produces the same strings for these routes.
 */
const localePath = (locale: string, path: string) => (locale === "en" ? path : `/${locale}${path}`)

export const featurePath = (locale: string, slug: string) => localePath(locale, `/features/${slug}`)

export const useCasePath = (locale: string, slug: string) => localePath(locale, `/use-cases/${slug}`)

/**
 * A story is only allowed to pin its pane when at least two plates are real.
 * A pinned frame crossfading between identical placeholder dot-grids reads as
 * broken rather than as pending, so those instances fall back to the same
 * inline layout `<lg` and `prefers-reduced-motion` already produce.
 */
export const storyIsPinnable = (steps: StoryStepSpec[]) => steps.filter((step) => step.plate.src).length >= 2
