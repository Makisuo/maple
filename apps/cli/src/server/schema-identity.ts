import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import { schemaDigest as digestSchema, schemaFingerprint as fingerprintSchema } from "./store-version"
import { buildLocalSchemaManifest, type LocalSchemaManifest } from "./schema-manifest"
import { LOCAL_SCHEMA_VERSION } from "./local-schema-version"
import { CHDB_VERSION } from "../version"

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
/** Generated compatibility gate for structural DDL. When this changes, the
 * local schema version and migration decision must change in the same commit.
 * Cosmetic SQL comments/whitespace do not alter this manifest digest. */
export const EXPECTED_LOCAL_SCHEMA_MANIFEST_DIGEST =
	"24a7e52d4ae31f479db97c091d0db5c32bdf8e018e04ed00abcd53124b1f9de3"

export interface LocalSchemaIdentity {
	readonly version: number
	readonly fingerprint: string
	readonly digest: string
	readonly manifestDigest?: string
	readonly chdb: string
	readonly projectRevision?: string
}

export const CURRENT_LOCAL_SCHEMA: LocalSchemaIdentity = {
	version: LOCAL_SCHEMA_VERSION,
	fingerprint: SCHEMA_FINGERPRINT,
	digest: SCHEMA_DIGEST,
	manifestDigest: LOCAL_SCHEMA_MANIFEST_DIGEST,
	chdb: CHDB_VERSION,
	projectRevision: CURRENT_SCHEMA_PROJECT_REVISION,
}

export const LEGACY_LOCAL_SCHEMA: LocalSchemaIdentity = {
	version: LEGACY_LOCAL_SCHEMA_VERSION,
	fingerprint: LEGACY_SCHEMA_FINGERPRINT,
	digest: "",
	chdb: CHDB_VERSION,
	projectRevision: LEGACY_SCHEMA_PROJECT_REVISION,
}

export const identityLabel = (identity: Pick<LocalSchemaIdentity, "version" | "fingerprint">): string =>
	`v${identity.version} (${identity.fingerprint})`
