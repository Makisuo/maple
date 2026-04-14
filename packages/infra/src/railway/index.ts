// Railway provisioning is temporarily disabled as part of the alchemy v2
// migration. alchemy@2.0.0-beta.3 does not yet ship a Railway provider, so
// the full provisioning flow below is commented out. Re-enable once the
// provider lands upstream (or port the Railway API calls to plain fetch).

import type { RailwayDeploymentTarget } from "./target";

export {
  parseRailwayDeploymentTarget,
  resolveRailwayTarget,
  resolveRailwayServiceName,
  formatRailwayTargetStage,
} from "./target";
export type { RailwayDeploymentTarget } from "./target";

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
}

export async function provisionRailwayStack(
  _options: ProvisionRailwayStackOptions = {},
): Promise<ProvisionRailwayStackOutput> {
  throw new Error(
    "provisionRailwayStack is disabled during the alchemy v2 migration. " +
      "alchemy@2.0.0-beta.3 does not yet include a Railway provider. " +
      "See packages/infra/src/railway/index.ts for details.",
  );
}

/* Original implementation — restore when Railway provider is available.

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

type EnvMap = Record<string, string | undefined>;

// ...full implementation omitted; see git history for the pre-migration version.
*/
