import { Textarea } from "@maple/ui/components/ui/textarea"

// Note (markdown) widget content editor.
//
// Notes are static — there is no query and no warehouse round-trip, so this
// panel replaces the query panels entirely and the preview updates as you type.
// `MarkdownWidget` supports headings, bold/italic, inline code, bullet and
// ordered lists, and links (non-http schemes are rendered inert).

interface MarkdownEditorPanelProps {
	content: string
	onChange: (content: string) => void
}

export function MarkdownEditorPanel({ content, onChange }: MarkdownEditorPanelProps) {
	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between">
				<p className="text-[10px] uppercase tracking-wider text-muted-foreground">Content</p>
				<p className="text-[11px] text-muted-foreground">
					Markdown: <code># heading</code>, <code>**bold**</code>, <code>- list</code>,{" "}
					<code>[link](url)</code>
				</p>
			</div>
			<Textarea
				value={content}
				onChange={(event) => onChange(event.target.value)}
				placeholder={"## Runbook\n\n- Check the error rate panel first\n- Escalate to #oncall"}
				spellCheck
				className="min-h-56 font-mono text-xs leading-relaxed"
			/>
		</div>
	)
}
