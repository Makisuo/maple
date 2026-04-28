import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { DatabaseD1Live } from "../services/DatabaseD1Live"
import { Env } from "../services/Env"
import { SelfManagedCollectorConfigService } from "../services/SelfManagedCollectorConfigService"
import { WorkerEnvironment } from "../services/WorkerEnvironment"
import {
	runTinybirdSyncWorkflow,
	type TinybirdSyncWorkflowPayload,
	type TinybirdSyncWorkflowResult,
} from "./TinybirdSyncWorkflow.run"

export type { TinybirdSyncWorkflowPayload, TinybirdSyncWorkflowResult } from "./TinybirdSyncWorkflow.run"

const makePublishCollectorConfig = (env: Record<string, unknown>) => async () => {
	const program = SelfManagedCollectorConfigService.publishConfig().pipe(
		Effect.tap((result) =>
			Effect.logInfo("Self-managed collector config published").pipe(
				Effect.annotateLogs({
					orgCount: result.orgCount,
					published: result.published,
				}),
			),
		),
		Effect.asVoid,
	)

	const layer = SelfManagedCollectorConfigService.Default.pipe(
		Layer.provide(Env.Default),
		Layer.provide(DatabaseD1Live),
		Layer.provide(Layer.succeed(WorkerEnvironment, env)),
	)

	await Effect.runPromise(program.pipe(Effect.provide(layer)))
}

export class TinybirdSyncWorkflow extends WorkflowEntrypoint<
	Record<string, unknown>,
	TinybirdSyncWorkflowPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<TinybirdSyncWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<TinybirdSyncWorkflowResult> {
		return runTinybirdSyncWorkflow(this.env, event, step, {
			publishCollectorConfig: makePublishCollectorConfig(this.env),
		})
	}
}
