---
title: "Product events API"
description: "Post product events from a backend or mobile app to POST /v1/events on the Maple ingest gateway — the raw NDJSON contract every server-side track() call uses."
group: "Session Replay"
order: 3
---

Browser page views and `track()` calls reach Maple through the session SDKs. Everything else — a
`signup_completed` from a webhook handler, a `plan_started` from your billing worker, a screen
view from a native app — is posted directly to the ingest gateway. Rows land in the same
`product_events` table as the browser events, so one funnel can span the marketing site, the app,
and the backend.

## Endpoint

```
POST https://ingest.maple.dev/v1/events
Authorization: Bearer <ingest key>        # or X-Maple-Ingest-Key: <ingest key>
Content-Type: application/x-ndjson
```

The body is **NDJSON**: one JSON object per line, any number of lines. The organization is
resolved from the ingest key — an `org_id` in the body is ignored.

```json
{"name":"signup_completed","user_id":"user_01H…","service_name":"maple-api"}
{"name":"plan_started","user_id":"user_01H…","group_id":"org_01H…","attributes":{"plan":"startup"}}
{"name":"$screen","source":"mobile","visitor_id":"install-8f3…","page_path":"Checkout"}
```

## Fields

| Field          | Type   | Notes                                                                                                                                                           |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | string | **Required.** 1–128 bytes. Names starting with `$` are reserved for Maple's SDKs and dropped, except `$screen` (mobile screen view, stored as `Kind = screen`). |
| `timestamp`    | string | RFC 3339 (`2026-08-17T10:15:30.123Z`) or `YYYY-MM-DD HH:MM:SS[.fff]` (UTC). Defaults to the time the gateway received the batch. Stored as UTC.                 |
| `source`       | string | `server` (default) or `mobile`. `browser` is reserved for the SDKs; other values drop the row.                                                                  |
| `visitor_id`   | string | Anonymous/device id — the browser SDK cookie value or a persistent mobile install id. ≤ 256 bytes.                                                              |
| `user_id`      | string | Your user id after sign-in, matching what you pass to `identify()`. ≤ 256 bytes.                                                                                |
| `group_id`     | string | Account / workspace / org id. ≤ 256 bytes.                                                                                                                      |
| `session_id`   | string | Optional link to a browser or mobile session. ≤ 256 bytes.                                                                                                      |
| `service_name` | string | The emitting service (`maple-api`, `acme-ios`). ≤ 128 bytes.                                                                                                    |
| `url`          | string | Optional. `host` (lowercase) and `page_path` (pathname only) are derived from it.                                                                               |
| `page_path`    | string | Optional explicit path; overrides the one derived from `url`. Mobile `$screen` events put the screen name here.                                                 |
| `attributes`   | object | Optional properties. ≤ 32 keys, key ≤ 64 bytes, value ≤ 1024 bytes; non-string values are stringified.                                                          |

Over-long strings are truncated at the caps above; unknown fields are discarded.

## Responses

| Status | Meaning                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | `{"accepted": <n>}` — rows durably queued. Malformed rows (bad `name`, `source`, `timestamp`) are dropped individually and not counted. |
| `400`  | A line is not valid JSON, or not a JSON object. The whole batch is rejected.                                                            |
| `401`  | Missing or invalid ingest key.                                                                                                          |
| `402`  | The organization is out of quota for product events (`product_events` is metered per event, separately from browser sessions).                                          |
| `503`  | Storage temporarily unavailable — retry with backoff.                                                                                   |

Product events are not metered separately: they are covered by the browser-sessions entitlement.

## Example

```bash
curl -X POST https://ingest.maple.dev/v1/events \
  -H "Authorization: Bearer $MAPLE_INGEST_KEY" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary $'{"name":"plan_started","user_id":"user_123","attributes":{"plan":"startup"}}\n'
```
