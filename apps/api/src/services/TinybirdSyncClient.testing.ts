import type { OrgId } from "@maple/domain/http"
import {
	type TinybirdDeploymentReadiness,
	type TinybirdInstanceHealth,
	type TinybirdProjectSyncParams,
	TinybirdSyncRejectedError,
	TinybirdSyncUnavailableError,
} from "@maple/domain/tinybird-project-sync"
import { Effect, Layer } from "effect"
import {
	TinybirdSyncClient,
	type TinybirdSyncClientShape,
	TinybirdWorkflowKickoffError,
} from "./TinybirdSyncClient"

type DeploymentParams = TinybirdProjectSyncParams & { readonly deploymentId: string }

export interface TinybirdSyncClientOverrides {
	readonly getDeploymentStatus?: (params: DeploymentParams) => Promise<TinybirdDeploymentReadiness>
	readonly cleanupOwnedDeployment?: (params: DeploymentParams) => Promise<void>
	readonly fetchInstanceHealth?: (params: TinybirdProjectSyncParams) => Promise<TinybirdInstanceHealth>
	readonly getProjectRevision?: () => Promise<string>
	readonly startWorkflow?: (orgId: OrgId) => Promise<void>
}

const unimplemented = (method: string) =>
	Effect.die(new Error(`TinybirdSyncClient.${method} not implemented in test layer`))

const liftSync =
	<E extends TinybirdSyncRejectedError | TinybirdSyncUnavailableError, Args extends readonly unknown[], A>(
		method: string,
		fn: ((...args: Args) => Promise<A>) | undefined,
	) =>
	(...args: Args): Effect.Effect<A, E> => {
		if (!fn) return unimplemented(method) as Effect.Effect<A, E>
		return Effect.tryPromise({
			try: () => fn(...args),
			catch: (error) => {
				if (
					error instanceof TinybirdSyncRejectedError ||
					error instanceof TinybirdSyncUnavailableError
				) {
					return error as E
				}
				return new TinybirdSyncUnavailableError({
					message: error instanceof Error ? error.message : String(error),
					statusCode: null,
				}) as E
			},
		})
	}

export const makeTestTinybirdSyncClientLayer = (
	overrides: TinybirdSyncClientOverrides = {},
): Layer.Layer<TinybirdSyncClient> => {
	const shape: TinybirdSyncClientShape = {
		getDeploymentStatus: liftSync("getDeploymentStatus", overrides.getDeploymentStatus),
		cleanupOwnedDeployment: liftSync("cleanupOwnedDeployment", overrides.cleanupOwnedDeployment),
		fetchInstanceHealth: liftSync("fetchInstanceHealth", overrides.fetchInstanceHealth),
		getProjectRevision: () => {
			if (!overrides.getProjectRevision) return Effect.succeed("test-rev")
			return Effect.tryPromise({
				try: () => overrides.getProjectRevision!(),
				catch: (error) => error,
			}).pipe(Effect.orDie)
		},
		startWorkflow: (orgId: OrgId) => {
			if (!overrides.startWorkflow) return Effect.void
			return Effect.tryPromise({
				try: () => overrides.startWorkflow!(orgId),
				catch: (error) =>
					new TinybirdWorkflowKickoffError(
						error instanceof Error
							? `Failed to start Tinybird sync workflow: ${error.message}`
							: "Failed to start Tinybird sync workflow",
						error,
					),
			})
		},
	}

	return Layer.succeed(TinybirdSyncClient, shape)
}
