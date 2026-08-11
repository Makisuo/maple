import type { AlertsService } from "@/services/alerts/AlertsService"
import type { AlertReadModelsService } from "@/services/alerts/AlertReadModelsService"
import type { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import type { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import type { ErrorIssueWorkflowService } from "@/services/errors/ErrorIssueWorkflowService"
import type { ErrorsService } from "@/services/errors/ErrorsService"
import type { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import type { VcsSourceService } from "@/services/integrations/vcs/VcsSourceService"
import type { SetupAuditService } from "@/services/org/SetupAuditService"
import type { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import type { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import type { CurrentMcpTenant } from "../lib/query-warehouse"

/**
 * Application services an MCP tool handler may use after its request tenant has
 * been supplied. This is intentionally finite: registering a tool with a new
 * dependency must also extend the executor layer that captures that dependency.
 */
export type McpToolRuntimeRequirements =
	| AlertsService
	| AlertReadModelsService
	| DashboardPersistenceService
	| ErrorActorsService
	| ErrorIssueWorkflowService
	| ErrorsService
	| QueryEngineService
	| RecommendationIssueService
	| SetupAuditService
	| VcsSourceService
	| WarehouseQueryService

/** Every service a raw registered MCP handler may require. */
export type McpToolRequirements = CurrentMcpTenant | McpToolRuntimeRequirements
