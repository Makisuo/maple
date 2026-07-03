import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { AiTriageApiGroup } from "./ai-triage"
import { AnomaliesApiGroup } from "./anomalies"
import { ApiKeysApiGroup } from "./api-keys"
import { AlertsApiGroup } from "./alerts"
import { AuthApiGroup, AuthPublicApiGroup } from "./auth"
import { BillingApiGroup, BillingPublicApiGroup } from "./billing"
import { ChatApiGroup } from "./chat"
import { DashboardsApiGroup } from "./dashboards"
import { DemoApiGroup } from "./demo"
import { DigestApiGroup } from "./digest"
import { ErrorsApiGroup } from "./errors"
import { IngestAttributeMappingsApiGroup } from "./ingest-attribute-mappings"
import { IngestKeysApiGroup } from "./ingest-keys"
import { IntegrationsApiGroup } from "./integrations"
import { InvestigationApiGroup, InvestigationsInternalApiGroup } from "./investigations"
import { ObservabilityApiGroup } from "./observability"
import { OnboardingApiGroup } from "./onboarding"
import { OrgClickHouseSettingsApiGroup } from "./org-clickhouse-settings"
import { OrganizationsApiGroup } from "./organizations"
import { QueryEngineApiGroup } from "./query-engine"
import { RecommendationIssuesApiGroup } from "./recommendation-issues"
import { ScrapeTargetsApiGroup } from "./scrape-targets"
import { SessionReplaysApiGroup } from "./session-replay"
import { WarehouseApiGroup } from "./warehouse"
export class MapleApi extends HttpApi.make("MapleApi")
	.add(AuthPublicApiGroup)
	.add(AuthApiGroup)
	.add(AiTriageApiGroup)
	.add(AnomaliesApiGroup)
	.add(ApiKeysApiGroup)
	.add(AlertsApiGroup)
	.add(BillingApiGroup)
	.add(BillingPublicApiGroup)
	.add(ChatApiGroup)
	.add(DashboardsApiGroup)
	.add(DemoApiGroup)
	.add(DigestApiGroup)
	.add(ErrorsApiGroup)
	.add(IngestAttributeMappingsApiGroup)
	.add(IngestKeysApiGroup)
	.add(IntegrationsApiGroup)
	.add(InvestigationApiGroup)
	.add(InvestigationsInternalApiGroup)
	.add(ObservabilityApiGroup)
	.add(OnboardingApiGroup)
	.add(OrgClickHouseSettingsApiGroup)
	.add(OrganizationsApiGroup)
	.add(QueryEngineApiGroup)
	.add(RecommendationIssuesApiGroup)
	.add(ScrapeTargetsApiGroup)
	.add(SessionReplaysApiGroup)
	.add(WarehouseApiGroup)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple API",
			version: "1.0.0",
			description: "Effect-based backend API for Maple.",
		}),
	) {}
