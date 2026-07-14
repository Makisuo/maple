import { ErrorState } from "@/components/common/error-state"

interface QueryErrorStateProps {
	error: unknown
	className?: string
	titleOverride?: string
	onRetry?: () => void
}

export function QueryErrorState({ error, className, titleOverride, onRetry }: QueryErrorStateProps) {
	return (
		<ErrorState
			error={error}
			title={titleOverride}
			onRetry={onRetry}
			variant="panel"
			className={className}
		/>
	)
}
