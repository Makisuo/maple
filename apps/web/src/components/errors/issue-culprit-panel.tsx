import type { ErrorIssueDocument } from "@maple/domain/http"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { cn } from "@maple/ui/lib/utils"

import { SEVERITY_FILL } from "./severity-badge"

/**
 * What the error says, and where it came from.
 *
 * `topFrame` and `fingerprintHash` were both on the wire and drawn nowhere — the
 * only thing that ever read them was the investigation snapshot the "Investigate"
 * button builds. So the page that exists to answer "what broke and where" showed
 * the message as a muted paragraph and never named a line of code, while the
 * agent it hands off to was told both.
 *
 * The message is promoted to `text-foreground`: it is the page's primary
 * content, not a caption under the title.
 *
 * Accent-rule card, following `investigations/verdict-card.tsx` — square on the
 * accented edge, because a rounded corner behind a flat bar leaves a sliver of
 * card showing past it and reads as a rendering bug.
 */
export function IssueCulpritPanel({ issue }: { issue: ErrorIssueDocument }) {
	const message = issue.exceptionMessage || issue.errorLabel
	const accent = issue.severity === null ? "bg-border" : SEVERITY_FILL[issue.severity]

	return (
		<div className="flex shrink-0 overflow-hidden rounded-r-xl border bg-card">
			<span aria-hidden className={cn("w-[3px] shrink-0", accent)} />
			<div className="flex min-w-0 flex-1 flex-col gap-4 px-6 py-5">
				{message ? (
					<p className="min-w-0 break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground">
						{message}
					</p>
				) : (
					<p className="text-sm text-muted-foreground">
						This error carries no message — only its type and where it was raised.
					</p>
				)}

				<Field label="Culprit">
					{issue.topFrame ? (
						<Mono value={issue.topFrame} copyLabel="Top frame" />
					) : (
						<span className="text-xs text-muted-foreground">
							No stack frame was attributed to this fingerprint.
						</span>
					)}
				</Field>

				{issue.fingerprintHash ? (
					<Field label="Fingerprint">
						<Mono value={issue.fingerprintHash} copyLabel="Fingerprint" />
					</Field>
				) : null}
			</div>
		</div>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-t pt-3.5 first:border-t-0 first:pt-0">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			{children}
		</div>
	)
}

/**
 * A mono value with its copy button riding the same line. The frame is the one
 * thing on this page you paste into an editor, and the hash is the one thing you
 * paste into a query — neither is worth retyping.
 */
function Mono({ value, copyLabel }: { value: string; copyLabel: string }) {
	return (
		<div className="group/mono flex min-w-0 items-start gap-1.5">
			<code className="min-w-0 break-all font-mono text-xs leading-5 text-foreground/90">{value}</code>
			<CopyButton
				value={value}
				label={copyLabel}
				toast={false}
				tooltip
				className="-my-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/mono:opacity-100"
			/>
		</div>
	)
}
