/**
 * Slack external-upload flow (what `files.uploadV2` in @slack/web-api wraps):
 * files.getUploadURLExternal → POST the bytes → files.completeUploadExternal
 * with a channel/thread so the file is shared in place. Files live in the
 * customer's workspace under Slack's own ACLs; nothing is publicly served.
 *
 * The bot token is per-team (resolved by the caller via `resolveBotToken`), so
 * this works multi-workspace.
 */

const SLACK_API = "https://slack.com/api";

interface SlackApiResponse {
  ok: boolean;
  error?: string;
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
  });
  if (!res.ok) {
    throw new Error(`Slack ${method} failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as T;
  if (!payload.ok) {
    throw new Error(`Slack ${method} failed: ${payload.error ?? "unknown_error"}`);
  }
  return payload;
}

export interface UploadedSlackFile {
  readonly fileId: string;
  readonly permalink: string | null;
}

/**
 * Uploads a PNG and shares it into the given channel/thread. Throws on any
 * step failing — the caller degrades to a text sparkline.
 */
export async function uploadPngToThread(options: {
  readonly botToken: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly filename: string;
  readonly title: string;
  readonly png: Uint8Array;
}): Promise<UploadedSlackFile> {
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
  );

  const uploadRes = await fetch(upload_url, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: options.png as unknown as BodyInit,
  });
  if (!uploadRes.ok) {
    throw new Error(`Slack file upload failed: HTTP ${uploadRes.status}`);
  }

  const completed = await slackApi<
    SlackApiResponse & {
      files?: ReadonlyArray<{ id: string; permalink?: string }>;
    }
  >(
    "files.completeUploadExternal",
    options.botToken,
    JSON.stringify({
      files: [{ id: file_id, title: options.title }],
      channel_id: options.channelId,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    }),
    "application/json; charset=utf-8",
  );

  return {
    fileId: file_id,
    permalink: completed.files?.[0]?.permalink ?? null,
  };
}
