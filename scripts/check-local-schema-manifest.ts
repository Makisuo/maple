import {
	EXPECTED_LOCAL_SCHEMA_MANIFEST_DIGEST,
	LOCAL_SCHEMA_MANIFEST,
	LOCAL_SCHEMA_MANIFEST_DIGEST,
	LOCAL_SCHEMA_VERSION,
} from "../apps/cli/src/server/schema-identity"

if (LOCAL_SCHEMA_MANIFEST_DIGEST !== EXPECTED_LOCAL_SCHEMA_MANIFEST_DIGEST) {
	console.error(
		`local structural schema manifest changed (${LOCAL_SCHEMA_MANIFEST_DIGEST}) without updating the expected manifest and local schema version ${LOCAL_SCHEMA_VERSION}. ` +
			"Add a migration module or an explicit unsupported/destructive transition.",
	)
	process.exit(1)
}

const names = LOCAL_SCHEMA_MANIFEST.objects.map((object) => object.name)
if (new Set(names).size !== names.length) {
	console.error("local structural schema manifest contains duplicate object names")
	process.exit(1)
}

console.log(
	`local structural schema manifest is up to date (schema v${LOCAL_SCHEMA_VERSION}, ${LOCAL_SCHEMA_MANIFEST.objects.length} objects, ${LOCAL_SCHEMA_MANIFEST_DIGEST})`,
)
