/**
 * Session-replay privacy convention for the dashboard, which records itself with
 * rrweb (`otel-layer.ts`) at `maskAllInputs: true` / `maskAllText: false` — so any
 * secret rendered as plain text, not into an `<input>`, is serialized verbatim into
 * the replay stream.
 *
 * rrweb's default `blockClass` is `rr-block` and `startRecording`
 * (`packages/browser-session/src/replay/record.ts`) never overrides it. Blocking is
 * ancestor-checked: the element and its whole subtree are replaced by a sized
 * placeholder at serialization time, so the values never leave the browser.
 *
 * Put this on the smallest container that encloses a revealed secret — TOTP setup
 * keys and QR codes, backup/recovery codes, freshly minted API and ingest keys.
 */
export const REPLAY_BLOCK_CLASS = "rr-block"
