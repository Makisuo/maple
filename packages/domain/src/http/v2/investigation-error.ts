import { Match } from "effect"
import { httpErrorMetadata } from "../error-policy"
import { investigationErrorPolicy } from "../investigation-error-meta"
import type {
	InvestigationAgentUnavailableError,
	InvestigationAutomationDisabledError,
	InvestigationHttpError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationQuotaError,
	InvestigationRejectedError,
	InvestigationStartFailedError,
	InvestigationValidationError,
} from "../investigations"
import {
	dependencyUnavailable,
	invalidRequest,
	investigationQuotaReached,
	resourceNotFound,
	serviceError,
	upstreamError,
	type V2InvalidRequestError,
	type V2NotFoundError,
	type V2RateLimitError,
	type V2ServiceUnavailableError,
	type V2UpstreamError,
} from "./errors"

export type V2InvestigationDomainError =
	| V2InvalidRequestError
	| V2NotFoundError
	| V2RateLimitError
	| V2ServiceUnavailableError
	| V2UpstreamError

export type V2InvestigationErrorFor<Error extends InvestigationHttpError> =
	Error extends InvestigationValidationError
		? V2InvalidRequestError
		: Error extends InvestigationNotFoundError
			? V2NotFoundError
			: Error extends InvestigationQuotaError
				? V2RateLimitError
				: Error extends InvestigationRejectedError
					? V2UpstreamError
					: Error extends
								| InvestigationPersistenceError
								| InvestigationAutomationDisabledError
								| InvestigationAgentUnavailableError
								| InvestigationStartFailedError
						? V2ServiceUnavailableError
						: never

/**
 * The single investigation-domain → public-envelope boundary.
 *
 * Routes provide only the operation name used by existing stable public codes;
 * the semantic tag, retry policy, title, recovery, and redaction rules all come
 * from the domain error itself and its exhaustive policy table.
 */
export const investigationErrorToV2 = (
	operation: string,
): (<Error extends InvestigationHttpError>(error: Error) => V2InvestigationErrorFor<Error>) => {
	const map = Match.type<InvestigationHttpError>().pipe(
		Match.tagsExhaustive({
			"@maple/http/investigations/InvestigationPersistenceError": (error) =>
				dependencyUnavailable(
					`investigation_${operation}_unavailable`,
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
			"@maple/http/investigations/InvestigationValidationError": (error) =>
				invalidRequest(
					"parameter_invalid",
					error.message,
					undefined,
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
			"@maple/http/investigations/InvestigationNotFoundError": (error) =>
				resourceNotFound(
					"investigation",
					"No such investigation.",
					"id",
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
			"@maple/http/investigations/InvestigationQuotaError": (error) =>
				investigationQuotaReached(
					{
						dimension: error.dimension,
						limit: error.limit,
						retryableAt: error.retryableAt,
					},
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag], {
						retryAt: error.retryableAt,
					}),
				),
			"@maple/http/investigations/InvestigationAutomationDisabledError": (error) =>
				serviceError(
					"investigation_automation_disabled",
					error.message,
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
			"@maple/http/investigations/InvestigationAgentUnavailableError": (error) =>
				serviceError(
					"investigation_agent_unavailable",
					error.message,
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
			"@maple/http/investigations/InvestigationStartFailedError": (error) =>
				serviceError(
					"investigation_start_failed",
					error.message,
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
			"@maple/http/investigations/InvestigationRejectedError": (error) =>
				upstreamError(
					"investigation_start_rejected",
					`The investigation agent rejected the start request with HTTP ${error.status}.`,
					httpErrorMetadata(error._tag, investigationErrorPolicy[error._tag]),
				),
		}),
	)
	return <Error extends InvestigationHttpError>(error: Error): V2InvestigationErrorFor<Error> =>
		map(error) as V2InvestigationErrorFor<Error>
}
