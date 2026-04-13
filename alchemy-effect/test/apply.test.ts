import { Cli } from "@/Cli/Cli";
import * as Construct from "@/Construct";
import { destroy } from "@/Destroy";
import * as Output from "@/Output";
import * as Stack from "@/Stack";
import {
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  State,
} from "@/State";
import { test } from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import { Data, Layer } from "effect";
import * as Effect from "effect/Effect";
import {
  ArtifactProbe,
  BindingTarget,
  DeletedBindingRegressionTarget,
  Function,
  InMemoryTestLayers,
  PhasedTarget,
  StaticStablesResource,
  TestLayers,
  TestResource,
  TestResourceHooks,
  type TestResourceProps,
} from "./test.resources.ts";

const testStack = "test";
const testStage = "test";

const getState = Effect.fn(function* <S = ResourceState>(resourceId: string) {
  const state = yield* State;
  return (yield* state.get({
    stack: testStack,
    stage: testStage,
    fqn: resourceId,
  })) as S;
});
const listState = Effect.fn(function* () {
  const state = yield* State;
  return yield* state.list({ stack: testStack, stage: testStage });
});

const expectConvergedStatus = (status: ResourceState["status"] | undefined) => {
  expect(["created", "updated"]).toContain(status);
};

const mockStack = Stack.Stack.of({
  name: testStack,
  stage: testStage,
  bindings: {},
  resources: {},
});

export class ResourceFailure extends Data.TaggedError("ResourceFailure")<{
  message: string;
}> {
  constructor() {
    super({ message: `Failed to create` });
  }
}

const MockLayers = () =>
  Layer.mergeAll(InMemoryTestLayers(), Layer.succeed(Stack.Stack, mockStack));

const hook =
  (hooks?: {
    create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
    read?: (id: string) => Effect.Effect<void, any>;
  }) =>
  <A, Err, Req>(test: Effect.Effect<A, Err, Req>) =>
    test.pipe(
      Effect.provide(
        Layer.succeed(
          TestResourceHooks,
          hooks ?? {
            create: () => Effect.fail(new ResourceFailure()),
            update: () => Effect.fail(new ResourceFailure()),
            delete: () => Effect.fail(new ResourceFailure()),
            read: () => Effect.succeed(undefined),
          },
        ),
      ),
      // @ts-expect-error - catchTag changes the return type
      Effect.catchTag("ResourceFailure", () => Effect.succeed(true)),
    ) as Effect.Effect<A, Err, Req | State>;

// Helper to fail on specific resource IDs
const failOn = (
  resourceId: string,
  hook: "create" | "update" | "delete",
): {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
} => ({
  [hook]: (id: string) =>
    id === resourceId
      ? Effect.fail(new ResourceFailure())
      : Effect.succeed(undefined),
});

// Helper to fail on multiple resource IDs for different hooks
const failOnMultiple = (
  failures: Array<{ id: string; hook: "create" | "update" | "delete" }>,
): {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
} => {
  const createFailures = failures
    .filter((f) => f.hook === "create")
    .map((f) => f.id);
  const updateFailures = failures
    .filter((f) => f.hook === "update")
    .map((f) => f.id);
  const deleteFailures = failures
    .filter((f) => f.hook === "delete")
    .map((f) => f.id);

  return {
    create: (id: string) =>
      createFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    update: (id: string) =>
      updateFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    delete: (id: string) =>
      deleteFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
  };
};

describe("basic operations", () => {
  test(
    "should create, update, and delete resources",
    Effect.gen(function* () {
      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
          });
          return A.string;
        }).pipe(test.deploy),
      ).toEqual("test-string");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-new",
          });
          return A.string;
        }).pipe(test.deploy),
      ).toEqual("test-string-new");

      yield* destroy();

      expect(yield* getState("A")).toBeUndefined();
      expect(yield* listState()).toEqual([]);
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "should resolve output properties",
    Effect.gen(function* () {
      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string,
          });
          return B.string;
        }).pipe(test.deploy),
      ).toEqual("test-string");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string.pipe(Output.map((string) => string.toUpperCase())),
          });
          return B.string;
        }).pipe(test.deploy),
      ).toEqual("TEST-STRING");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string.pipe(
              Output.map((string) => string.toUpperCase() + "-NEW"),
            ),
          });
          return B.string;
        }).pipe(test.deploy),
      ).toEqual("TEST-STRING-NEW");
    }).pipe(Effect.provide(TestLayers())),
  );

  test(
    "should resolve bindings inside constructs using namespaced resources",
    Effect.gen(function* () {
      const Site = Construct.fn(function* (_id: string, _props: {}) {
        const bucket = yield* BindingTarget("Bucket", {
          string: "bucket-value",
        });
        const distribution = yield* BindingTarget("Distribution", {
          string: "distribution-value",
        });

        yield* bucket.bind("Policy", {
          env: {
            BUCKET: bucket.string,
            DISTRIBUTION: distribution.string,
          },
        });

        return {
          bucket,
          distribution,
        };
      });

      const output = yield* Site("MarketingSite", {}).pipe(test.deploy);

      expect(output.bucket.env).toEqual({
        BUCKET: "bucket-value",
        DISTRIBUTION: "distribution-value",
      });
      expectConvergedStatus((yield* getState("MarketingSite/Bucket"))?.status);
      expect((yield* getState("MarketingSite/Distribution"))?.status).toEqual(
        "created",
      );
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "should exclude deleted bindings before provider updates",
    Effect.gen(function* () {
      const created = yield* test.deploy(
        Effect.gen(function* () {
          const target = yield* DeletedBindingRegressionTarget("A", {
            name: "target",
          });
          yield* target.bind("TestBinding", {
            env: {
              FEATURE_FLAG: "on",
            },
          });
          return target;
        }),
      );

      expect(created.env).toEqual({
        FEATURE_FLAG: "on",
      });

      const updated = yield* test.deploy(
        Effect.gen(function* () {
          return yield* DeletedBindingRegressionTarget("A", {
            name: "target",
          });
        }),
      );

      expect(updated.env).toEqual({});
      expect(yield* getState("A")).toMatchObject({
        bindings: [],
        attr: {
          env: {},
        },
      });
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "should update a surviving consumer before deleting a removed dependency",
    Effect.gen(function* () {
      const created = yield* test.deploy(
        Effect.gen(function* () {
          const secret = yield* TestResource("Secret", {
            string: "secret-value",
          });
          const worker = yield* Function("Worker", {
            name: "worker",
            env: {
              SECRET: secret.string,
            },
          });
          return { secret, worker };
        }),
      );

      expect(created.worker.env).toEqual({
        SECRET: "secret-value",
      });
      expect((yield* getState("Secret"))?.status).toEqual("created");
      expect((yield* getState("Worker"))?.status).toEqual("created");

      const updated = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Function("Worker", {
            name: "worker",
          });
        }),
      );

      expect(updated.env).toEqual({});
      expect(yield* getState("Secret")).toBeUndefined();
      expect((yield* getState("Worker"))?.status).toEqual("updated");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "should create a resource with a binding that references its own output",
    {
      timeout: 10_000,
    },
    Effect.gen(function* () {
      const created = yield* test.deploy(
        Effect.gen(function* () {
          const target = yield* DeletedBindingRegressionTarget("A", {
            name: "target",
          });
          yield* target.bind("SelfBinding", {
            env: {
              SELF_NAME: target.name,
            },
          });
          return target;
        }),
      );

      expect(created.env).toEqual({
        SELF_NAME: "target",
      });
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("circularity via bindings", () => {
  const selfBoundStack = (props: {
    string: string;
    replaceString?: string;
    includeD?: boolean;
  }) =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", {
        name: "a",
        string: props.string,
        replaceString: props.replaceString,
      });
      yield* A.bind("SelfBinding", {
        env: {
          SELF: A.string,
        },
      });
      const B = yield* TestResource("B", { string: A.string });
      if (props.includeD) {
        const D = yield* TestResource("D", { string: B.string });
        return { A, B, D };
      }
      return { A, B };
    });

  const mutualBindingStack = (props: {
    aString: string;
    aReplaceString?: string;
    bString?: string;
    includeD?: boolean;
  }) =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", {
        name: "a",
        string: props.aString,
        replaceString: props.aReplaceString,
      });
      const B = yield* BindingTarget("B", {
        name: "b",
        string: props.bString ?? "b-value",
      });
      yield* A.bind("FromB", {
        env: {
          PEER: B.string,
        },
      });
      yield* B.bind("FromA", {
        env: {
          PEER: A.string,
        },
      });
      if (props.includeD) {
        const D = yield* TestResource("D", {
          string: Output.interpolate`${A.string}-${B.string}`,
        });
        return { A, B, D };
      }
      return { A, B };
    });

  const propAndBindingCycleStack = () =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", {
        name: "a",
        string: "a-value",
      });
      const B = yield* TestResource("B", {
        string: A.string,
      });
      yield* A.bind("FromB", {
        env: {
          PEER: B.string,
        },
      });
      return { A, B };
    });

  test(
    "create succeeds when props use precreate output and bindings use downstream output",
    {
      timeout: 10_000,
    },
    Effect.gen(function* () {
      const output = yield* test.deploy(propAndBindingCycleStack());

      expect(output.A.env).toEqual({ PEER: "a-value" });
      expect(output.B.string).toEqual("a-value");
      expectConvergedStatus((yield* getState("A"))?.status);
      expectConvergedStatus((yield* getState("B"))?.status);
    }).pipe(Effect.provide(MockLayers())),
  );

  describe("self-referential bindings", () => {
    test(
      "create succeeds with self binding",
      Effect.gen(function* () {
        const output = yield* test.deploy(
          selfBoundStack({
            string: "a-value",
            replaceString: "original",
          }),
        );

        expect(output.A.env).toEqual({ SELF: "a-value" });
        expect(output.B.string).toEqual("a-value");
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replacing state noop replay recovers and creates downstream resources",
      Effect.gen(function* () {
        yield* selfBoundStack({
          string: "a-value",
          replaceString: "original",
        }).pipe(test.deploy);

        const stack = selfBoundStack({
          string: "a-value-replaced",
          replaceString: "changed",
          includeD: true,
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        expectConvergedStatus((yield* getState("B"))?.status);
        expect(yield* getState("D")).toBeUndefined();

        const output = yield* stack.pipe(test.deploy);
        expectConvergedStatus((yield* getState("A"))?.status);
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.A.env).toEqual({ SELF: "a-value-replaced" });
        expect(output.D!.string).toEqual("a-value-replaced");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replacing state update replay updates replacement and creates downstream resources",
      Effect.gen(function* () {
        yield* selfBoundStack({
          string: "a-value",
          replaceString: "original",
        }).pipe(test.deploy);

        yield* selfBoundStack({
          string: "a-value-replaced",
          replaceString: "changed",
          includeD: true,
        }).pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        expectConvergedStatus((yield* getState("B"))?.status);
        expect(yield* getState("D")).toBeUndefined();

        const output = yield* selfBoundStack({
          string: "a-value-updated-during-recovery",
          replaceString: "changed",
          includeD: true,
        }).pipe(test.deploy);

        expectConvergedStatus((yield* getState("A"))?.status);
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.A.env).toEqual({
          SELF: "a-value-updated-during-recovery",
        });
        expect(output.D!.string).toEqual("a-value-updated-during-recovery");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replaced state noop replay finishes cleanup and creates downstream resources",
      Effect.gen(function* () {
        yield* selfBoundStack({
          string: "a-value",
          replaceString: "original",
        }).pipe(test.deploy);

        const stack = selfBoundStack({
          string: "a-value-replaced",
          replaceString: "changed",
          includeD: true,
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updating");
        expect(yield* getState("D")).toBeUndefined();

        const output = yield* stack.pipe(test.deploy);
        expectConvergedStatus((yield* getState("A"))?.status);
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.A.env).toEqual({ SELF: "a-value-replaced" });
        expect(output.D!.string).toEqual("a-value-replaced");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replaced state update replay updates replacement and downstream resources",
      Effect.gen(function* () {
        yield* selfBoundStack({
          string: "a-value",
          replaceString: "original",
        }).pipe(test.deploy);

        yield* selfBoundStack({
          string: "a-value-replaced",
          replaceString: "changed",
          includeD: true,
        }).pipe(test.deploy, hook(failOn("B", "update")));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updating");
        expect(yield* getState("D")).toBeUndefined();

        const output = yield* selfBoundStack({
          string: "a-value-updated-after-replace",
          replaceString: "changed",
          includeD: true,
        }).pipe(test.deploy);

        expectConvergedStatus((yield* getState("A"))?.status);
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.A.env).toEqual({
          SELF: "a-value-updated-after-replace",
        });
        expect(output.D!.string).toEqual("a-value-updated-after-replace");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("mutual A <-> B bindings", () => {
    test(
      "create succeeds with mutual bindings",
      Effect.gen(function* () {
        const output = yield* test.deploy(
          mutualBindingStack({
            aString: "a-value",
          }),
        );

        expect(output.A.env).toEqual({ PEER: "b-value" });
        expect(output.B.env).toEqual({ PEER: "a-value" });
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "destroy succeeds with mutual bindings",
      Effect.gen(function* () {
        yield* mutualBindingStack({
          aString: "a-value",
        }).pipe(test.deploy);

        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    describe("from replacing state", () => {
      test(
        "replacing noop recovery creates downstream resources",
        Effect.gen(function* () {
          yield* mutualBindingStack({
            aString: "a-value",
            aReplaceString: "original",
          }).pipe(test.deploy);

          const stack = mutualBindingStack({
            aString: "a-value-replaced",
            aReplaceString: "changed",
            includeD: true,
          });

          yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

          expect(
            (yield* getState<ReplacingResourceState>("A"))?.status,
          ).toEqual("replacing");
          expectConvergedStatus((yield* getState("B"))?.status);
          expect(yield* getState("D")).toBeUndefined();

          const output = yield* stack.pipe(test.deploy);
          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.A.env).toEqual({ PEER: "b-value" });
          expect(output.B.env).toEqual({ PEER: "a-value-replaced" });
          expect(output.D!.string).toEqual("a-value-replaced-b-value");
        }).pipe(Effect.provide(MockLayers())),
      );

      test(
        "replacing update recovery creates downstream resources",
        Effect.gen(function* () {
          yield* mutualBindingStack({
            aString: "a-value",
            aReplaceString: "original",
          }).pipe(test.deploy);

          yield* mutualBindingStack({
            aString: "a-value-replaced",
            aReplaceString: "changed",
            includeD: true,
          }).pipe(test.deploy, hook(failOn("A", "create")));

          expect(
            (yield* getState<ReplacingResourceState>("A"))?.status,
          ).toEqual("replacing");
          expectConvergedStatus((yield* getState("B"))?.status);
          expect(yield* getState("D")).toBeUndefined();

          const output = yield* mutualBindingStack({
            aString: "a-value-updated-during-recovery",
            aReplaceString: "changed",
            includeD: true,
          }).pipe(test.deploy);

          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.A.env).toEqual({ PEER: "b-value" });
          expect(output.B.env).toEqual({
            PEER: "a-value-updated-during-recovery",
          });
          expect(output.D!.string).toEqual(
            "a-value-updated-during-recovery-b-value",
          );
        }).pipe(Effect.provide(MockLayers())),
      );

      test(
        "replacing replace recovery nests another replacement",
        Effect.gen(function* () {
          yield* mutualBindingStack({
            aString: "a-value",
            aReplaceString: "original",
          }).pipe(test.deploy);

          yield* mutualBindingStack({
            aString: "a-value-replaced",
            aReplaceString: "changed",
            includeD: true,
          }).pipe(test.deploy, hook(failOn("A", "create")));

          const output = yield* mutualBindingStack({
            aString: "a-value-another-replacement",
            aReplaceString: "another-change",
            includeD: true,
          }).pipe(test.deploy);

          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.B.env).toEqual({ PEER: "a-value-another-replacement" });
        }).pipe(Effect.provide(MockLayers())),
      );
    });

    describe("from replaced state", () => {
      test(
        "replaced noop recovery updates downstream then creates downstream resources",
        Effect.gen(function* () {
          yield* mutualBindingStack({
            aString: "a-value",
            aReplaceString: "original",
          }).pipe(test.deploy);

          const stack = mutualBindingStack({
            aString: "a-value-replaced",
            aReplaceString: "changed",
            includeD: true,
          });

          yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updating");
          expect(yield* getState("D")).toBeUndefined();

          const output = yield* stack.pipe(test.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.A.env).toEqual({ PEER: "b-value" });
          expect(output.B.env).toEqual({ PEER: "a-value-replaced" });
          expect(output.D!.string).toEqual("a-value-replaced-b-value");
        }).pipe(Effect.provide(MockLayers())),
      );

      test(
        "replaced with update recovery updates replacement and downstream resources",
        Effect.gen(function* () {
          yield* mutualBindingStack({
            aString: "a-value",
            aReplaceString: "original",
          }).pipe(test.deploy);

          yield* mutualBindingStack({
            aString: "a-value-replaced",
            aReplaceString: "changed",
            includeD: true,
          }).pipe(test.deploy, hook(failOn("B", "update")));

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updating");
          expect(yield* getState("D")).toBeUndefined();

          const output = yield* mutualBindingStack({
            aString: "a-value-updated-after-replace",
            aReplaceString: "changed",
            includeD: true,
          }).pipe(test.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.A.env).toEqual({ PEER: "b-value" });
          expect(output.B.env).toEqual({
            PEER: "a-value-updated-after-replace",
          });
          expect(output.D!.string).toEqual(
            "a-value-updated-after-replace-b-value",
          );
        }).pipe(Effect.provide(MockLayers())),
      );

      test(
        "replaced replace recovery nests another replacement",
        Effect.gen(function* () {
          yield* mutualBindingStack({
            aString: "a-value",
            aReplaceString: "original",
          }).pipe(test.deploy);

          yield* mutualBindingStack({
            aString: "a-value-replaced",
            aReplaceString: "changed",
            includeD: true,
          }).pipe(test.deploy, hook(failOn("B", "update")));

          const output = yield* mutualBindingStack({
            aString: "a-value-another-replacement",
            aReplaceString: "another-change",
            includeD: true,
          }).pipe(test.deploy);

          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.B.env).toEqual({ PEER: "a-value-another-replacement" });
        }).pipe(Effect.provide(MockLayers())),
      );
    });
  });
});

describe("prop-flow convergence", () => {
  const phasedCycleStack = (props: {
    desired: string;
    replaceKey?: string;
    use: "stableId" | "value";
    includeC?: boolean;
  }) =>
    Effect.gen(function* () {
      const A = yield* PhasedTarget("A", {
        desired: props.desired,
        replaceKey: props.replaceKey,
      });
      const selected = props.use === "stableId" ? A.stableId : A.value;
      const B = yield* TestResource("B", {
        string: selected,
      });
      yield* A.bind("FromB", {
        env: {
          B: B.string,
        },
      });

      if (props.includeC) {
        const C = yield* TestResource("C", {
          string: B.string,
        });
        return { A, B, C };
      }

      return { A, B };
    });

  test(
    "fresh circular create may use a stable precreate identifier",
    Effect.gen(function* () {
      const output = yield* phasedCycleStack({
        desired: "final-a",
        replaceKey: "v1",
        use: "stableId",
      }).pipe(test.deploy);

      expect(output.A.value).toEqual("final-a");
      expect(output.B.string).toEqual("stable:v1");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "fresh circular create should converge downstream props to final values",
    Effect.gen(function* () {
      const output = yield* phasedCycleStack({
        desired: "final-a",
        replaceKey: "v1",
        use: "value",
      }).pipe(test.deploy);

      expect(output.A.value).toEqual("final-a");
      expect(output.B.string).toEqual("final-a");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "fresh replacement should converge newly created downstream props to replacement values",
    Effect.gen(function* () {
      yield* phasedCycleStack({
        desired: "old-a",
        replaceKey: "v1",
        use: "value",
      }).pipe(test.deploy);

      const output = yield* phasedCycleStack({
        desired: "new-a",
        replaceKey: "v2",
        use: "value",
      }).pipe(test.deploy);

      expect(output.A.value).toEqual("new-a");
      expect(output.B.string).toEqual("new-a");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "stale precreate values should not propagate transitively",
    Effect.gen(function* () {
      const output = yield* phasedCycleStack({
        desired: "final-a",
        replaceKey: "v1",
        use: "value",
        includeC: true,
      }).pipe(test.deploy);

      expect(output.A.value).toEqual("final-a");
      expect(output.B.string).toEqual("final-a");
      expect(output.C!.string).toEqual("final-a");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "binding feedback converges across an A -> B -> A fixed point",
    Effect.gen(function* () {
      const output = yield* Effect.gen(function* () {
        const A = yield* PhasedTarget("A", {
          desired: "final-a",
          replaceKey: "v1",
        });
        const B = yield* TestResource("B", {
          string: A.value,
        });
        yield* A.bind("FromB", {
          env: {
            B: B.string,
          },
        });
        return { A, B };
      }).pipe(test.deploy);

      expect(output.A.value).toEqual("final-a");
      expect(output.B.string).toEqual("final-a");
      expect(output.A.env).toEqual({
        B: "final-a",
      });
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "terminal created or updated status is delayed until fixed-point convergence finishes",
    Effect.gen(function* () {
      const events: Array<{ id: string; status: string }> = [];
      const cli = Cli.of({
        approvePlan: () => Effect.succeed(true),
        displayPlan: () => Effect.void,
        startApplySession: () =>
          Effect.succeed({
            done: () => Effect.void,
            emit: (event) =>
              Effect.sync(() => {
                if (event.kind === "status-change") {
                  events.push({
                    id: event.id,
                    status: event.status,
                  });
                }
              }),
          }),
      });

      const output = yield* Effect.gen(function* () {
        const A = yield* PhasedTarget("A", {
          desired: "final-a",
          replaceKey: "v1",
        });
        const B = yield* TestResource("B", {
          string: A.value,
        });
        yield* A.bind("FromB", {
          env: {
            B: B.string,
          },
        });
        return { A, B };
      }).pipe(test.deploy, Effect.provide(Layer.succeed(Cli, cli)));

      expect(output.A.env).toEqual({
        B: "final-a",
      });

      const statusesById = events.reduce(
        (acc, event: { id: string; status: string }) => {
          (acc[event.id] ??= []).push(event);
          return acc;
        },
        {} as Record<string, Array<{ id: string; status: string }>>,
      );
      const terminal = (id: string) =>
        (statusesById[id] ?? [])
          .map((event: { id: string; status: string }) => event.status)
          .filter(
            (status: string) => status === "created" || status === "updated",
          );

      expect(terminal("A")).toEqual(["updated"]);
      expect(terminal("B")).toEqual(["updated"]);
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from created state", () => {
  test(
    "noop when props unchanged",
    Effect.gen(function* () {
      const stack = Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string",
        });
        return A.string;
      });

      let output = yield* test.deploy(stack);
      expect(output).toEqual("test-string");

      expect((yield* getState("A"))?.status).toEqual("created");
      output = yield* test.deploy(stack);

      // Re-apply with same props - should be noop
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("test-string");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      yield* test.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "original",
          });
          return A.replaceString;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");

      // Change props that trigger replacement

      const output = yield* test.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "new",
          });
          return A.replaceString;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from updated state", () => {
  test(
    "noop when props unchanged",
    Effect.gen(function* () {
      yield* test.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");

      // Update to get to updated state
      yield* test.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string-changed",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updated");

      // Re-apply with same props - should be noop
      const output = yield* test.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-changed",
          });
          return A.string;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(output).toEqual("test-string-changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      yield* test.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
            replaceString: "original",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");

      // Update to get to updated state
      yield* test.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string-changed",
            replaceString: "original",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updated");

      // Change props that trigger replacement
      const output = yield* test.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-changed",
            replaceString: "new",
          });
          return A.replaceString;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from creating state", () => {
  test(
    "continue creating when props unchanged",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string",
        });
        return A.string;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("test-string");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue creating when props have updatable changes",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string-changed",
        });
        return A.string;
      }).pipe(test.deploy);
      expect(output).toEqual("test-string-changed");
      expect((yield* getState("A"))?.status).toEqual("created");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string",
        });
      }).pipe(test.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "test-string-changed",
        });
        return A.replaceString;
      }).pipe(test.deploy);
      expect(output).toEqual("test-string-changed");
      expect((yield* getState("A"))?.status).toEqual("created");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "destroy should handle creating state with no attributes",
    Effect.gen(function* () {
      // 1. Create a resource but fail - this leaves state in "creating" with no attr
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");
      expect((yield* getState("A"))?.attr).toBeUndefined();

      // 2. Call destroy - this triggers collectGarbage which tries to delete
      // the orphaned resource. The bug is that output is undefined in the
      // delete call when the resource never completed creation.
      yield* destroy();

      // Resource should be cleaned up
      expect(yield* getState("A")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "destroy should handle creating state when attributes can be recovered",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");
      expect((yield* getState("A"))?.attr).toBeUndefined();

      yield* destroy().pipe(
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
          read: () =>
            Effect.succeed({
              string: "test-string",
            }),
        }),
      );

      // Resource should be cleaned up
      expect((yield* getState("A"))?.status).toEqual("deleting");

      // actually delete this time
      yield* destroy().pipe(
        hook({
          read: () =>
            Effect.succeed({
              string: "test-string",
            }),
        }),
      );

      expect(yield* getState("A")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "destroy should handle replacing state when old resource has no attributes",
    Effect.gen(function* () {
      // 1. Create a resource but fail - this leaves state in "creating" with no attr
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(test.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");
      expect((yield* getState("A"))?.attr).toBeUndefined();

      // 2. Trigger replacement but also fail during create - this leaves state in "replacing"
      // with old.attr being undefined
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
        });
      }).pipe(test.deploy, hook());
      const state = yield* getState<ReplacingResourceState>("A");
      expect(state?.status).toEqual("replacing");
      expect(state?.old?.attr).toBeUndefined();

      // 3. Call destroy - this triggers collectGarbage which tries to delete
      // the resource. The bug is that old.attr is undefined.
      yield* destroy().pipe(
        hook({
          read: () =>
            Effect.succeed({
              replaceString: "original",
            }),
        }),
      );

      // Resource should be cleaned up
      expect(yield* getState("A")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from updating state", () => {
  test(
    "continue updating when props unchanged",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string-changed",
        });
      }).pipe(
        test.deploy,
        hook({
          update: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string-changed",
        });
        return A.string;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(output).toEqual("test-string-changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue updating when props have updatable changes",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string-changed",
        });
      }).pipe(
        test.deploy,
        hook({
          update: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string-changed-again",
        });
        return A.string;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(output).toEqual("test-string-changed-again");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
          replaceString: "original",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string-changed",
          replaceString: "original",
        });
      }).pipe(
        test.deploy,
        hook({
          update: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string-changed",
          replaceString: "changed",
        });
        return A.replaceString;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("changed");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from replacing state", () => {
  test(
    "continue replacement when props unchanged",
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Trigger replacement but fail during create of replacement
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
        });
      }).pipe(
        test.deploy,
        hook({
          create: () => Effect.fail(new ResourceFailure()),
        }),
      );
      const state = yield* getState<ReplacingResourceState>("A");
      expect(state?.status).toEqual("replacing");
      expect(state?.old?.status).toEqual("created");

      // 3. Re-apply with same props - should continue replacement
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "new",
        });
        return A.replaceString;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue replacement when props have updatable changes",
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
          string: "initial",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Trigger replacement but fail during create
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
          string: "initial",
        });
      }).pipe(
        test.deploy,
        hook({
          create: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("replacing");

      // 3. Re-apply with changed props (updatable) - should continue replacement with new props
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "new",
          string: "changed",
        });
        return { replaceString: A.replaceString, string: A.string };
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output.replaceString).toEqual("new");
      expect(output.string).toEqual("changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue replacement when props trigger another replacement",
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Trigger replacement but fail during create
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
        });
      }).pipe(
        test.deploy,
        hook({
          create: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("replacing");

      // 3. Replace again with another replacement - should converge
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "another-replacement",
        });
        return A.replaceString;
      }).pipe(test.deploy);
      expectConvergedStatus((yield* getState("A"))?.status);
      expect(output).toEqual("another-replacement");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from replaced state", () => {
  test(
    "continue cleanup when props unchanged",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string-changed",
        });
      }).pipe(
        test.deploy,
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      const AState = yield* getState<ReplacedResourceState>("A");
      expect(AState?.status).toEqual("replaced");
      expect(AState?.old).toMatchObject({
        status: "created",
        props: {
          replaceString: "test-string",
        },
      });

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string-changed",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "update replacement then cleanup when props have updatable changes",
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
          string: "initial",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Trigger replacement and fail during delete of old resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
          string: "initial",
        });
      }).pipe(
        test.deploy,
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      const state = yield* getState<ReplacedResourceState>("A");
      expect(state?.status).toEqual("replaced");
      expect(state?.old?.status).toEqual("created");

      // 3. Change props again (updatable change) - should update the replacement then cleanup
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "new",
          string: "changed",
        });
        return { replaceString: A.replaceString, string: A.string };
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output.replaceString).toEqual("new");
      expect(output.string).toEqual("changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue cleanup when props trigger another replacement",
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Trigger replacement and fail during delete of old resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
        });
      }).pipe(
        test.deploy,
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("replaced");

      // 3. Replace again and continue cleanup of the older generations
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "another-replacement",
        });
        return A.replaceString;
      }).pipe(test.deploy);
      expectConvergedStatus((yield* getState("A"))?.status);
      expect(output).toEqual("another-replacement");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from deleting state", () => {
  test(
    "create when props unchanged or have updatable changes",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* destroy().pipe(
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("deleting");

      // Now re-apply with the same props - should create the resource again
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string",
        });
        return A.string;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("test-string");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "create when props trigger replacement",
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Try to delete but fail
      yield* destroy().pipe(
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("deleting");

      // 3. Re-apply with props that trigger replacement - should recreate
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "new",
        });
        return A.replaceString;
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// DEPENDENT RESOURCES (A -> B where B depends on A.string)
// =============================================================================

describe("dependent resources (A -> B)", () => {
  describe("happy path", () => {
    test(
      "create A then B where B uses A.string",
      Effect.gen(function* () {
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.string).toEqual("a-value");
        expect(output.B.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "update A propagates to B",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Update A's string - B should update with the new value
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-updated");
        expect(output.B.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replace A, B updates to new A's output",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Replace A - B should update to point to new A's output
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-new");
        expect(output.B.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "delete both resources (B deleted first, then A)",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("failures during expandAndPivot", () => {
    test(
      "A create fails, B never starts - recovery creates both",
      Effect.gen(function* () {
        // A fails to create - B should never start
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect(yield* getState("B")).toBeUndefined();

        // Recovery: re-apply should create both
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.string).toEqual("a-value");
        expect(output.B.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B create fails - recovery creates B",
      Effect.gen(function* () {
        // A succeeds, B fails to create
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy, hook(failOn("B", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");

        // Recovery: re-apply should noop A and create B
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.B.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A update fails - recovery updates both",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A fails to update - B should not start updating
        yield* stack.pipe(test.deploy, hook(failOn("A", "update")));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Recovery: re-apply should update both
        const output = yield* stack.pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-updated");
        expect(output.B.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A updates, B update fails - recovery updates B",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A succeeds, B fails to update
        yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");

        // Recovery: re-apply should noop A and update B
        const output = yield* stack.pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.B.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replacement fails - recovery replaces A and updates B",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A replacement fails (during create of new A) - B should not start
        yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        expect((yield* getState("B"))?.status).toEqual("created");

        // Recovery: re-apply should complete A replacement and update B
        const output = yield* stack.pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-new");
        expect(output.B.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B update fails - recovery updates B then cleans up",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A replacement succeeds, B fails to update
        yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

        // A should be in replaced state (new A created, old A pending cleanup)
        // B should be in updating state
        const aState = yield* getState<ReplacedResourceState>("A");
        expect(aState?.status).toEqual("replaced");
        expect((yield* getState("B"))?.status).toEqual("updating");

        // Recovery: re-apply should update B and clean up old A
        const output = yield* stack.pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.B.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("failures during collectGarbage", () => {
    test(
      "A replaced, B updated, old A delete fails - recovery cleans up",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A replacement and B update succeed, but old A delete fails
        yield* stack.pipe(test.deploy, hook(failOn("A", "delete")));

        // A should be in replaced state (delete of old A failed)
        // B should have been updated successfully
        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updated");

        // Recovery: re-apply should clean up old A
        const output = yield* stack.pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "orphan B delete fails - recovery deletes B then A",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Orphan deletion: B delete fails
        yield* destroy().pipe(hook(failOn("B", "delete")));

        // B should be in deleting state, A should still be created (waiting for B)
        expect((yield* getState("B"))?.status).toEqual("deleting");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery: re-apply destroy should delete B then A
        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "orphan A delete fails after B deleted - recovery deletes A",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Orphan deletion: B succeeds, A fails
        yield* destroy().pipe(hook(failOn("A", "delete")));

        // B should be deleted, A should be in deleting state
        expect(yield* getState("B")).toBeUndefined();
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // Recovery: re-apply destroy should delete A
        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// THREE-LEVEL DEPENDENCY CHAIN (A -> B -> C where C depends on B, B depends on A)
// =============================================================================

describe("three-level dependency chain (A -> B -> C)", () => {
  describe("happy path", () => {
    test(
      "create A then B then C",
      Effect.gen(function* () {
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(output.A.string).toEqual("a-value");
        expect(output.B.string).toEqual("a-value");
        expect(output.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "update A propagates through B to C",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replace A propagates through B to C",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "delete all three (C first, then B, then A)",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("creation failures", () => {
    test(
      "A create fails - B and C never start",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(output.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B create fails - C never starts",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");
        expect(yield* getState("C")).toBeUndefined();

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(output.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A and B create, C create fails",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("C", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("creating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(output.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("update failures", () => {
    test(
      "A update fails - B and C remain stable",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "update")));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A updates, B update fails - C remains stable",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A and B update, C update fails",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("C", "update")));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("replace cascade failures", () => {
    test(
      "A replace fails - B and C remain stable",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B update fails - C remains stable",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updating");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B updated, C update fails",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("C", "update")));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B and C updated, old A delete fails - recovery cleans up",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "delete")));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("delete order failures", () => {
    test(
      "C delete fails - A and B waiting",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        yield* destroy().pipe(hook(failOn("C", "delete")));

        expect((yield* getState("C"))?.status).toEqual("deleting");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "C deleted, B delete fails - A waiting",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        yield* destroy().pipe(hook(failOn("B", "delete")));

        expect(yield* getState("C")).toBeUndefined();
        expect((yield* getState("B"))?.status).toEqual("deleting");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "C and B deleted, A delete fails",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(test.deploy);

        yield* destroy().pipe(hook(failOn("A", "delete")));

        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// DIAMOND DEPENDENCIES (D depends on B and C, both depend on A)
//     A
//    / \
//   B   C
//    \ /
//     D
// =============================================================================

describe("diamond dependencies (A -> B,C -> D)", () => {
  describe("happy path", () => {
    test(
      "create all four resources",
      Effect.gen(function* () {
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "update A propagates to B, C, and D",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(output.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "add D while B replaces and C noops",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", {
            string: Output.interpolate`${A.string}-b`,
            replaceString: "b-original",
          });
          yield* TestResource("C", {
            string: Output.interpolate`${A.string}-c`,
            replaceString: "c-original",
          });
        }).pipe(test.deploy);

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", {
            string: Output.interpolate`${A.string}-b-replaced`,
            replaceString: "b-changed",
          });
          const C = yield* TestResource("C", {
            string: Output.interpolate`${A.string}-c`,
            replaceString: "c-original",
          });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.B.replaceString).toEqual("b-changed");
        expect(output.C.replaceString).toEqual("c-original");
        expect(output.D.string).toEqual("a-value-b-replaced-a-value-c");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "add D while C replaces and B noops",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", {
            string: Output.interpolate`${A.string}-b`,
            replaceString: "b-original",
          });
          yield* TestResource("C", {
            string: Output.interpolate`${A.string}-c`,
            replaceString: "c-original",
          });
        }).pipe(test.deploy);

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", {
            string: Output.interpolate`${A.string}-b`,
            replaceString: "b-original",
          });
          const C = yield* TestResource("C", {
            string: Output.interpolate`${A.string}-c-replaced`,
            replaceString: "c-changed",
          });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.B.replaceString).toEqual("b-original");
        expect(output.C.replaceString).toEqual("c-changed");
        expect(output.D.string).toEqual("a-value-b-a-value-c-replaced");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "add D while both B and C replace",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", {
            string: Output.interpolate`${A.string}-b`,
            replaceString: "b-original",
          });
          yield* TestResource("C", {
            string: Output.interpolate`${A.string}-c`,
            replaceString: "c-original",
          });
        }).pipe(test.deploy);

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", {
            string: Output.interpolate`${A.string}-b-replaced`,
            replaceString: "b-changed",
          });
          const C = yield* TestResource("C", {
            string: Output.interpolate`${A.string}-c-replaced`,
            replaceString: "c-changed",
          });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        }).pipe(test.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.B.replaceString).toEqual("b-changed");
        expect(output.C.replaceString).toEqual("c-changed");
        expect(output.D.string).toEqual(
          "a-value-b-replaced-a-value-c-replaced",
        );
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "delete all (D first, then B and C, then A)",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("D")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("creation failures", () => {
    test(
      "A create fails - B, C, D never start",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B create fails - C may create, D stuck",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");
        // C might have been created since it doesn't depend on B
        const cState = yield* getState("C");
        expect(cState === undefined || cState?.status === "created").toBe(true);
        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, C create fails - B may create, D stuck",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("C", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("creating");
        // B might have been created since it doesn't depend on C
        const bState = yield* getState("B");
        expect(bState === undefined || bState?.status === "created").toBe(true);
        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A, B, C create - D create fails",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("D", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("creating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "both B and C fail to create - D stuck",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(
          test.deploy,
          hook(
            failOnMultiple([
              { id: "B", hook: "create" },
              { id: "C", hook: "create" },
            ]),
          ),
        );

        expect((yield* getState("A"))?.status).toEqual("created");
        // effect terminates eagerly, so it's possible that B or C to run first and block C from running
        const BState = yield* getState("B");
        const CState = yield* getState("C");
        expect(BState?.status).toBeOneOf(["creating", undefined]);
        expect(CState?.status).toBeOneOf(["creating", undefined]);
        // at leasst one of B or C should have been created
        expect(BState?.status ?? CState?.status).toEqual("creating");

        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(output.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("update failures", () => {
    test(
      "A update fails - B, C, D remain stable",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "update")));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(output.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A updates, B update fails - C may update, D stuck",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "update")));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");
        // C might have been updated since it doesn't depend on B
        const cState = yield* getState("C");
        expect(
          cState?.status === "created" || cState?.status === "updated",
        ).toBe(true);
        expect((yield* getState("D"))?.status).toEqual("created");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(output.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A, B, C update - D update fails",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "updated" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          const D = yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
          return { A, B, C, D };
        });

        yield* stack.pipe(test.deploy, hook(failOn("D", "update")));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(output.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("delete failures", () => {
    test(
      "D delete fails - B, C, A waiting",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        yield* destroy().pipe(hook(failOn("D", "delete")));

        expect((yield* getState("D"))?.status).toEqual("deleting");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("D")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "D deleted, B delete fails - C may delete, A waiting",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: A.string });
          yield* TestResource("D", {
            string: Output.interpolate`${B.string}-${C.string}`,
          });
        }).pipe(test.deploy);

        yield* destroy().pipe(hook(failOn("B", "delete")));

        expect(yield* getState("D")).toBeUndefined();
        expect((yield* getState("B"))?.status).toEqual("deleting");
        // C may or may not be deleted depending on execution order
        const cState = yield* getState("C");
        expect(cState === undefined || cState?.status === "created").toBe(true);
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// INDEPENDENT RESOURCES (no dependencies between them)
// =============================================================================

describe("independent resources (A, B with no dependencies)", () => {
  describe("parallel failures", () => {
    test(
      "both A and B fail to create",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: "b-value" });
          return { A, B };
        });

        yield* stack.pipe(
          test.deploy,
          hook(
            failOnMultiple([
              { id: "A", hook: "create" },
              { id: "B", hook: "create" },
            ]),
          ),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState("A");
        const BState = yield* getState("B");
        expect(AState?.status).toBeOneOf(["creating", undefined]);
        expect(BState?.status).toBeOneOf(["creating", undefined]);
        // at least one of A or B should have been creating
        expect(AState?.status ?? BState?.status).toEqual("creating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.string).toEqual("a-value");
        expect(output.B.string).toEqual("b-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B fails - recovery creates B",
      Effect.gen(function* () {
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: "b-value" });
          return { A, B };
        });

        yield* stack.pipe(test.deploy, hook(failOn("B", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.B.string).toEqual("b-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A update fails, B update succeeds",
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: "b-value" });
        }).pipe(test.deploy);

        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-updated" });
          const B = yield* TestResource("B", { string: "b-updated" });
          return { A, B };
        });

        yield* stack.pipe(test.deploy, hook(failOn("A", "update")));

        expect((yield* getState("A"))?.status).toEqual("updating");
        // B might have been updated
        const bState = yield* getState("B");
        expect(
          bState?.status === "created" || bState?.status === "updated",
        ).toBe(true);

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-updated");
        expect(output.B.string).toEqual("b-updated");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("mixed state recovery", () => {
    test(
      "A in creating, B in updating state - recovery completes both",
      Effect.gen(function* () {
        // First create B successfully
        yield* Effect.gen(function* () {
          yield* TestResource("B", { string: "b-value" });
        }).pipe(test.deploy);
        expect((yield* getState("B"))?.status).toEqual("created");

        // Now try to create A and update B - A fails
        const stack = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: "b-updated" });
          return { A, B };
        });

        yield* stack.pipe(
          test.deploy,
          hook(
            failOnMultiple([
              { id: "A", hook: "create" },
              { id: "B", hook: "update" },
            ]),
          ),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState("A");
        const BState = yield* getState("B");
        expect(AState?.status).toBeOneOf(["creating", undefined]);
        expect(BState?.status).toBeOneOf(["created", "updating"]);
        // at least one of A or B should have started their failing operation
        expect(
          AState?.status === "creating" || BState?.status === "updating",
        ).toBe(true);

        // Recovery
        const output = yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value");
        expect(output.B.string).toEqual("b-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A in replacing, B in deleting state - complex recovery",
      Effect.gen(function* () {
        // Create both
        yield* Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "original" });
          yield* TestResource("B", { string: "b-value" });
        }).pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Try to replace A and delete B (by not including B) - both fail
        const stack = Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "changed" });
        });

        yield* stack.pipe(
          test.deploy,
          hook(
            failOnMultiple([
              { id: "A", hook: "create" },
              { id: "B", hook: "delete" },
            ]),
          ),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState<ReplacingResourceState>("A");
        const BState = yield* getState("B");
        expect(AState?.status).toBeOneOf(["created", "replacing"]);
        expect(BState?.status).toBeOneOf(["created", "deleting"]);
        // at least one of A or B should have started their failing operation
        expect(
          AState?.status === "replacing" || BState?.status === "deleting",
        ).toBe(true);

        // Recovery - complete the replace and delete
        yield* stack.pipe(test.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// MULTIPLE RESOURCES REPLACING SIMULTANEOUSLY
// =============================================================================

describe("multiple resources replacing", () => {
  test(
    "two independent resources replace successfully",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
        yield* TestResource("B", { replaceString: "b-original" });
      }).pipe(test.deploy);

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { replaceString: "a-new" });
        const B = yield* TestResource("B", { replaceString: "b-new" });
        return { A, B };
      }).pipe(test.deploy);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("a-new");
      expect(output.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "A replace fails, B replace succeeds - recovery completes A",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
        yield* TestResource("B", { replaceString: "b-original" });
      }).pipe(test.deploy);

      const stack = Effect.gen(function* () {
        const A = yield* TestResource("A", { replaceString: "a-new" });
        const B = yield* TestResource("B", { replaceString: "b-new" });
        return { A, B };
      });

      yield* stack.pipe(test.deploy, hook(failOn("A", "create")));

      expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
        "replacing",
      );
      // B might have been replaced
      const bState = yield* getState("B");
      expect(
        bState?.status === "created" ||
          bState?.status === "replacing" ||
          bState?.status === "replaced",
      ).toBe(true);

      // Recovery
      const output = yield* stack.pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("a-new");
      expect(output.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "both A and B replace fail - recovery completes both",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
        yield* TestResource("B", { replaceString: "b-original" });
      }).pipe(test.deploy);

      const stack = Effect.gen(function* () {
        const A = yield* TestResource("A", { replaceString: "a-new" });
        const B = yield* TestResource("B", { replaceString: "b-new" });
        return { A, B };
      });

      yield* stack.pipe(
        test.deploy,
        hook(
          failOnMultiple([
            { id: "A", hook: "create" },
            { id: "B", hook: "create" },
          ]),
        ),
      );

      // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
      const AState = yield* getState<ReplacingResourceState>("A");
      const BState = yield* getState<ReplacingResourceState>("B");
      expect(AState?.status).toBeOneOf(["created", "replacing"]);
      expect(BState?.status).toBeOneOf(["created", "replacing"]);
      // at least one of A or B should have started replacing
      expect(
        AState?.status === "replacing" || BState?.status === "replacing",
      ).toBe(true);

      // Recovery
      const output = yield* stack.pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("a-new");
      expect(output.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "A replaced, B replacing - old A delete fails, B create fails - recovery completes both",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
        yield* TestResource("B", { replaceString: "b-original" });
      }).pipe(test.deploy);

      const stack = Effect.gen(function* () {
        const A = yield* TestResource("A", { replaceString: "a-new" });
        const B = yield* TestResource("B", { replaceString: "b-new" });
        return { A, B };
      });

      yield* stack.pipe(
        test.deploy,
        hook(
          failOnMultiple([
            { id: "A", hook: "delete" },
            { id: "B", hook: "create" },
          ]),
        ),
      );

      // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
      // A should be replaced (new created, old pending delete) or still replacing/created if B failed first
      // B should be replacing (new not yet created) or already created if A failed first
      const AState = yield* getState<ReplacedResourceState>("A");
      const BState = yield* getState<ReplacingResourceState>("B");
      expect(AState?.status).toBeOneOf(["created", "replacing", "replaced"]);
      expect(BState?.status).toBeOneOf(["created", "replacing"]);
      // at least one of A or B should have started their failing operation
      expect(
        AState?.status === "replaced" || BState?.status === "replacing",
      ).toBe(true);

      // Recovery
      const output = yield* stack.pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("a-new");
      expect(output.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("repeated replacements", () => {
  test(
    "resource can be replaced again while still in replacing state",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
      }).pipe(test.deploy);

      const firstReplacement = Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-first" });
      });

      yield* firstReplacement.pipe(test.deploy, hook(failOn("A", "create")));

      const replacingState = yield* getState<ReplacingResourceState>("A");
      expect(replacingState?.status).toEqual("replacing");

      const secondReplacement = Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-second" });
      });

      yield* secondReplacement.pipe(test.deploy);

      const finalState = yield* getState("A");
      expectConvergedStatus(finalState?.status);
      expect(finalState?.props?.replaceString).toEqual("a-second");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "resource can be replaced again while still in replaced state",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
      }).pipe(test.deploy);

      const firstReplacement = Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-first" });
      });

      yield* firstReplacement.pipe(test.deploy, hook(failOn("A", "delete")));

      const replacedState = yield* getState<ReplacedResourceState>("A");
      expect(replacedState?.status).toEqual("replaced");

      const secondReplacement = Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-second" });
      });

      yield* secondReplacement.pipe(test.deploy);

      const finalState = yield* getState("A");
      expectConvergedStatus(finalState?.status);
      expect(finalState?.props?.replaceString).toEqual("a-second");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// ORPHAN CHAIN DELETION
// =============================================================================

describe("orphan chain deletion", () => {
  test(
    "three-level orphan chain deleted in correct order",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        const B = yield* TestResource("B", { string: A.string });
        yield* TestResource("C", { string: B.string });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect((yield* getState("C"))?.status).toEqual("created");

      // Remove C from graph - should delete C only
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", { string: A.string });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(yield* getState("C")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "orphan with intermediate failure recovers correctly",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        const B = yield* TestResource("B", { string: A.string });
        yield* TestResource("C", { string: B.string });
      }).pipe(test.deploy);

      // Remove all three - C fails to delete
      yield* destroy().pipe(hook(failOn("C", "delete")));

      expect((yield* getState("C"))?.status).toEqual("deleting");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect((yield* getState("A"))?.status).toEqual("created");

      // Recovery
      yield* destroy();
      expect(yield* getState("A")).toBeUndefined();
      expect(yield* getState("B")).toBeUndefined();
      expect(yield* getState("C")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "partial orphan - remove leaf, add new dependent",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", { string: A.string });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");

      // Remove B, add C dependent on A
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        const C = yield* TestResource("C", { string: A.string });
        return { A, C };
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(yield* getState("B")).toBeUndefined();
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(output.C.string).toEqual("a-value");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// COMPLEX MIXED STATE SCENARIOS
// =============================================================================

describe("complex mixed state scenarios", () => {
  test(
    "replace upstream while creating downstream",
    Effect.gen(function* () {
      // Create A
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "a-value",
          replaceString: "original",
        });
      }).pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // Now add B dependent on A, and also replace A
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        });
        const B = yield* TestResource("B", { string: A.string });
        return { A, B };
      }).pipe(test.deploy);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.string).toEqual("a-value-new");
      expect(output.B.string).toEqual("a-value-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "update upstream, create and delete in same apply",
    Effect.gen(function* () {
      // Create A and B
      yield* Effect.gen(function* () {
        yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", { string: "b-value" });
      }).pipe(test.deploy);

      // Update A, delete B (by not including), create C
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-updated" });
        const C = yield* TestResource("C", { string: A.string });
        return { A, C };
      }).pipe(test.deploy);

      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(yield* getState("B")).toBeUndefined();
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(output.C.string).toEqual("a-updated");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "chain reaction: A replace triggers B update triggers C update",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "a-value",
          replaceString: "original",
        });
        const B = yield* TestResource("B", { string: A.string });
        yield* TestResource("C", { string: B.string });
      }).pipe(test.deploy);

      // Replace A - should cascade updates to B and C
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "a-replaced",
          replaceString: "changed",
        });
        const B = yield* TestResource("B", { string: A.string });
        const C = yield* TestResource("C", { string: B.string });
        return { A, B, C };
      }).pipe(test.deploy);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("updated");
      expect((yield* getState("C"))?.status).toEqual("updated");
      expect(output.C.string).toEqual("a-replaced");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "multiple failures across all operation types",
    Effect.gen(function* () {
      // Setup: A, B created; C, D will be added
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "a-value",
          replaceString: "original",
        });
        yield* TestResource("B", { string: "b-value" });
      }).pipe(test.deploy);

      // Complex operation: A replace, B update, C create, D not included (nothing to delete)
      const stack = Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "a-replaced",
          replaceString: "changed",
        });
        const B = yield* TestResource("B", { string: "b-updated" });
        const C = yield* TestResource("C", { string: "c-value" });
        return { A, B, C };
      });

      // Fail on A replace (create phase) and C create
      yield* stack.pipe(
        test.deploy,
        hook(
          failOnMultiple([
            { id: "A", hook: "create" },
            { id: "C", hook: "create" },
          ]),
        ),
      );

      // effect terminates eagerly, so it's possible that A or C runs first and blocks the other from running
      const AState = yield* getState<ReplacingResourceState>("A");
      // B might have been updated
      const bState = yield* getState("B");
      expect(bState?.status === "created" || bState?.status === "updated").toBe(
        true,
      );
      const CState = yield* getState("C");
      expect(AState?.status).toBeOneOf(["created", "replacing"]);
      expect(CState?.status).toBeOneOf(["creating", undefined]);
      // at least one of A or C should have started their failing operation
      expect(
        AState?.status === "replacing" || CState?.status === "creating",
      ).toBe(true);

      // Recovery
      const output = yield* stack.pipe(test.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("updated");
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("changed");
      expect(output.B.string).toEqual("b-updated");
      expect(output.C.string).toEqual("c-value");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("artifacts", () => {
  test(
    "shares artifacts from plan diff into apply update",
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* ArtifactProbe("A", { value: "v1" });
      }).pipe(test.deploy);

      const updated = yield* Effect.gen(function* () {
        const A = yield* ArtifactProbe("A", { value: "v2" });
        return { A };
      }).pipe(test.deploy);

      expect(updated.A.value).toEqual("v2");
      expect(updated.A.artifactValue).toEqual("v2");
      expect((yield* getState("A"))?.status).toEqual("updated");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "isolates artifact bags by FQN for namespaced resources with the same leaf logical ID",
    Effect.gen(function* () {
      const Site = Construct.fn(function* (
        _id: string,
        props: { value: string },
      ) {
        return yield* ArtifactProbe("Shared", { value: props.value });
      });

      yield* Effect.gen(function* () {
        yield* Site("Left", { value: "left-v1" });
        yield* Site("Right", { value: "right-v1" });
      }).pipe(test.deploy);

      const updated = yield* Effect.gen(function* () {
        const left = yield* Site("Left", { value: "left-v2" });
        const right = yield* Site("Right", { value: "right-v2" });
        return { left, right };
      }).pipe(test.deploy);

      expect(updated.left.artifactValue).toEqual("left-v2");
      expect(updated.right.artifactValue).toEqual("right-v2");
      expect((yield* getState("Left/Shared"))?.status).toEqual("updated");
      expect((yield* getState("Right/Shared"))?.status).toEqual("updated");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// STATIC STABLE PROPERTIES (provider.stables defined on provider, not in diff)
// This tests the bug where diff returns undefined but downstream resources
// depend on stable properties that should be preserved
// =============================================================================

describe("static stable properties (provider.stables)", () => {
  describe("diff returns undefined with tag-only changes", () => {
    test(
      "upstream has static stables, diff returns undefined, downstream depends on stableId",
      Effect.gen(function* () {
        // Stage 1: Create A with no tags, B depends on A.stableId
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "value" });
            const B = yield* TestResource("B", { string: A.stableId });
            return { A, B };
          }).pipe(test.deploy);
          expect(output.A.stableId).toEqual("stable-A");
          expect(output.B.string).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
        }

        // Stage 2: Add tags to A - diff returns undefined, but arePropsChanged is true
        // B depends on A.stableId which should remain stable
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", {
              string: "value",
              tags: { Name: "tagged-resource" },
            });
            const B = yield* TestResource("B", { string: A.stableId });
            return { A, B };
          }).pipe(test.deploy);
          // A should be updated (tags changed)
          expect(output.A.tags).toEqual({ Name: "tagged-resource" });
          // B should NOT be updated because stableId didn't change
          expect(output.B.string).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("updated");
          // B should remain "created" (noop) since its input (stableId) didn't change
          expect((yield* getState("B"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "chain: A -> B -> C where B depends on A.stableId and C depends on B.stableString",
      Effect.gen(function* () {
        // Stage 1: Create chain
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "initial" });
            const B = yield* TestResource("B", { string: A.stableId });
            const C = yield* TestResource("C", { string: B.stableString });
            return { A, B, C };
          }).pipe(test.deploy);
          expect(output.A.stableId).toEqual("stable-A");
          expect(output.B.string).toEqual("stable-A");
          expect(output.C.string).toEqual("B");
        }

        // Stage 2: Change A's tags only - diff returns undefined
        // Neither B nor C should update since their inputs are stable
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", {
              string: "initial",
              tags: { Env: "production" },
            });
            const B = yield* TestResource("B", { string: A.stableId });
            const C = yield* TestResource("C", { string: B.stableString });
            return { A, B, C };
          }).pipe(test.deploy);
          expect(output.A.tags).toEqual({ Env: "production" });
          expect((yield* getState("A"))?.status).toEqual("updated");
          // B and C should not change
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "diamond: A -> B,C -> D where all depend on stable properties",
      Effect.gen(function* () {
        // Stage 1: Create diamond
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "initial" });
            const B = yield* TestResource("B", { string: A.stableId });
            const C = yield* TestResource("C", { string: A.stableArn });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.stableString}-${C.stableString}`,
            });
            return { A, B, C, D };
          }).pipe(test.deploy);
          expect(output.A.stableId).toEqual("stable-A");
          expect(output.A.stableArn).toEqual(
            "arn:test:resource:us-east-1:123456789:A",
          );
          expect(output.B.string).toEqual("stable-A");
          expect(output.C.string).toEqual(
            "arn:test:resource:us-east-1:123456789:A",
          );
          expect(output.D.string).toEqual("B-C");
        }

        // Stage 2: Change A's tags - should not affect B, C, or D
        {
          yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", {
              string: "initial",
              tags: { Team: "platform" },
            });
            const B = yield* TestResource("B", { string: A.stableId });
            const C = yield* TestResource("C", { string: A.stableArn });
            yield* TestResource("D", {
              string: Output.interpolate`${B.stableString}-${C.stableString}`,
            });
          }).pipe(test.deploy);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("diff returns update action with static stables", () => {
    test(
      "upstream has static stables and diff returns update, downstream depends on stableId",
      Effect.gen(function* () {
        // Stage 1: Create A and B
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "value-1" });
            const B = yield* TestResource("B", { string: A.stableId });
            return { A, B };
          }).pipe(test.deploy);
          expect(output.A.stableId).toEqual("stable-A");
          expect(output.B.string).toEqual("stable-A");
        }

        // Stage 2: Change A's string - diff returns "update", stableId still stable
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "value-2" });
            const B = yield* TestResource("B", { string: A.stableId });
            return { A, B };
          }).pipe(test.deploy);
          expect(output.A.string).toEqual("value-2");
          expect(output.A.stableId).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("updated");
          // B should not change since stableId is stable
          expect((yield* getState("B"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "downstream depends on non-stable property, should update",
      Effect.gen(function* () {
        // Stage 1: Create A and B where B depends on A.string (non-stable)
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "value-1" });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          }).pipe(test.deploy);
          expect(output.A.string).toEqual("value-1");
          expect(output.B.string).toEqual("value-1");
        }

        // Stage 2: Change A's string - B should update
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", { string: "value-2" });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          }).pipe(test.deploy);
          expect(output.A.string).toEqual("value-2");
          expect(output.B.string).toEqual("value-2");
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
        }
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("replace action with static stables", () => {
    test(
      "upstream replaces, downstream depends on stableId - should update with new value",
      Effect.gen(function* () {
        // Stage 1: Create A and B
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", {
              string: "value",
              replaceString: "original",
            });
            const B = yield* TestResource("B", { string: A.stableId });
            return { A, B };
          }).pipe(test.deploy);
          expect(output.A.stableId).toEqual("stable-A");
          expect(output.B.string).toEqual("stable-A");
        }

        // Stage 2: Replace A - stableId will change (new resource)
        {
          const output = yield* Effect.gen(function* () {
            const A = yield* StaticStablesResource("A", {
              string: "value",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.stableId });
            return { A, B };
          }).pipe(test.deploy);
          // A was replaced, stableId is regenerated
          expect(output.A.stableId).toEqual("stable-A");
          expect(output.B.string).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
        }
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});
