import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type {
	InvestigationFanoutWorkflowEnv,
	InvestigationFanoutWorkflowPayload,
	InvestigationFanoutWorkflowResult,
} from "./InvestigationFanoutWorkflow.run"

/**
 * Cloudflare Workflow that runs an investigation as a fan-out: N lens agents in
 * parallel, then one validator that promotes a single cause and records why each
 * rival lost.
 *
 * The class is a thin shell: the heavy logic (agent runtime, LLM stack, tool
 * registry) is DYNAMICALLY imported inside `run()`, so the worker's
 * module-evaluation stays under Cloudflare's ~1s startup-CPU budget — the
 * workflow class itself is statically exported from `worker.ts`.
 */
export class InvestigationFanoutWorkflow extends WorkflowEntrypoint<
	InvestigationFanoutWorkflowEnv,
	InvestigationFanoutWorkflowPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<InvestigationFanoutWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<InvestigationFanoutWorkflowResult> {
		const { runInvestigationFanout } = await import("./InvestigationFanoutWorkflow.run")
		return runInvestigationFanout(this.env, event, step)
	}
}
