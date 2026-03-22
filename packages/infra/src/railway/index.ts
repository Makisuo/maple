import {
  Domain,
  Environment,
  Project,
  RailwayApi,
  Service,
  Variable,
  Volume,
  type Environment as RailwayEnvironment,
  type Service as RailwayService,
} from "alchemy/railway";

import {
  formatRailwayTargetStage,
  resolveRailwayServiceName,
  resolveRailwayTarget,
} from "./target";
import type { RailwayDeploymentTarget } from "./target";

export {
  parseRailwayDeploymentTarget,
  resolveRailwayTarget,
  resolveRailwayServiceName,
  formatRailwayTargetStage,
} from "./target";
export type { RailwayDeploymentTarget } from "./target";

type EnvMap = Record<string, string | undefined>;

export interface ProvisionRailwayStackOptions {
  projectName?: string;
  projectId?: string;
  workspaceId?: string;
  target?: RailwayDeploymentTarget;
}

export interface ProvisionRailwayStackOutput {
  target: RailwayDeploymentTarget;
  stage: string;
  environmentName: string;
  projectId: string;
  environmentId: string;
  apiUrl: string;
  ingestUrl: string;
  services: {
    api: RailwayService;
    alerting: RailwayService;
    ingest: RailwayService;
    otelCollector: RailwayService;
  };
}

export async function provisionRailwayStack(
  options: ProvisionRailwayStackOptions = {},
): Promise<ProvisionRailwayStackOutput> {
  const env =
    (globalThis as { process?: { env?: EnvMap } }).process?.env ??
    ({} as EnvMap);
  const reqEnv = (name: string) => requireEnv(name, env);

  const target = options.target ?? { kind: "prd" as const };
  const resolvedTarget = resolveRailwayTarget(target);
  const expectedProjectId =
    options.projectId?.trim() || env.RAILWAY_PROJECT_ID?.trim() || undefined;

  const serviceNames = {
    api: resolveRailwayServiceName("api", target),
    alerting: resolveRailwayServiceName("alerting", target),
    ingest: resolveRailwayServiceName("ingest", target),
    otelCollector: resolveRailwayServiceName("otel-collector", target),
  };

  // --- Project ---

  const project = await Project("maple-project", {
    name: options.projectName ?? "maple",
    workspaceId: options.workspaceId ?? env.RAILWAY_WORKSPACE_ID,
    adopt: true,
    delete: false,
  });

  if (expectedProjectId && project.projectId !== expectedProjectId) {
    throw new Error(
      `Resolved Railway project ID ${project.projectId} does not match expected ${expectedProjectId}.` +
        " Set RAILWAY_PROJECT_ID to the intended project and ensure Alchemy state points to the same project.",
    );
  }

  // --- Environment ---

  const railwayEnvironment =
    target.kind === "prd"
      ? null
      : await Environment(`${resolvedTarget.stage}-environment`, {
          project,
          name: resolvedTarget.environmentName,
          adopt: true,
        });
  const environment = railwayEnvironment ?? project.defaultEnvironmentId;
  const environmentId =
    typeof environment === "string" ? environment : environment.environmentId;
  const environmentName =
    typeof environment === "string"
      ? resolvedTarget.environmentName
      : environment.name;

  const deploymentTriggerBranch = resolveDeploymentTriggerBranch(target, env);

  // --- OTel Collector Service ---

  const otelService = await Service("otel-service", {
    project,
    environment,
    name: serviceNames.otelCollector,
    source: { repo: "Makisuo/maple" },
    ...(deploymentTriggerBranch
      ? {
          deploymentTrigger: {
            branch: deploymentTriggerBranch,
            rootDirectory: "/",
          },
        }
      : {}),
    adopt: true,
  });

  await updateServiceInstanceMonorepoConfig({
    serviceId: otelService.serviceId,
    environmentId,
    rootDirectory: "/otel",
    dockerfilePath: "Dockerfile",
    watchPatterns: ["otel/**"],
  });

  const apiPrivateHost = `${serviceNames.api}.railway.internal`;

  await Variable("otel-service-variables", {
    project,
    environment: environmentId,
    service: otelService,
    variables: {
      RAILWAY_RUN_UID: "0",
      TINYBIRD_HOST: reqEnv("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: reqEnv("TINYBIRD_TOKEN"),
      SD_API_HOST: apiPrivateHost,
      SD_API_PORT: "3472",
      SD_INTERNAL_TOKEN: env.SD_INTERNAL_TOKEN?.trim() || "",
    },
  });

  await Volume("otel-queue-storage", {
    project,
    service: otelService,
    environment,
    mountPath: "/var/lib/otelcol/file_storage",
    delete: false,
  });

  const otelPrivateEndpoint = toOtelPrivateEndpoint(otelService.name);

  // --- API Service ---

  const apiService = await Service("api-service", {
    project,
    environment,
    name: serviceNames.api,
    source: { repo: "Makisuo/maple" },
    healthcheckPath: "/health",
    ...(deploymentTriggerBranch
      ? {
          deploymentTrigger: {
            branch: deploymentTriggerBranch,
            rootDirectory: "/",
          },
        }
      : {}),
    adopt: true,
  });

  await updateServiceInstanceMonorepoConfig({
    serviceId: apiService.serviceId,
    environmentId,
    rootDirectory: "/",
    dockerfilePath: "apps/api/Dockerfile",
    watchPatterns: [
      "apps/api/**",
      "packages/**",
      "package.json",
      "bun.lock",
      "turbo.json",
    ],
  });

  const authMode = env.MAPLE_AUTH_MODE?.trim() || "self_hosted";
  const appBaseUrl = resolveAppBaseUrl(target, env);

  await Variable("api-service-variables", {
    project,
    environment: environmentId,
    service: apiService,
    variables: {
      PORT: "3472",
      MAPLE_AUTH_MODE: authMode,
      MAPLE_ROOT_PASSWORD:
        authMode === "clerk"
          ? env.MAPLE_ROOT_PASSWORD?.trim() || ""
          : reqEnv("MAPLE_ROOT_PASSWORD"),
      TINYBIRD_HOST: reqEnv("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: reqEnv("TINYBIRD_TOKEN"),
      MAPLE_DB_URL: reqEnv("MAPLE_DB_URL"),
      MAPLE_DB_AUTH_TOKEN: reqEnv("MAPLE_DB_AUTH_TOKEN"),
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: reqEnv(
        "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
      ),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: reqEnv(
        "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
      ),
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY?.trim() || "",
      CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY?.trim() || "",
      CLERK_JWT_KEY: env.CLERK_JWT_KEY?.trim() || "",
      SD_INTERNAL_TOKEN: env.SD_INTERNAL_TOKEN?.trim() || "",
      INTERNAL_SERVICE_TOKEN: env.INTERNAL_SERVICE_TOKEN?.trim() || "",
      AUTUMN_SECRET_KEY: env.AUTUMN_SECRET_KEY?.trim() || "",
      MAPLE_APP_BASE_URL: appBaseUrl,
      OTEL_ENVIRONMENT: "production",
      OTEL_BASE_URL: toIngestPrivateEndpoint(serviceNames.ingest),
      MAPLE_OTEL_INGEST_KEY: env.MAPLE_OTEL_INGEST_KEY?.trim() || "",
    },
  });

  // --- Alerting Service ---

  const alertingService = await Service("alerting-service", {
    project,
    environment,
    name: serviceNames.alerting,
    source: { repo: "Makisuo/maple" },
    ...(deploymentTriggerBranch
      ? {
          deploymentTrigger: {
            branch: deploymentTriggerBranch,
            rootDirectory: "/",
          },
        }
      : {}),
    adopt: true,
  });

  await updateServiceInstanceMonorepoConfig({
    serviceId: alertingService.serviceId,
    environmentId,
    rootDirectory: "/",
    dockerfilePath: "apps/alerting/Dockerfile",
    watchPatterns: [
      "apps/alerting/**",
      "apps/api/**",
      "packages/**",
      "package.json",
      "bun.lock",
      "turbo.json",
    ],
  });

  await Variable("alerting-service-variables", {
    project,
    environment: environmentId,
    service: alertingService,
    variables: {
      TINYBIRD_HOST: reqEnv("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: reqEnv("TINYBIRD_TOKEN"),
      MAPLE_DB_URL: reqEnv("MAPLE_DB_URL"),
      MAPLE_DB_AUTH_TOKEN: reqEnv("MAPLE_DB_AUTH_TOKEN"),
      MAPLE_AUTH_MODE: authMode,
      MAPLE_ROOT_PASSWORD:
        authMode === "clerk"
          ? env.MAPLE_ROOT_PASSWORD?.trim() || ""
          : reqEnv("MAPLE_ROOT_PASSWORD"),
      MAPLE_DEFAULT_ORG_ID: env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: reqEnv(
        "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
      ),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: reqEnv(
        "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
      ),
      CLERK_SECRET_KEY: env.CLERK_SECRET_KEY?.trim() || "",
      CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY?.trim() || "",
      CLERK_JWT_KEY: env.CLERK_JWT_KEY?.trim() || "",
      MAPLE_APP_BASE_URL: appBaseUrl,
    },
  });

  // --- Ingest Service ---

  const ingestService = await Service("ingest-service", {
    project,
    environment,
    name: serviceNames.ingest,
    source: { repo: "Makisuo/maple" },
    healthcheckPath: "/health",
    ...(deploymentTriggerBranch
      ? {
          deploymentTrigger: {
            branch: deploymentTriggerBranch,
            rootDirectory: "/apps/ingest",
          },
        }
      : {}),
    adopt: true,
  });

  await updateServiceInstanceMonorepoConfig({
    serviceId: ingestService.serviceId,
    environmentId,
    rootDirectory: "/apps/ingest",
    dockerfilePath: "Dockerfile",
    watchPatterns: ["apps/ingest/**"],
  });

  await Variable("ingest-service-variables", {
    project,
    environment: environmentId,
    service: ingestService,
    variables: {
      PORT: "3474",
      INGEST_PORT: "3474",
      INGEST_FORWARD_OTLP_ENDPOINT:
        env.INGEST_FORWARD_OTLP_ENDPOINT?.trim() || otelPrivateEndpoint,
      INGEST_FORWARD_TIMEOUT_MS:
        env.INGEST_FORWARD_TIMEOUT_MS?.trim() || "10000",
      INGEST_MAX_REQUEST_BODY_BYTES:
        env.INGEST_MAX_REQUEST_BODY_BYTES?.trim() || "20971520",
      INGEST_REQUIRE_TLS: env.INGEST_REQUIRE_TLS?.trim() || "false",
      MAPLE_DB_URL: reqEnv("MAPLE_DB_URL"),
      MAPLE_DB_AUTH_TOKEN: reqEnv("MAPLE_DB_AUTH_TOKEN"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: reqEnv(
        "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
      ),
      AUTUMN_SECRET_KEY: reqEnv("AUTUMN_SECRET_KEY"),
    },
  });

  // --- Domains ---

  const apiDomainResourceId =
    target.kind === "prd" ? "api-domain-custom" : "api-domain";
  const apiDomain = await Domain(apiDomainResourceId, {
    service: apiService,
    environment,
    ...(target.kind === "prd" ? { domain: "api.maple.dev" } : {}),
    targetPort: 3472,
  });

  const ingestDomainResourceId =
    target.kind === "prd" ? "ingest-domain-custom" : "ingest-domain";
  const ingestDomain = await Domain(ingestDomainResourceId, {
    service: ingestService,
    environment,
    ...(target.kind === "prd" ? { domain: "ingest.maple.dev" } : {}),
    targetPort: 3474,
  });

  await Variable("api-service-public-ingest-url", {
    project,
    environment: environmentId,
    service: apiService,
    variables: {
      MAPLE_INGEST_PUBLIC_URL: toHttpsUrl(ingestDomain.domain),
    },
  });

  return {
    target,
    stage: formatRailwayTargetStage(target),
    environmentName,
    projectId: project.projectId,
    environmentId,
    apiUrl: toHttpsUrl(apiDomain.domain),
    ingestUrl: toHttpsUrl(ingestDomain.domain),
    services: {
      api: apiService,
      alerting: alertingService,
      ingest: ingestService,
      otelCollector: otelService,
    },
  };
}

// --- Helpers ---

function toOtelPrivateEndpoint(serviceName: string): string {
  return `http://${serviceName}.railway.internal:4318`;
}

function toIngestPrivateEndpoint(serviceName: string): string {
  return `http://${serviceName}.railway.internal:3474`;
}

function toHttpsUrl(domain: string): string {
  return `https://${domain}`;
}

function resolveAppBaseUrl(
  target: RailwayDeploymentTarget,
  env: EnvMap,
): string {
  const configured = env.MAPLE_APP_BASE_URL?.trim();
  if (configured) {
    return configured;
  }

  switch (target.kind) {
    case "prd":
      return "https://app.maple.dev";
    case "stg":
      return "https://staging.maple.dev";
    case "pr":
      return "http://127.0.0.1:3471";
  }
}

function requireEnv(name: string, env: EnvMap): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveDeploymentTriggerBranch(
  target: RailwayDeploymentTarget,
  env: EnvMap,
): string | undefined {
  switch (target.kind) {
    case "prd":
      return "main";
    case "stg":
      return "develop";
    case "pr":
      return env.PR_BRANCH?.trim() || env.GITHUB_HEAD_REF?.trim() || undefined;
  }
}

async function updateServiceInstanceMonorepoConfig({
  serviceId,
  environmentId,
  rootDirectory,
  dockerfilePath,
  watchPatterns,
}: {
  serviceId: string;
  environmentId: string;
  rootDirectory: string;
  dockerfilePath: string;
  watchPatterns: string[];
}): Promise<void> {
  const api = new RailwayApi();
  await api.query(
    `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    {
      serviceId,
      environmentId,
      input: {
        rootDirectory,
        dockerfilePath,
        watchPatterns,
      },
    },
  );
}
