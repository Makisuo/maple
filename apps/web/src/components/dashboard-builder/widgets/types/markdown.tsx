import { WIDGET_TYPES } from "@maple/domain/http"

import { FileIcon } from "@/components/icons"
import { MarkdownWidget } from "@/components/dashboard-builder/widgets/markdown-widget"
import { markdownPresets } from "@/components/dashboard-builder/widgets/widget-definitions"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { PreviewFrame } from "@/components/dashboard-builder/widgets/types/preset-preview"
import type { WidgetPresetDefinition } from "@/components/dashboard-builder/widgets/widget-definitions"
import { makeRouteDataSource } from "@maple/widgets/dashboard"

/** The note's first few lines, with markdown syntax stripped. */
function MarkdownPresetPreview({ preset }: { preset: WidgetPresetDefinition }) {
	const lines = (preset.display.markdown?.content ?? "")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(0, 4)

	return (
		<PreviewFrame title={preset.display.title} className="flex flex-col gap-1 overflow-hidden p-1">
			{lines.map((line, index) => (
				// eslint-disable-next-line react/no-array-index-key -- fixed sample content
				<div
					key={index}
					className={`truncate text-[9px] ${line.startsWith("#") ? "font-semibold" : "text-muted-foreground"}`}
				>
					{line.replace(/^#+\s*/, "").replace(/[*`]/g, "")}
				</div>
			))}
		</PreviewFrame>
	)
}

/** A static note. The only widget with no warehouse round-trip at all. */
export const markdownWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.markdown,
	icon: FileIcon,
	Renderer: MarkdownWidget,
	queryEditor: "markdown",
	// A note's only setting is its body, which is the editor itself.
	ConfigPanel: () => null,
	presets: markdownPresets,
	PresetPreview: MarkdownPresetPreview,

	initialState: (widget) => ({ markdownContent: widget.display.markdown?.content ?? "" }),

	buildDataSource: () => makeRouteDataSource("markdown_static"),

	buildDisplay: ({ base, state }) => extendDisplay(base, { markdown: { content: state.markdownContent } }),
}
