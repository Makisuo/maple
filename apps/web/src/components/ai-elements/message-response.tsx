"use client"

import type { ComponentProps } from "react"

import { cn } from "@maple/ui/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { memo } from "react"
import { Streamdown, type PluginConfig } from "streamdown"

export type MessageResponseProps = ComponentProps<typeof Streamdown>

const streamdownPlugins = { cjk, code, math, mermaid } as PluginConfig

/**
 * Markdown renderer for assistant text. Memoized on `children` identity so a
 * streaming token only re-renders the message it lands in — the shiki/katex/mermaid
 * plugins are expensive enough that re-parsing the whole transcript per token is
 * visible as jank.
 */
export const MessageResponse = memo(
	({ className, ...props }: MessageResponseProps) => (
		<Streamdown
			className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
			plugins={streamdownPlugins}
			{...props}
		/>
	),
	(prevProps, nextProps) => prevProps.children === nextProps.children,
)

MessageResponse.displayName = "MessageResponse"
