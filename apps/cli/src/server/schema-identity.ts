import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import schemaV1Sql from "./schema/local-schema-v1.sql" with { type: "text" }
import schemaV2Sql from "./schema/local-schema-v2.sql" with { type: "text" }
import schemaV3Sql from "./schema/local-schema-v3.sql" with { type: "text" }
import schemaV4Sql from "./schema/local-schema-v4.sql" with { type: "text" }
import schemaV5Sql from "./schema/local-schema-v5.sql" with { type: "text" }
import schemaV6Sql from "./schema/local-schema-v6.sql" with { type: "text" }
import schemaV7Sql from "./schema/local-schema-v7.sql" with { type: "text" }
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
	"5d24e4511fb65afbb0bc90a4e6e31fe78a5b7389ba5807fb48eada2b04f7d7d8"
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
/** Immutable v2 DDL/manifest snapshot used by the v1 -> v2 module even after
 * the generated current schema advances. */
export const LOCAL_SCHEMA_V2_SQL = schemaV2Sql
export const LOCAL_SCHEMA_V2_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV2Sql)
export const LOCAL_SCHEMA_V2_MANIFEST_DIGEST = LOCAL_SCHEMA_V2_MANIFEST.digest
/** Immutable v3 DDL/manifest snapshot used by the v2 -> v3 module after the
 * generated current schema advances. */
export const LOCAL_SCHEMA_V3_SQL = schemaV3Sql
export const LOCAL_SCHEMA_V3_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV3Sql)
export const LOCAL_SCHEMA_V3_MANIFEST_DIGEST = LOCAL_SCHEMA_V3_MANIFEST.digest
/** Immutable v4 DDL/manifest snapshot used by the v3 -> v4 module after the
 * generated current schema advances. */
export const LOCAL_SCHEMA_V4_SQL = schemaV4Sql
export const LOCAL_SCHEMA_V4_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV4Sql)
export const LOCAL_SCHEMA_V4_MANIFEST_DIGEST = LOCAL_SCHEMA_V4_MANIFEST.digest
/** Immutable v5 DDL/manifest snapshot used by the v4 -> v5 module after the
 * generated current schema advances. */
export const LOCAL_SCHEMA_V5_SQL = schemaV5Sql
export const LOCAL_SCHEMA_V5_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV5Sql)
export const LOCAL_SCHEMA_V5_MANIFEST_DIGEST = LOCAL_SCHEMA_V5_MANIFEST.digest
/** Immutable v6 DDL/manifest snapshot used by the v5 -> v6 module after the
 * generated current schema advances. */
export const LOCAL_SCHEMA_V6_SQL = schemaV6Sql
export const LOCAL_SCHEMA_V6_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV6Sql)
export const LOCAL_SCHEMA_V6_MANIFEST_DIGEST = LOCAL_SCHEMA_V6_MANIFEST.digest
/** Immutable v7 DDL/manifest snapshot used by the v6 -> v7 module after the
 * generated current schema advances. */
export const LOCAL_SCHEMA_V7_SQL = schemaV7Sql
export const LOCAL_SCHEMA_V7_MANIFEST: LocalSchemaManifest = buildLocalSchemaManifest(schemaV7Sql)
export const LOCAL_SCHEMA_V7_MANIFEST_DIGEST = LOCAL_SCHEMA_V7_MANIFEST.digest
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

export const LOCAL_SCHEMA_V2: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[2]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[2]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[2]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[2]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[2]!.projectRevision,
})

export const LOCAL_SCHEMA_V3: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[3]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[3]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[3]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[3]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[3]!.projectRevision,
})

export const LOCAL_SCHEMA_V4: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[4]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[4]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[4]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[4]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[4]!.projectRevision,
})

export const LOCAL_SCHEMA_V5: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[5]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[5]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[5]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[5]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[5]!.projectRevision,
})

export const LOCAL_SCHEMA_V6: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[6]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[6]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[6]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[6]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[6]!.projectRevision,
})

export const LOCAL_SCHEMA_V7: LocalSchemaIdentity = Object.freeze({
	version: LOCAL_SCHEMA_HISTORY[7]!.version,
	fingerprint: LOCAL_SCHEMA_HISTORY[7]!.fingerprint,
	digest: LOCAL_SCHEMA_HISTORY[7]!.digest,
	manifestDigest: LOCAL_SCHEMA_HISTORY[7]!.manifestDigest,
	chdb: CHDB_VERSION,
	projectRevision: LOCAL_SCHEMA_HISTORY[7]!.projectRevision,
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
