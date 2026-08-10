// Replay event-stream normalization
//
// The player concatenates a session's rrweb chunk blobs into one event array.
// Sessions recorded before chunk sequences became monotonic-per-session can
// carry duplicate/overwritten chunk-index rows whose blobs decode out of order,
// so the concatenated stream may be scrambled or contain duplicates. rrweb's
// `getMetaData().totalTime` (last − first timestamp) and the player's
// idle-collapse both assume a clean, chronologically-ordered stream — feed them
// a corrupted one and the reported length balloons to the whole tab lifetime.
//
// `normalizeEvents` repairs the stream so those legacy sessions stay playable.

import { Array as Arr, Order } from "effect"

/** True when `event` is an object carrying a numeric `timestamp` — narrows without a cast. */
const hasTimestamp = (event: unknown): event is { timestamp: number } =>
	typeof event === "object" && event !== null && "timestamp" in event && typeof event.timestamp === "number"

const timestampOf = (event: unknown): number => (hasTimestamp(event) ? event.timestamp : 0)

/** Order events by timestamp; ties keep input order (Arr.sort is a stable native sort). */
const byTimestamp = Order.mapInput(Order.Number, timestampOf)

const isSameEvent = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Stable-sort the concatenated event stream by timestamp and drop exact adjacent
 * duplicates. Equal timestamps keep their original (chunk-seq) order, matching
 * how rrweb recorded them; distinct events that merely share a timestamp survive.
 */
export function normalizeEvents(events: ReadonlyArray<unknown>): unknown[] {
	return Arr.dedupeAdjacentWith(Arr.sort(events, byTimestamp), isSameEvent)
}
