/**
 * Slack external-upload flow (what `files.uploadV2` in @slack/web-api wraps):
 * files.getUploadURLExternal → POST the bytes → files.completeUploadExternal
 * with a channel/thread so the file is shared in place. Files live in the
 * customer's workspace under Slack's own ACLs; nothing is publicly served.
 *
 * The bot token is per-team (resolved by the caller via `resolveBotToken`), so
 * this works multi-workspace.
 */

const SLACK_API = "https://slack.com/api"

/**
 * Every hop is bounded: a stalled Slack connection would otherwise hang the
 * whole agent turn (and the Slack thread's typing indicator) indefinitely.
 * The byte PUT gets the longer budget because it actually moves a payload;
 * the two JSON calls are metadata round-trips.
 */
const SLACK_API_TIMEOUT_MS = 10_000
const UPLOAD_TIMEOUT_MS = 20_000

interface SlackApiResponse {
	ok: boolean
	error?: string
}

async function slackApi<T extends SlackApiResponse>(
	method: string,
	token: string,
	body: URLSearchParams | string,
	contentType: string,
): Promise<T> {
	const res = await fetch(`${SLACK_API}/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": contentType,
		},
		body,
		signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`Slack ${method} failed: HTTP ${res.status}`)
	}
	const payload = (await res.json()) as T
	if (!payload.ok) {
		throw new Error(`Slack ${method} failed: ${payload.error ?? "unknown_error"}`)
	}
	return payload
}

export interface UploadedSlackFile {
	readonly fileId: string
	readonly permalink: string | null
}

export interface UploadPngOptions {
	readonly botToken: string
	readonly channelId: string
	readonly threadTs?: string
	readonly filename: string
	readonly title: string
	readonly png: Uint8Array
}

/**
 * Uploads a PNG and shares it into the given channel/thread. Throws on any
 * step failing — the caller degrades to a text sparkline.
 */
export async function uploadPngToThread(options: UploadPngOptions): Promise<UploadedSlackFile> {
	const { upload_url, file_id } = await slackApi<
		SlackApiResponse & { upload_url: string; file_id: string }
	>(
		"files.getUploadURLExternal",
		options.botToken,
		new URLSearchParams({
			filename: options.filename,
			length: String(options.png.byteLength),
		}),
		"application/x-www-form-urlencoded",
	)

	const uploadRes = await fetch(upload_url, {
		method: "POST",
		headers: { "content-type": "image/png" },
		body: options.png as BodyInit,
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	})
	if (!uploadRes.ok) {
		throw new Error(`Slack file upload failed: HTTP ${uploadRes.status}`)
	}

	const completed = await slackApi<
		SlackApiResponse & {
			files?: ReadonlyArray<{ id: string; permalink?: string }>
		}
	>(
		"files.completeUploadExternal",
		options.botToken,
		JSON.stringify({
			files: [{ id: file_id, title: options.title }],
			channel_id: options.channelId,
			...(options.threadTs ? { thread_ts: options.threadTs } : undefined),
		}),
		"application/json; charset=utf-8",
	)

	return {
		fileId: file_id,
		permalink: completed.files?.[0]?.permalink ?? null,
	}
}
