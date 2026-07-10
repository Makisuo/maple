import { Schema } from "effect"
import {
	RailwayConnectionId,
	RailwayMetricsIntervalSeconds,
	RailwayTargetId,
	RailwayTokenType,
} from "../primitives"

/**
 * Internal contract between the apps/api Railway integration store and the
 * standalone railway-connector (apps/railway-connector). Both endpoints are
 * authenticated with the `SD_INTERNAL_TOKEN` bearer — the decrypted Railway
 * token only ever transits this internal wire.
 */

export class InternalRailwayService extends Schema.Class<InternalRailwayService>("InternalRailwayService")({
	id: Schema.String,
	name: Schema.String,
}) {}

export class InternalRailwayTarget extends Schema.Class<InternalRailwayTarget>("InternalRailwayTarget")({
	id: RailwayTargetId,
	orgId: Schema.String,
	connectionId: RailwayConnectionId,
	tokenType: RailwayTokenType,
	/** Decrypted Railway API token — internal wire only, never persisted by the connector. */
	token: Schema.String,
	projectId: Schema.String,
	projectName: Schema.NullOr(Schema.String),
	environmentId: Schema.String,
	environmentName: Schema.NullOr(Schema.String),
	services: Schema.Array(InternalRailwayService),
	logsEnabled: Schema.Boolean,
	metricsEnabled: Schema.Boolean,
	metricsIntervalSeconds: RailwayMetricsIntervalSeconds,
	/** Epoch ms of the newest log delivered — reconnect/backfill anchor. Null = start live. */
	logWatermarkMs: Schema.NullOr(Schema.Number),
	/** Epoch ms of the end of the newest metrics window ingested. Null = start at now − interval. */
	metricsWatermarkMs: Schema.NullOr(Schema.Number),
	/**
	 * The org's public ingest key (`maple_pk_*`). The connector pushes converted
	 * logs/metrics through the ingest gateway with this key so the data is billed
	 * and routed (Tinybird vs self-managed ClickHouse) exactly like customer OTLP.
	 */
	ingestKey: Schema.String,
}) {}

export const InternalRailwayTargetList = Schema.Array(InternalRailwayTarget)

export class RailwayResultReport extends Schema.Class<RailwayResultReport>("RailwayResultReport")({
	targetId: RailwayTargetId,
	kind: Schema.Literals(["logs", "metrics"]),
	/** Epoch milliseconds at which the work (flush / poll) completed. */
	at: Schema.Number,
	/** Null on success; pretty-printed failure otherwise. */
	error: Schema.NullOr(Schema.String),
	/** True when Railway answered 401 — the api marks the connection as needing a reconnect. */
	unauthorized: Schema.optionalKey(Schema.Boolean),
	/** True when the report reflects a rate-limited attempt (Retry-After honored). */
	rateLimited: Schema.optionalKey(Schema.Boolean),
	/** Log records or metric data points successfully pushed to ingest. */
	recordsIngested: Schema.optionalKey(Schema.Number),
	/** Records dropped due to buffer overflow / billing limits since the last report. */
	recordsDropped: Schema.optionalKey(Schema.Number),
	/** New log watermark (epoch ms) — the api advances it monotonically. */
	newLogWatermarkMs: Schema.optionalKey(Schema.Number),
	/** New metrics watermark (epoch ms) — the api advances it monotonically. */
	newMetricsWatermarkMs: Schema.optionalKey(Schema.Number),
}) {}

export const RailwayResultReportList = Schema.Array(RailwayResultReport)
