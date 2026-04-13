import {
  isWorkflowExport,
  task,
  sleep,
  sleepUntil,
  WorkflowEvent,
  WorkflowStep,
  type WorkflowExport,
  type WorkflowBody,
} from "@/Cloudflare/Workers/Workflow";
import { makeWorkflowBridge } from "@/Cloudflare/Workers/Rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// isWorkflowExport
// ---------------------------------------------------------------------------

describe("isWorkflowExport", () => {
  it.effect("detects valid WorkflowExport", () =>
    Effect.gen(function* () {
      const valid: WorkflowExport = {
        kind: "workflow",
        make: () => Effect.succeed(Effect.void as any),
      };
      expect(isWorkflowExport(valid)).toBe(true);
    }),
  );

  it.effect("rejects non-workflow values", () =>
    Effect.gen(function* () {
      expect(isWorkflowExport(null)).toBe(false);
      expect(isWorkflowExport(undefined)).toBe(false);
      expect(isWorkflowExport(42)).toBe(false);
      expect(isWorkflowExport("workflow")).toBe(false);
      expect(isWorkflowExport({})).toBe(false);
      expect(isWorkflowExport({ kind: "durableObject" })).toBe(false);
      expect(isWorkflowExport({ kind: "workflow" })).toBe(true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Helpers for bridge tests
// ---------------------------------------------------------------------------

class FakeEntrypoint {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
  async run(_event: any, _step: any): Promise<unknown> {
    return undefined;
  }
}

const fakeStep = () => ({
  do: async (_n: string, fn: () => Promise<unknown>) => fn(),
  sleep: async () => {},
  sleepUntil: async () => {},
});

const makeGetExport = (body: WorkflowBody) => async () => (_env: unknown) =>
  Effect.succeed(body);

// ---------------------------------------------------------------------------
// makeWorkflowBridge
// ---------------------------------------------------------------------------

describe("makeWorkflowBridge", () => {
  it.effect("delegates run() to the Effect body with services", () =>
    Effect.gen(function* () {
      const body: WorkflowBody = Effect.gen(function* () {
        const event = yield* WorkflowEvent;
        const result = yield* task(
          "greet",
          Effect.succeed(`Hello ${event.payload}`),
        );
        return result;
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});
      const result = yield* Effect.promise(() =>
        instance.run(
          { payload: "World", timestamp: new Date(), instanceId: "x" },
          fakeStep(),
        ),
      );
      expect(result).toBe("Hello World");
    }),
  );

  it.effect("wraps step.sleep correctly", () =>
    Effect.gen(function* () {
      let sleepCalledWith: [string, unknown] | undefined;

      const body: WorkflowBody = Effect.gen(function* () {
        yield* sleep("pause", "5 seconds");
        return "done";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});

      const step = {
        ...fakeStep(),
        sleep: async (name: string, duration: unknown) => {
          sleepCalledWith = [name, duration];
        },
      };

      const result = yield* Effect.promise(() =>
        instance.run(
          { payload: {}, timestamp: new Date(), instanceId: "x" },
          step,
        ),
      );

      expect(result).toBe("done");
      expect(sleepCalledWith).toEqual(["pause", "5 seconds"]);
    }),
  );

  it.effect("wraps step.sleepUntil correctly", () =>
    Effect.gen(function* () {
      let sleepUntilCalledWith: [string, unknown] | undefined;
      const target = new Date("2025-06-01T00:00:00Z");

      const body: WorkflowBody = Effect.gen(function* () {
        yield* sleepUntil("wait", target);
        return "done";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});

      const step = {
        ...fakeStep(),
        sleepUntil: async (name: string, ts: unknown) => {
          sleepUntilCalledWith = [name, ts];
        },
      };

      yield* Effect.promise(() =>
        instance.run(
          { payload: {}, timestamp: new Date(), instanceId: "x" },
          step,
        ),
      );

      expect(sleepUntilCalledWith?.[0]).toBe("wait");
      expect(sleepUntilCalledWith?.[1]).toBe(target.toISOString());
    }),
  );

  it.effect("provides WorkflowEvent with correct fields", () =>
    Effect.gen(function* () {
      let receivedPayload: unknown;
      let receivedTimestamp: Date | undefined;
      let receivedInstanceId: string | undefined;

      const body: WorkflowBody = Effect.gen(function* () {
        const event = yield* WorkflowEvent;
        receivedPayload = event.payload;
        receivedTimestamp = event.timestamp;
        receivedInstanceId = event.instanceId;
        return "ok";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});
      const ts = new Date("2025-01-01T00:00:00Z");

      yield* Effect.promise(() =>
        instance.run(
          { payload: { key: "value" }, timestamp: ts, instanceId: "abc-123" },
          fakeStep(),
        ),
      );

      expect(receivedPayload).toEqual({ key: "value" });
      expect(receivedTimestamp).toEqual(ts);
      expect(receivedInstanceId).toBe("abc-123");
    }),
  );

  it.effect("converts numeric timestamp to Date", () =>
    Effect.gen(function* () {
      let receivedTimestamp: Date | undefined;
      const tsNum = 1735689600000;

      const body: WorkflowBody = Effect.gen(function* () {
        const event = yield* WorkflowEvent;
        receivedTimestamp = event.timestamp;
        return "ok";
      });

      const BridgeClass = makeWorkflowBridge(
        FakeEntrypoint as any,
        makeGetExport(body),
      )("TestWorkflow");

      const instance = new BridgeClass({}, {});

      yield* Effect.promise(() =>
        instance.run(
          { payload: {}, timestamp: tsNum, instanceId: "" },
          fakeStep(),
        ),
      );

      expect(receivedTimestamp).toBeInstanceOf(Date);
      expect(receivedTimestamp!.getTime()).toBe(tsNum);
    }),
  );
});
