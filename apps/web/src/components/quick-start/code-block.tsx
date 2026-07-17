import { CopyIcon, CheckIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { highlightCode } from "@/lib/sugar-high"

interface CodeBlockProps {
	code: string
	language?: string
	className?: string
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
	const { copied, copy } = useCopyToClipboard("Code")
	const highlighted = highlightCode(code)

	return (
		<div className={cn("relative overflow-clip rounded-md border border-border bg-muted", className)}>
			<div className="flex items-center justify-between px-3 py-1.5 text-muted-foreground">
				{language && (
					<span className="text-[10px] font-medium uppercase tracking-wider">{language}</span>
				)}
				<button
					type="button"
					onClick={() => copy(code)}
					className="ml-auto flex items-center gap-1 text-xs hover:text-foreground transition-colors"
				>
					{copied ? (
						<CheckIcon
							size={14}
							className="text-severity-info animate-in zoom-in-50 duration-200"
						/>
					) : (
						<CopyIcon size={14} />
					)}
				</button>
			</div>
			<div className="overflow-x-auto bg-background/50 p-3">
				<pre className="text-xs leading-relaxed">
					<code dangerouslySetInnerHTML={{ __html: highlighted }} />
				</pre>
			</div>
		</div>
	)
}
