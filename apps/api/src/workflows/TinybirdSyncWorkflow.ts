import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import {
  runTinybirdSyncWorkflow,
  type TinybirdSyncWorkflowPayload,
  type TinybirdSyncWorkflowResult,
} from "./TinybirdSyncWorkflow.run"

export type { TinybirdSyncWorkflowPayload, TinybirdSyncWorkflowResult } from "./TinybirdSyncWorkflow.run"

export class TinybirdSyncWorkflow extends WorkflowEntrypoint<
  Record<string, unknown>,
  TinybirdSyncWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<TinybirdSyncWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<TinybirdSyncWorkflowResult> {
    return runTinybirdSyncWorkflow(this.env, event, step)
  }
}
