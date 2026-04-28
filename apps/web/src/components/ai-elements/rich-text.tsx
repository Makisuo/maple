import { memo } from "react"
import { MessageResponse } from "./message"
import { parseAnnotations, InlineTrace, InlineService, InlineError, InlineLog } from "./inline"

interface RichTextProps {
	children: string
	className?: string
}

export const RichText = memo(
	({ children, className }: RichTextProps) => {
		const segments = parseAnnotations(children)

		// Fast path: no annotations, render as normal MessageResponse
		if (segments.length === 1 && segments[0].type === "text") {
			return <MessageResponse className={className}>{children}</MessageResponse>
		}

		return (
			<div className={className}>
				{segments.map((segment, i) => {
					switch (segment.type) {
						case "text": {
							if (!segment.content.trim()) return null
							return <MessageResponse key={i}>{segment.content}</MessageResponse>
						}
						case "trace":
							return <InlineTrace key={i} data={segment.data} />
						case "service":
							return <InlineService key={i} data={segment.data} />
						case "error":
							return <InlineError key={i} data={segment.data} />
						case "log":
							return <InlineLog key={i} data={segment.data} />
					}
				})}
			</div>
		)
	},
	(prevProps, nextProps) => prevProps.children === nextProps.children,
)

RichText.displayName = "RichText"
