export type WorkerQueueKind = "planetscale-webhook" | "vcs-sync" | "unknown"

export const classifyWorkerQueue = (queueName: string, env: Record<string, unknown>): WorkerQueueKind => {
	if (
		typeof env.PLANETSCALE_WEBHOOK_QUEUE_NAME === "string" &&
		queueName === env.PLANETSCALE_WEBHOOK_QUEUE_NAME
	) {
		return "planetscale-webhook"
	}
	if (typeof env.VCS_SYNC_QUEUE_NAME === "string" && queueName === env.VCS_SYNC_QUEUE_NAME) {
		return "vcs-sync"
	}
	return "unknown"
}
