"use client"

import type { ComponentProps } from "react"

import { cn } from "@maple/ui/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { memo } from "react"
import { Streamdown, type PluginConfig } from "streamdown"

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
	/**
	 * Markdown layout only — no Shiki, KaTeX or Mermaid. For a body that is
	 * mounted over and over rather than once: a virtualized transcript mounts a
	 * reply again every time it scrolls back into view, and tokenizing its code
	 * fences each time was most of the work in a scroll frame. Code still
	 * renders, as a plain block.
	 */
	lightweight?: boolean
}

const streamdownPlugins = { cjk, code, math, mermaid } as PluginConfig
const lightweightPlugins = { cjk } as PluginConfig

/**
 * Markdown renderer for assistant text. Memoized on `children` identity so a
 * streaming token only re-renders the message it lands in — the Shiki, KaTeX,
 * and Mermaid plugins are expensive enough that re-parsing the whole transcript
 * per token is visible as jank.
 */
export const MessageResponse = memo(
	({ className, lightweight = false, ...props }: MessageResponseProps) => (
		<Streamdown
			className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
			plugins={lightweight ? lightweightPlugins : streamdownPlugins}
			{...props}
		/>
	),
	(prevProps, nextProps) => prevProps.children === nextProps.children,
)

MessageResponse.displayName = "MessageResponse"
