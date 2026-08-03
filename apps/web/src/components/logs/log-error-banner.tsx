import { ErrorSection } from "@maple/ui/components/error-section"
import type { Log } from "@/api/warehouse/logs"

interface LogErrorBannerProps {
	log: Log
}

function getErrorMessage(log: Log): string {
	return log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body ?? ""
}

export function LogErrorBanner({ log }: LogErrorBannerProps) {
	const message = getErrorMessage(log)
	if (!message) return null

	return (
		<ErrorSection
			message={message}
			title={log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error"}
			badge={log.logAttributes["exception.type"] ?? log.logAttributes["error.type"]}
			prompt={{ serviceName: log.serviceName, attributes: log.logAttributes }}
		/>
	)
}
