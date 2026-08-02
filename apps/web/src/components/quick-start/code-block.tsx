import { cn } from "@maple/ui/utils"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { highlightCode } from "@/lib/sugar-high"

interface CodeBlockProps {
	code: string
	language?: string
	className?: string
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
	const highlighted = highlightCode(code)

	return (
		<div className={cn("relative overflow-clip rounded-md border border-border bg-muted", className)}>
			<div className="flex items-center justify-between px-3 py-1.5 text-muted-foreground">
				{language && (
					<span className="text-[10px] font-medium uppercase tracking-wider">{language}</span>
				)}
				<CopyButton value={code} label="Code" className="ml-auto" />
			</div>
			<div className="overflow-x-auto bg-background/50 p-3">
				<pre className="text-xs leading-relaxed">
					<code dangerouslySetInnerHTML={{ __html: highlighted }} />
				</pre>
			</div>
		</div>
	)
}
