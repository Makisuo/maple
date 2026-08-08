import { Button } from "@maple/ui/components/ui/button"

interface TurnFailureNoticeProps {
	readonly error: Error
	readonly onContinue: () => void
}

/** An admitted chat turn failed after the user's message reached the server. */
export function TurnFailureNotice({ error, onContinue }: TurnFailureNoticeProps) {
	return (
		<div
			role="alert"
			className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
		>
			<span className="min-w-0 text-destructive">Response failed — {error.message}</span>
			<Button type="button" size="sm" variant="outline" onClick={onContinue}>
				Continue
			</Button>
		</div>
	)
}
