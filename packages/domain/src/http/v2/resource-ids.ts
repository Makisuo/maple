import {
	AlertIncidentId,
	AlertRuleId,
	AnomalyIncidentId,
	ErrorIncidentId,
	ErrorIssueId,
	InvestigationId,
} from "../../primitives"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** Canonical shared public-ID codecs for resources referenced across v2 groups. */
export const AlertRulePublicId = PublicId(PublicIdPrefixes.alertRule, AlertRuleId)
export const AlertIncidentPublicId = PublicId(PublicIdPrefixes.alertIncident, AlertIncidentId)
export const AnomalyIncidentPublicId = PublicId(PublicIdPrefixes.anomalyIncident, AnomalyIncidentId)
export const ErrorIncidentPublicId = PublicId(PublicIdPrefixes.errorIncident, ErrorIncidentId)
export const ErrorIssuePublicId = PublicId(PublicIdPrefixes.errorIssue, ErrorIssueId)
export const InvestigationPublicId = PublicId(PublicIdPrefixes.investigation, InvestigationId)
