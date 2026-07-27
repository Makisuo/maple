/**
 * Slug → component maps.
 *
 * These live outside `lib/features.ts` on purpose: `NavBar.tsx` is a
 * `client:load` island that reads the registry, so anything the registry
 * imports ships to the browser. The registry stores string ids; this module —
 * imported only by the two Astro templates — resolves them to components.
 *
 * Astro renders a capitalised local as a component, so the templates do
 * `const Artifact = ARTIFACTS[id]` then `<Artifact />`.
 *
 * Every entry is an Astro component. The two React artifacts are wrapped in
 * thin `.astro` files under `artifacts/`, because Astro builds a hydration
 * script from the static import at the call site — a component resolved out of
 * this map has no import path and cannot take a `client:*` directive.
 */
import type { ArtifactId, SectionId } from "../../lib/page-registry"
import LiveBrowserSessions from "../live/LiveBrowserSessions.astro"
import LiveK8sHeatmap from "../live/LiveK8sHeatmap.astro"
import LiveLogStream from "../live/LiveLogStream.astro"
import LiveMcpTranscript from "../live/LiveMcpTranscript.astro"
import LiveServiceMap from "../live/LiveServiceMap.astro"
import LogsVolume from "./artifacts/LogsVolume.astro"
import TraceExplorer from "./artifacts/TraceExplorer.astro"
import K8sConsole from "./sections/K8sConsole.astro"
import K8sCorrelation from "./sections/K8sCorrelation.astro"
import K8sInstall from "./sections/K8sInstall.astro"
import K8sViews from "./sections/K8sViews.astro"

/**
 * `satisfies`, not an annotation: it checks that every id has an entry while
 * keeping the inferred component types, so indexing these yields a renderable
 * component union rather than `unknown` — which Astro rejects as "not a valid
 * component".
 */
export const ARTIFACTS = {
	"trace-visualization": TraceExplorer,
	"browser-sessions": LiveBrowserSessions,
	"log-stream": LiveLogStream,
	"logs-volume": LogsVolume,
	"service-map": LiveServiceMap,
	"mcp-transcript": LiveMcpTranscript,
	"k8s-heatmap": LiveK8sHeatmap,
} satisfies Record<ArtifactId, unknown>

export const EXTRA_SECTIONS = {
	"k8s-console": K8sConsole,
	"k8s-views": K8sViews,
	"k8s-correlation": K8sCorrelation,
	"k8s-install": K8sInstall,
} satisfies Record<SectionId, unknown>
