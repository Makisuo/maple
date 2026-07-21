/**
 * Resolve the service-detail page's environment search param (array-typed,
 * single-element by convention) to the single `deploymentEnv` the
 * dependencies-bundle API accepts. The filter applies only when exactly one
 * environment is selected; the service list's synthetic `"unknown"` label maps
 * back to the raw empty-string warehouse value (mirroring `toEnvFilter` in
 * api/warehouse/custom-charts.ts). Note the bundle's DSL queries treat `""` as
 * unset, so an "unknown" selection currently falls back to all environments.
 *
 * Used by both `ServiceDependencyStrip` and `ServiceDependenciesTab` — the two
 * share one bundle atom key, so they must derive this identically or the
 * strip→tab navigation loses its cache hit.
 */
export const toSingleDeploymentEnv = (
	environments: ReadonlyArray<string> | undefined,
): string | undefined =>
	environments?.length === 1 ? (environments[0] === "unknown" ? "" : environments[0]) : undefined
