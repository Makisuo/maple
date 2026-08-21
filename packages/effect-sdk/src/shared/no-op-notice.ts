// One-shot "telemetry disabled" notice.
//
// All three presets (server layer, server/client flushable, Cloudflare) disable
// themselves on the same condition — no ingest key resolved — and each needs to
// say so exactly once, so a developer running locally sees why nothing arrives
// instead of silently believing telemetry works. Sharing the wording keeps that
// message identical across presets; only the enable hint differs, because the
// key comes from env on the server and from config in the browser.

export const makeNoOpNotice = (logPrefix: string, enableHint: string): (() => void) => {
	let logged = false
	return () => {
		if (logged) return
		logged = true
		console.info(`${logPrefix} no ingest key configured — telemetry disabled (${enableHint})`)
	}
}
