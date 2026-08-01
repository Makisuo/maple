import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import schemaV1Sql from "./schema/local-schema-v1.sql" with { type: "text" }
import { schemaDigest as digestSchema, schemaFingerprint as fingerprintSchema } from "./store-version"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LOCAL_SCHEMA_VERSION } from "./local-schema-version"
import { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"
import { CHDB_VERSION } from "../version"

export { LOCAL_SCHEMA_HISTORY } from "./local-schema-history"

/**
 * Local-store schema version.
 *
 * Version 0 is the fingerprint-only legacy store represented by the recovery
 * procedure from issue #297. Any future structural DDL change must increment
 * this value and add a registered migration or an explicit unsupported edge.
 */
export { LOCAL_SCHEMA_VERSION }
export const LEGACY_LOCAL_SCHEMA_VERSION = 0 as const

export const LEGACY_SCHEMA_PROJECT_REVISION =
	"d58ce4a83d3ad3f3a29b9bb972272b757547ae793c050194354454634f3abccd"
export const LEGACY_SCHEMA_FINGERPRINT = "428701854f9fd30e"

export const CURRENT_SCHEMA_PROJECT_REVISION =
	"b6569235f05a5981ffe47f25d22fd90a8783f3200410a519fcf25577b445275b"
/** Revision recorded by the issue-297 recovery report. The refreshed upstream
 * generator currently emits CURRENT_SCHEMA_PROJECT_REVISION; the structural
 * fingerprint is the compatibility identity used by the migration. */
export const ISSUE_297_TARGET_SCHEMA_PROJECT_REVISION =
	"506bc745f7a7eca202ec905a6403a6815e86413faf0cd3cbbf73881023edce91"
export const LOCAL_SCHEMA_SQL = schemaSql
export const SCHEMA_FINGERPRINT = fingerprintSchema(schemaSql)
export const SCHEMA_DIGEST = digestSchema(schemaSql)
export const LOCAL_SCHEMA_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaSql)
export const LOCAL_SCHEMA_MANIFEST_DIGEST = LOCAL_SCHEMA_MANIFEST.digest
/** Immutable v1 DDL/manifest snapshot used by the v0 -> v1 module even after
 * the generated current schema advances. */
export const LOCAL_SCHEMA_V1_SQL = schemaV1Sql
export const LOCAL_SCHEMA_V1_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV1Sql)
export const LOCAL_SCHEMA_V1_MANIFEST_DIGEST = LOCAL_SCHEMA_V1_MANIFEST.digest
/** Compatibility alias for callers that used the old gate constant. The value
 * is sourced from the append-only literal history, not from the current
 * manifest, so updating a schema without appending its identity still fails. */
export const EXPECTED_LOCAL_SCHEMA_MANIFEST_DIGEST =
	LOCAL_SCHEMA_HISTORY[LOCAL_SCHEMA_HISTORY.length - 1]!.manifestDigest

export interface LocalSchemaIdentity {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest?: string
	readonly chdb: string
	readonly projectRevision?: string
}

/**
 * The v1 identity is deliberately frozen. Historical migration edges must
 * never point at CURRENT_LOCAL_SCHEMA: when v2 ships, v0 -> v1 must still
 * construct and verify v1 rather than silently changing its destination.
 */
export const LOCAL_SCHEMA_V1: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[1]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[1]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[1]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[1]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[1]!.projectRevision,
})

export const CURRENT_LOCAL_SCHEMA: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_VERSION,
	fingerprint: SCHEMA_FINGERPRINT,
	digest: SCHEMA_DIGEST,
	manifestDigest: LOCAL_SCHEMA_MANIFEST_DIGEST,
	chdb: CHDB_VERSION,
	projectRevision: CURRENT_SCHEMA_PROJECT_REVISION,
})

export const LEGACY_LOCAL_SCHEMA: LocalSchemaIdentity = {
	version: LEGACY_LOCAL_SCHEMA_VERSION,
	fingerprint: LEGACY_SCHEMA_FINGERPRINT,
	digest: "",
	chdb: CHDB_VERSION,
	projectRevision: LEGACY_SCHEMA_PROJECT_REVISION,
}

export const identityLabel = (identity: Pick<LocalSchemaIdentity, "version" | "fingerprint">): string =>
	`v${identity.version} (${identity.fingerprint})`
