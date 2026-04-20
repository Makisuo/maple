export const RAW_DATASOURCE_NAMES = {
  logs: ["logs"] as const,
  traces: ["traces"] as const,
  metrics: [
    "metrics_sum",
    "metrics_gauge",
    "metrics_histogram",
    "metrics_exponential_histogram",
  ] as const,
} as const

export interface RawTableTtlOverrides {
  readonly logsRetentionDays: number | null
  readonly tracesRetentionDays: number | null
  readonly metricsRetentionDays: number | null
}

export const EMPTY_TTL_OVERRIDES: RawTableTtlOverrides = {
  logsRetentionDays: null,
  tracesRetentionDays: null,
  metricsRetentionDays: null,
}

const DAY_INTERVAL_REGEX = /(ENGINE_TTL\s+"[^"]*INTERVAL\s+)\d+(\s+DAY)/g

const overrideForDatasource = (
  name: string,
  overrides: RawTableTtlOverrides,
): number | null => {
  if (RAW_DATASOURCE_NAMES.logs.includes(name as never)) {
    return overrides.logsRetentionDays
  }
  if (RAW_DATASOURCE_NAMES.traces.includes(name as never)) {
    return overrides.tracesRetentionDays
  }
  if (RAW_DATASOURCE_NAMES.metrics.includes(name as never)) {
    return overrides.metricsRetentionDays
  }
  return null
}

export interface TtlTransformableResource {
  readonly name: string
  readonly content: string
}

export const applyRawTtlOverrides = <T extends TtlTransformableResource>(
  datasources: ReadonlyArray<T>,
  overrides: RawTableTtlOverrides,
): ReadonlyArray<T> => {
  const hasAnyOverride =
    overrides.logsRetentionDays !== null ||
    overrides.tracesRetentionDays !== null ||
    overrides.metricsRetentionDays !== null
  if (!hasAnyOverride) return datasources

  return datasources.map((datasource) => {
    const days = overrideForDatasource(datasource.name, overrides)
    if (days === null) return datasource
    const next = datasource.content.replace(
      DAY_INTERVAL_REGEX,
      (_match, prefix: string, suffix: string) => `${prefix}${days}${suffix}`,
    )
    if (next === datasource.content) return datasource
    return { ...datasource, content: next }
  })
}

const formatOverride = (value: number | null): string =>
  value === null ? "default" : String(value)

export const computeEffectiveRevision = (
  baseRevision: string,
  overrides: RawTableTtlOverrides,
): string => {
  const hasAnyOverride =
    overrides.logsRetentionDays !== null ||
    overrides.tracesRetentionDays !== null ||
    overrides.metricsRetentionDays !== null
  if (!hasAnyOverride) return baseRevision
  const parts = [
    `l=${formatOverride(overrides.logsRetentionDays)}`,
    `t=${formatOverride(overrides.tracesRetentionDays)}`,
    `m=${formatOverride(overrides.metricsRetentionDays)}`,
  ]
  return `${baseRevision}:${parts.join(":")}`
}
