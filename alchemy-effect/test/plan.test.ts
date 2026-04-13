import * as Construct from "@/Construct";
import type { Input, InputProps } from "@/Input";
import * as Output from "@/Output";
import * as Plan from "@/Plan";
import { UnsatisfiedResourceCycle } from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { State, type ResourceState, type ResourceStatus } from "@/State";
import {
  test as baseTest,
  expectEmptyObject,
  expectPropExpr,
} from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  ArtifactProbe,
  BindingTarget,
  Bucket,
  Function,
  NoPrecreateBindingTarget,
  Queue,
  TestLayers,
  TestResource,
  type TestResourceProps,
} from "./test.resources";

const test = Object.assign(
  ((name: string, ...args: any[]) => {
    if (args.length === 1) {
      return (baseTest as any)(
        name,
        {
          providers: false,
        },
        args[0],
      );
    }

    const [options, effect] = args;
    return (baseTest as any)(
      name,
      {
        ...options,
        providers: false,
      },
      effect,
    );
  }) as typeof baseTest,
  baseTest,
);

const _test = test;

const instanceId = "852f6ec2e19b66589825efe14dca2971";

const makePlan = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
  options?: Plan.MakePlanOptions,
): Effect.Effect<Plan.Plan<A>, Err, never> =>
  // @ts-expect-error
  Effect.gen(function* () {
    const stack = yield* Stack.Stack;
    // @ts-expect-error
    return yield* effect.pipe(
      // @ts-expect-error
      Stack.make(stack.name, Layer.empty),
      Effect.provideService(Stage, stack.stage),
      Effect.flatMap((stackSpec) => Plan.make(stackSpec, options)),
      Effect.provide(TestLayers()),
    );
  });

const makePlanWithCustomStack =
  (stackSpec: any) =>
  <A, Err = never, Req = never>(
    effect: Effect.Effect<A, Err, Req>,
  ): Effect.Effect<Plan.Plan<A>, Err, never> =>
    // @ts-expect-error
    Effect.gen(function* () {
      const stack = yield* Stack.Stack;
      // @ts-expect-error
      return yield* effect.pipe(
        // @ts-expect-error
        Stack.make(stack.name, Layer.empty, stackSpec),
        Effect.provideService(Stage, stack.stage),
        Effect.flatMap(Plan.make),
        Effect.provide(TestLayers()),
      );
    });

test(
  "artifacts are isolated by FQN during plan diff for namespaced resources",
  {
    state: test.state({
      "Left/Shared": {
        instanceId: "left-instance",
        providerVersion: 0,
        logicalId: "Shared",
        fqn: "Left/Shared",
        namespace: { Id: "Left" },
        resourceType: "Test.ArtifactProbe",
        status: "created",
        props: {
          value: "left-v1",
        },
        attr: {
          value: "left-v1",
          artifactValue: undefined,
        },
        bindings: [],
        downstream: [],
      },
      "Right/Shared": {
        instanceId: "right-instance",
        providerVersion: 0,
        logicalId: "Shared",
        fqn: "Right/Shared",
        namespace: { Id: "Right" },
        resourceType: "Test.ArtifactProbe",
        status: "created",
        props: {
          value: "right-v1",
        },
        attr: {
          value: "right-v1",
          artifactValue: undefined,
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    const Site = Construct.fn(function* (
      _id: string,
      props: { value: string },
    ) {
      return yield* ArtifactProbe("Shared", { value: props.value });
    });

    const plan = yield* Effect.gen(function* () {
      const left = yield* Site("Left", { value: "left-v2" });
      const right = yield* Site("Right", { value: "right-v2" });
      return { left, right };
    }).pipe(makePlan);

    expect(plan.resources["Left/Shared"]?.action).toEqual("update");
    expect(plan.resources["Right/Shared"]?.action).toEqual("update");
  }),
);

test(
  "create all resources when plan is empty",
  {
    state: test.state(),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        const bucket = yield* Bucket("MyBucket", {
          name: "test-bucket",
        });
        const queue = yield* Queue("MyQueue", {
          name: "test-queue",
        });

        return {
          queueUrl: queue.queueUrl,
          bucketArn: bucket.bucketArn,
        };
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "create",
          bindings: [],
          props: {
            name: "test-bucket",
          },
          state: undefined,
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          state: undefined,
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "update the changed resources and no-op un-changed resources",
  {
    state: test.state({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Bucket("MyBucket", {
            name: "test-bucket",
          });
          yield* Queue("MyQueue", {
            name: "test-queue",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          state: undefined,
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "force changes noop resources into updates",
  {
    state: test.state({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Bucket("MyBucket", {
            name: "test-bucket",
          });
        }),
        { force: true },
      ),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "update",
          bindings: [],
          props: {
            name: "test-bucket",
          },
          state: {
            status: "created",
          },
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "no-op resources with undefined props",
  {
    state: test.state({
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: undefined as any,
        attr: {
          name: "MyQueue",
          queueUrl: "https://test.queue.com/MyQueue",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Queue("MyQueue");
        }),
      ),
    ).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "no-op resources when object prop key order changes",
  {
    state: test.state({
      MyFunction: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyFunction",
        fqn: "MyFunction",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "test-function",
          env: {
            A: "1",
            B: "2",
          },
        },
        attr: {
          name: "test-function",
          env: {
            A: "1",
            B: "2",
          },
          functionArn: "arn:test:function:MyFunction",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Function("MyFunction", {
            name: "test-function",
            env: {
              B: "2",
              A: "1",
            },
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyFunction: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "delete orphaned resources",
  {
    state: test.state({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue",
        },
        attr: {
          name: "test-queue",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    const state = yield* State;
    const resourceIds = yield* state.list({
      stack: "test",
      stage: "test",
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Queue("MyQueue", {
            name: "test-queue",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: {
        MyBucket: {
          action: "delete",
          bindings: [],
          state: {
            status: "created",
            attr: {
              name: "test-bucket",
            },
          },
          resource: {
            LogicalId: "MyBucket",
            Type: "Test.Bucket",
            Props: {
              name: "test-bucket",
            },
          },
        },
      },
    });
  }),
);

test(
  "allow deleting a resource after a surviving consumer removes the dependency",
  {
    state: test.state({
      Secret: {
        instanceId,
        providerVersion: 0,
        logicalId: "Secret",
        fqn: "Secret",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          string: "secret-value",
        },
        attr: {
          string: "secret-value",
          stringArray: [],
          stableString: "Secret",
          stableArray: ["Secret"],
          replaceString: undefined,
        },
        bindings: [],
        downstream: ["Worker"],
      },
      Worker: {
        instanceId,
        providerVersion: 0,
        logicalId: "Worker",
        fqn: "Worker",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
        },
        attr: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
          functionArn: "arn:aws:lambda:us-west-2:084828582823:function:Worker",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Function("Worker", {
            name: "worker",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        Worker: {
          action: "update",
          props: {
            name: "worker",
          },
          bindings: [],
        },
      },
      deletions: {
        Secret: {
          action: "delete",
          state: {
            status: "created",
            downstream: ["Worker"],
          },
        },
      },
    });
  }),
);

test(
  "reject deleting a resource when a surviving consumer still references it",
  {
    state: test.state({
      Secret: {
        instanceId,
        providerVersion: 0,
        logicalId: "Secret",
        fqn: "Secret",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          string: "secret-value",
        },
        attr: {
          string: "secret-value",
          stringArray: [],
          stableString: "Secret",
          stableArray: ["Secret"],
          replaceString: undefined,
        },
        bindings: [],
        downstream: ["Worker"],
      },
      Worker: {
        instanceId,
        providerVersion: 0,
        logicalId: "Worker",
        fqn: "Worker",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
        },
        attr: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
          functionArn: "arn:aws:lambda:us-west-2:084828582823:function:Worker",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    const currentStack = yield* Stack.Stack;
    const malformedStack = {
      name: currentStack.name,
      stage: currentStack.stage,
      resources: {},
      bindings: {},
      output: undefined,
    };

    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const secret = yield* TestResource("Secret", {
          string: "secret-value",
        });
        yield* Function("Worker", {
          name: "worker",
          env: {
            SECRET: secret.string,
          },
        });
        const stack = yield* Stack.Stack;
        delete stack.resources.Secret;
      }).pipe(makePlanWithCustomStack(malformedStack)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find(Cause.isFailReason);
      expect(reason).toBeDefined();
      expect(reason!.error).toEqual(
        new Plan.DeleteResourceHasDownstreamDependencies({
          message: "Resource Secret has downstream dependencies",
          resourceId: "Secret",
          dependencies: ["Worker"],
        }),
      );
    }
  }),
);

describe("replace resource when replaceString changes", () => {
  const state = test.state({
    A: {
      instanceId,
      providerVersion: 0,
      logicalId: "A",
      fqn: "A",
      namespace: undefined,
      resourceType: "Test.TestResource",
      status: "created",
      props: {
        replaceString: "A",
      },
      attr: {},
      downstream: [],
      bindings: [],
    },
  });

  test(
    "noop and replace when replaceString is fully resolved at plan time",
    { state },
    Effect.gen(function* () {
      expect(
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "A",
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "noop",
          },
        },
        deletions: expectEmptyObject(),
      });

      expect(
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "B",
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "replace",
            props: {
              replaceString: "B",
            },
          },
        },
        deletions: expectEmptyObject(),
      });
    }),
  );

  test(
    "force preserves replaces",
    { state },
    Effect.gen(function* () {
      expect(
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "B",
          });
        }).pipe((effect) => makePlan(effect, { force: true })),
      ).toMatchObject({
        resources: {
          A: {
            action: "replace",
            props: {
              replaceString: "B",
            },
          },
        },
        deletions: expectEmptyObject(),
      });
    }),
  );

  test(
    "update when replaceString depends on unresolved output (diff short-circuits)",
    { state },
    Effect.gen(function* () {
      let B: TestResource;
      expect(
        yield* Effect.gen(function* () {
          B = yield* TestResource("B", {
            string: "A",
          });
          yield* TestResource("A", {
            replaceString: B.string,
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "update",
            props: {
              replaceString: expectPropExpr("string", B!),
            },
          },
        },
        deletions: expectEmptyObject(),
      });
    }),
  );
});

test(
  "update resource when a binding is added without prop changes",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {},
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        const target = yield* BindingTarget("A", {
          name: "target",
        });
        yield* target.bind("TestBinding", {
          env: {
            FEATURE_FLAG: "on",
          },
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "update",
          bindings: [
            {
              action: "create",
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          state: {
            status: "created",
          },
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "update resource when a binding is removed without prop changes",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {
            FEATURE_FLAG: "on",
          },
        },
        bindings: [
          {
            sid: "TestBinding",
            data: {
              env: {
                FEATURE_FLAG: "on",
              },
            },
          },
        ],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        yield* BindingTarget("A", {
          name: "target",
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "update",
          bindings: [
            {
              action: "delete",
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          state: {
            status: "created",
          },
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "binding removals do not keep reappearing after apply",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {
            FEATURE_FLAG: "on",
          },
        },
        bindings: [
          {
            sid: "TestBinding",
            data: {
              env: {
                FEATURE_FLAG: "on",
              },
            },
          },
        ],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    const stack = yield* Stack.Stack;
    const state = yield* State;

    yield* test
      .deploy(
        Effect.gen(function* () {
          yield* BindingTarget("A", {
            name: "target",
          });
        }),
      )
      .pipe(Effect.provide(TestLayers()));

    expect(
      yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: "A",
      }),
    ).toMatchObject({
      bindings: [],
    });

    expect(
      yield* Effect.gen(function* () {
        yield* BindingTarget("A", {
          name: "target",
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "noop",
          bindings: [],
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

describe("construct namespaces", () => {
  test(
    "namespaced construct bindings resolve into the plan graph",
    Effect.gen(function* () {
      const Site = Construct.fn(function* (_id: string, _props: {}) {
        const bucket = yield* BindingTarget("Bucket", {
          name: "bucket",
        });
        const distribution = yield* BindingTarget("Distribution", {
          name: "distribution",
        });
        yield* bucket.bind("Policy", {
          env: {
            BUCKET: bucket.string,
            DISTRIBUTION: distribution.string,
          },
        });
        return { bucket, distribution };
      });

      const plan = yield* Effect.gen(function* () {
        yield* Site("MarketingSite", {});
      }).pipe(makePlan);

      expect(plan).toMatchObject({
        resources: {
          "MarketingSite/Bucket": {
            action: "create",
            bindings: [
              {
                action: "create",
                sid: "Policy",
                data: {
                  env: {
                    BUCKET: expectPropExpr(
                      "string",
                      plan.resources["MarketingSite/Bucket"]!.resource,
                    ),
                    DISTRIBUTION: expectPropExpr(
                      "string",
                      plan.resources["MarketingSite/Distribution"]!.resource,
                    ),
                  },
                },
              },
            ],
          },
          "MarketingSite/Distribution": {
            action: "create",
            bindings: [],
          },
        },
        deletions: expectEmptyObject(),
      });
    }),
  );

  test(
    "same child logical ids in different constructs do not collide",
    Effect.gen(function* () {
      const Site = Construct.fn(function* (
        _id: string,
        props: { name: string },
      ) {
        return yield* Bucket("Bucket", {
          name: props.name,
        });
      });

      const plan = yield* Effect.gen(function* () {
        yield* Site("MarketingSite", {
          name: "marketing-bucket",
        });
        yield* Site("DocsSite", {
          name: "docs-bucket",
        });
      }).pipe(makePlan);

      expect(plan).toMatchObject({
        resources: {
          "MarketingSite/Bucket": {
            action: "create",
            props: {
              name: "marketing-bucket",
            },
          },
          "DocsSite/Bucket": {
            action: "create",
            props: {
              name: "docs-bucket",
            },
          },
        },
        deletions: expectEmptyObject(),
      });
    }),
  );

  test(
    "binding-only cycles inside a construct do not become downstream edges",
    Effect.gen(function* () {
      const Site = Construct.fn(function* (_id: string, _props: {}) {
        const A = yield* BindingTarget("A", {
          string: "a-value",
        });
        const B = yield* BindingTarget("B", {
          string: "b-value",
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

        return { A, B };
      });

      const plan = yield* Effect.gen(function* () {
        yield* Site("MarketingSite", {});
      }).pipe(makePlan);

      expect(plan.resources["MarketingSite/A"]?.downstream).toEqual([]);
      expect(plan.resources["MarketingSite/B"]?.downstream).toEqual([]);
      expect(plan.deletions).toEqual({});
    }),
  );
});

const createTestResourceState = (options: {
  logicalId: string;
  status: ResourceStatus;
  props: TestResourceProps;
  attr?: {};
}) =>
  ({
    instanceId,
    providerVersion: 0,
    ...options,
    resourceType: "Test.TestResource",
    attr: options.attr ?? {},
    downstream: [],
    bindings: [],
    fqn: options.logicalId,
    namespace: undefined,
  }) as ResourceState;

const createReplacingState = (options: {
  logicalId: string;
  props: TestResourceProps;
  old: ResourceState;
  attr?: {};
}) =>
  ({
    ...createTestResourceState({
      logicalId: options.logicalId,
      status: "replacing",
      props: options.props,
      attr: options.attr,
    }),
    old: options.old,
    deleteFirst: false,
  }) as Extract<ResourceState, { status: "replacing" }>;

const createReplacedState = (options: {
  logicalId: string;
  props: TestResourceProps;
  old: ResourceState;
  attr?: {};
}) =>
  ({
    ...createTestResourceState({
      logicalId: options.logicalId,
      status: "replaced",
      props: options.props,
      attr: options.attr,
    }),
    old: options.old,
    deleteFirst: false,
  }) as Extract<ResourceState, { status: "replaced" }>;

const testSimple = (
  title: string,
  testCase: {
    state: {
      status: ResourceStatus;
      props: TestResourceProps;
      attr?: {};
      old?: Partial<ResourceState>;
    };
    props: TestResourceProps;
    plan?: any;
    fail?: string;
  },
) =>
  test(
    title,
    {
      state: test.state({
        A: createTestResourceState({
          ...testCase.state,
          logicalId: "A",
        }),
      }),
    },
    Effect.gen(function* () {
      {
        const plan = Effect.gen(function* () {
          yield* TestResource("A", testCase.props);
        }).pipe(makePlan);

        if (testCase.fail) {
          const result = plan.pipe(
            Effect.map(() => false),
            // @ts-expect-error
            Effect.catchTag(testCase.fail, () => Effect.succeed(true)),
            Effect.catch(() => Effect.succeed(false)),
          ) as Effect.Effect<boolean>;
          if (!result) {
            expect.fail(`Expected error '${testCase.fail}`);
          }
        } else {
          expect(yield* plan).toMatchObject({
            resources: {
              A: testCase.plan,
            },
            deletions: expectEmptyObject(),
          });
        }
      }
    }),
  );

describe("prior crash in 'creating' state", () => {
  testSimple("create if props unchanged", {
    state: {
      status: "creating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "A",
    },
    plan: {
      action: "create",
      props: {
        string: "A",
      },
    },
  });

  testSimple("create if changed props can be updated", {
    state: {
      status: "creating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "B",
    },
    plan: {
      action: "create",
      props: {
        string: "B",
      },
    },
  });

  testSimple("replace if changed props cannot be updated", {
    state: {
      status: "creating",
      props: {
        replaceString: "A",
      },
    },
    props: {
      replaceString: "B",
    },
    plan: {
      action: "replace",
      props: {
        replaceString: "B",
      },
      state: {
        status: "creating",
        props: {
          replaceString: "A",
        },
      },
    },
  });
});

describe("prior crash in 'updating' state", () => {
  testSimple("update if props unchanged", {
    state: {
      status: "updating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "A",
    },
    plan: {
      action: "update",
      props: {
        string: "A",
      },
      state: {
        status: "updating",
        props: {
          string: "A",
        },
      },
    },
  });

  testSimple("update if changed props can be updated", {
    state: {
      status: "updating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "B",
    },
    plan: {
      action: "update",
      props: {
        string: "B",
      },
      state: {
        status: "updating",
        props: {
          string: "A",
        },
      },
    },
  });

  testSimple("replace if changed props can not be updated", {
    state: {
      status: "updating",
      props: {
        replaceString: "A",
      },
    },
    props: {
      replaceString: "B",
    },
    plan: {
      action: "replace",
      props: {
        replaceString: "B",
      },
      state: {
        status: "updating",
        props: {
          replaceString: "A",
        },
      },
    },
  });
});

describe("prior crash in 'replacing' state", () => {
  const priorStates = ["created", "creating", "updated", "updating"] as const;

  const testUnchanged = ({
    old,
  }: {
    old: {
      status: ResourceStatus;
    };
  }) =>
    testSimple(
      `"continue 'replace' if props are unchanged and previous state is '${old.status}'"`,
      {
        state: {
          status: "replacing",
          props: {
            string: "A",
          },
          old,
        },
        props: {
          string: "A",
        },
        plan: {
          action: "replace",
          props: {
            string: "A",
          },
          state: {
            status: "replacing",
            props: {
              string: "A",
            },
            old,
          },
        },
      },
    );

  priorStates.forEach((status) =>
    testUnchanged({
      old: {
        status,
      },
    }),
  );

  const testMinorChange = ({
    old,
  }: {
    old: {
      status: ResourceStatus;
    };
  }) =>
    testSimple(
      `"continue 'replace' if props can be updated and previous state is '${old.status}'"`,
      {
        state: {
          status: "replacing",
          props: {
            string: "A",
          },
          old,
        },
        props: {
          string: "B",
        },
        plan: {
          action: "replace",
          props: {
            string: "B",
          },
          state: {
            status: "replacing",
            props: {
              string: "A",
            },
            old,
          },
        },
      },
    );

  priorStates.forEach((status) =>
    testMinorChange({
      old: {
        status,
      },
    }),
  );

  const testReplacement = (
    title: string,
    {
      old,
      plan,
    }: {
      old: ResourceState;
      plan: any;
    },
  ) =>
    testSimple(title, {
      state: {
        status: "replacing",
        props: {
          replaceString: "A",
        },
        old,
      },
      props: {
        replaceString: "B",
      },
      plan,
    });

  (["replaced", "replacing"] as const).forEach((status) =>
    testReplacement(
      `continue 'replace' if trying to replace a partially replaced resource in state '${status}'`,
      {
        old:
          status === "replaced"
            ? createReplacedState({
                logicalId: "A_old1",
                props: {
                  replaceString: "A1",
                },
                old: createTestResourceState({
                  logicalId: "A_old0",
                  status: "created",
                  props: {
                    replaceString: "A0",
                  },
                }),
              })
            : createReplacingState({
                logicalId: "A_old1",
                props: {
                  replaceString: "A1",
                },
                old: createTestResourceState({
                  logicalId: "A_old0",
                  status: "created",
                  props: {
                    replaceString: "A0",
                  },
                }),
              }),
        plan: {
          action: "replace",
          props: {
            replaceString: "B",
          },
          state: {
            status: "replacing",
            props: {
              replaceString: "A",
            },
            old: expect.objectContaining({
              status,
              props: {
                replaceString: "A1",
              },
              old: expect.objectContaining({
                status: "created",
                props: {
                  replaceString: "A0",
                },
              }),
            }),
          },
        },
      },
    ),
  );
});

describe("prior crash in 'replaced' state", () => {
  (["replaced", "replacing"] as const).forEach((status) =>
    testSimple(
      `continue 'replace' if a replaced resource must be replaced again and previous state is '${status}'`,
      {
        state: {
          status: "replaced",
          props: {
            replaceString: "A1",
          },
          old:
            status === "replaced"
              ? createReplacedState({
                  logicalId: "A_old0",
                  props: {
                    replaceString: "A0",
                  },
                  old: createTestResourceState({
                    logicalId: "A_old-1",
                    status: "created",
                    props: {
                      replaceString: "A-1",
                    },
                  }),
                })
              : createReplacingState({
                  logicalId: "A_old0",
                  props: {
                    replaceString: "A0",
                  },
                  old: createTestResourceState({
                    logicalId: "A_old-1",
                    status: "created",
                    props: {
                      replaceString: "A-1",
                    },
                  }),
                }),
        },
        props: {
          replaceString: "B",
        },
        plan: {
          action: "replace",
          props: {
            replaceString: "B",
          },
          state: {
            status: "replaced",
            props: {
              replaceString: "A1",
            },
            old: expect.objectContaining({
              status,
              props: {
                replaceString: "A0",
              },
              old: expect.objectContaining({
                status: "created",
                props: {
                  replaceString: "A-1",
                },
              }),
            }),
          },
        },
      },
    ),
  );
});

describe("prior crash in 'deleting' state", () => {
  testSimple(
    "create the resource if props are unchanged and the previous state is 'deleting'",
    {
      state: {
        status: "deleting",
        props: {
          string: "A",
        },
      },
      props: {
        string: "A",
      },
      plan: {
        action: "create",
        props: {
          string: "A",
        },
      },
    },
  );
});

test(
  "lazy Output queue.queueUrl to Function.env",
  Effect.gen(function* () {
    let MyQueue: Queue;
    let MyFunction: Function;
    const plan = yield* Effect.gen(function* () {
      MyQueue = yield* Queue("MyQueue");
      MyFunction = yield* Function("MyFunction", {
        name: "test-function",
        env: {
          QUEUE_URL: MyQueue.queueUrl,
        },
      });
    }).pipe(makePlan);
    expect(plan).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction!,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expectPropExpr("queueUrl", MyQueue!),
            },
          },
          state: undefined,
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

test(
  "detect that queueUrl will change and pass through the PropExpr instead of old output",
  {
    state: test.state({
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue-old",
        },
        attr: {
          queueUrl: "https://test.queue.com/test-queue-old",
        },
        downstream: [],
        bindings: [],
      },
    }),
  },
  Effect.gen(function* () {
    let MyQueue: Queue;
    let MyFunction: Function;
    const plan = yield* Effect.gen(function* () {
      MyQueue = yield* Queue("MyQueue");
      MyFunction = yield* Function("MyFunction", {
        name: "test-function",
        env: {
          QUEUE_URL: MyQueue.queueUrl,
        },
      });
    }).pipe(makePlan);
    expect(plan).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction!,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expectPropExpr("queueUrl", MyQueue!),
            },
          },
          state: undefined,
        },
      },
      deletions: expectEmptyObject(),
    });
  }),
);

describe("Outputs should resolve to old values", () => {
  const state = _test.state({
    A: {
      instanceId,
      providerVersion: 0,
      logicalId: "A",
      fqn: "A",
      namespace: undefined,
      resourceType: "Test.TestResource",
      status: "created",
      props: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      attr: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      downstream: [],
      bindings: [],
    },
  });

  const expected = (props: Input.Resolve<InputProps<TestResourceProps>>) => ({
    resources: {
      A: {
        action: "noop",
        bindings: [],
      },
      B: {
        action: "create",
        bindings: [],
        props: props,
      },
    },
    deletions: expectEmptyObject(),
  });

  const test = <const I extends InputProps<TestResourceProps>>(
    description: string,
    input: (resource: TestResource) => I,
    attr: Input.Resolve<I>,
  ) =>
    _test(
      description,
      {
        state,
      },
      Effect.gen(function* () {
        expect(
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "test-string",
              stringArray: ["test-string"],
            });
            yield* TestResource("B", input(A));
          }).pipe(makePlan),
        ).toMatchObject(expected(attr));
      }),
    );

  test(
    "string",
    (A) => ({
      string: A.string,
    }),
    {
      string: "test-string",
    },
  );

  test(
    "string.apply(string => undefined)",
    (A) => ({
      string: A.string.pipe(Output.map(() => undefined)),
    }),
    {
      string: undefined,
    },
  );

  test(
    "string.effect(string => Effect.succeed(undefined))",
    (A) => ({
      string: A.string.pipe(Output.mapEffect(() => Effect.succeed(undefined))),
    }),
    {
      string: undefined,
    },
  );

  test(
    "stringArray[0].toUpperCase()",
    (A) => ({
      string: A.stringArray.pipe(
        Output.map((stringArray) => stringArray[0]!.toUpperCase()),
      ),
    }),
    {
      string: "TEST-STRING",
    },
  );

  test(
    "resource object",
    (A) => ({
      object: A as any,
    }),
    {
      object: {
        string: "test-string",
      },
    } as any,
  );
});

describe("stable properties should not cause downstream changes", () => {
  const test = (
    description: string,
    input: (A: TestResource) => InputProps<TestResourceProps>,
  ) => {
    // @ts-expect-error - get the keys
    const props = input(Output.of({}));
    _test(
      description,
      {
        state: _test.state({
          A: {
            instanceId,
            providerVersion: 0,
            logicalId: "A",
            fqn: "A",
            namespace: undefined,
            resourceType: "Test.TestResource",
            status: "created",
            props: {
              string: "test-string-old",
            },
            attr: {
              string: "test-string-old",
              stableString: "A",
              stableArray: ["A"],
            },
            downstream: [],
            bindings: [],
          },
          B: {
            instanceId,
            providerVersion: 0,
            logicalId: "B",
            fqn: "B",
            namespace: undefined,
            resourceType: "Test.TestResource",
            status: "created",
            props: Object.fromEntries(
              Object.entries({
                string: "A",
                stringArray: ["A"],
              }).filter(([key]) => key in props),
            ),
            attr: {
              stableString: "A",
            },
            downstream: [],
            bindings: [],
          },
        }),
      },
      Effect.gen(function* () {
        expect(
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "test-string",
            });
            yield* TestResource("B", input(A));
          }).pipe(makePlan),
        ).toMatchObject({
          resources: {
            A: {
              action: "update",
              props: {
                string: "test-string",
              },
            },
            B: {
              action: "noop",
            },
          },
          deletions: expectEmptyObject(),
        });
      }),
    );
  };

  test("A.stableString", (A) => ({
    string: A.stableString,
  }));

  test("A.stableString.apply((string) => string.toUpperCase())", (A) => ({
    string: A.stableString.pipe(Output.map((string) => string.toUpperCase())),
  }));

  test("A.stableString.effect((string) => Effect.succeed(string.toUpperCase()))", (A) => ({
    string: A.stableString.pipe(
      Output.mapEffect((string) => Effect.succeed(string.toUpperCase())),
    ),
  }));

  test("A.stableArray", (A) => ({
    stringArray: A.stableArray,
  }));

  test("A.stableArray[0]", (A) => ({
    string: A.stableArray.pipe(Output.map((stableArray) => stableArray[0]!)),
  }));

  test("A.stableArray[0].apply((string) => string.toUpperCase())", (A) => ({
    string: A.stableArray.pipe(
      Output.map((stableArray) => stableArray[0]!.toUpperCase()),
    ),
  }));

  test("A.stableArray[0].effect((string) => Effect.succeed(string.toUpperCase()))", (A) => ({
    string: A.stableArray.pipe(
      Output.mapEffect((stableArray) =>
        Effect.succeed(stableArray[0]!.toUpperCase()),
      ),
    ),
  }));
});

describe("unsatisfied cycle detection", () => {
  const extractCycleDefect = <A, E>(
    exit: Exit.Exit<A, E>,
  ): UnsatisfiedResourceCycle | undefined => {
    if (!Exit.isFailure(exit)) return undefined;
    const die = exit.cause.reasons.find(Cause.isDieReason);
    return die?.defect as UnsatisfiedResourceCycle | undefined;
  };

  test(
    "binding cycle between resources without precreate dies",
    {
      state: test.state(),
    },
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* NoPrecreateBindingTarget("A", {
            string: "a-value",
          });
          const B = yield* NoPrecreateBindingTarget("B", {
            string: "b-value",
          });

          yield* A.bind("FromB", { env: { PEER: B.string } });
          yield* B.bind("FromA", { env: { PEER: A.string } });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      const err = extractCycleDefect(exit);
      expect(err).toBeDefined();
      expect(err!._tag).toBe("UnsatisfiedResourceCycle");
      expect(err!.cycle.sort()).toEqual(["A", "B"]);
      expect(err!.missingPrecreate.sort()).toEqual(["A", "B"]);
    }),
  );

  test(
    "binding cycle with all precreate resources succeeds",
    {
      state: test.state(),
    },
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* BindingTarget("A", { string: "a-value" });
          const B = yield* BindingTarget("B", { string: "b-value" });

          yield* A.bind("FromB", {
            env: { PEER: B.string },
          });
          yield* B.bind("FromA", {
            env: { PEER: A.string },
          });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  test(
    "mixed cycle succeeds when precreate resource breaks it",
    {
      state: test.state(),
    },
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* BindingTarget("A", { string: "a-value" });
          const B = yield* NoPrecreateBindingTarget("B", {
            string: A.string,
          });

          yield* A.bind("FromB", {
            env: { PEER: B.string },
          });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  test(
    "three-node binding cycle dies when none have precreate",
    {
      state: test.state(),
    },
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* NoPrecreateBindingTarget("A", { string: "a" });
          const B = yield* NoPrecreateBindingTarget("B", { string: "b" });
          const C = yield* NoPrecreateBindingTarget("C", { string: "c" });

          yield* A.bind("FromC", { env: { PEER: C.string } });
          yield* B.bind("FromA", { env: { PEER: A.string } });
          yield* C.bind("FromB", { env: { PEER: B.string } });

          return { A, B, C };
        }),
      ).pipe(Effect.exit);

      const err = extractCycleDefect(exit);
      expect(err).toBeDefined();
      expect(err!._tag).toBe("UnsatisfiedResourceCycle");
      expect(err!.cycle.sort()).toEqual(["A", "B", "C"]);
      expect(err!.missingPrecreate.sort()).toEqual(["A", "B", "C"]);
    }),
  );

  test(
    "acyclic binding graph succeeds even without precreate",
    {
      state: test.state(),
    },
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* NoPrecreateBindingTarget("A", {
            string: "a-value",
          });
          const B = yield* NoPrecreateBindingTarget("B", {
            string: A.string,
          });

          yield* B.bind("FromA", { env: { PEER: A.string } });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});

describe("unresolved plan inputs in diff should conservatively update", () => {
  test(
    "update when upstream resource is new and downstream news contains exprs",
    {
      state: _test.state({
        B: {
          instanceId,
          providerVersion: 0,
          logicalId: "B",
          fqn: "B",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "created",
          props: {
            string: "old-value",
          },
          attr: {
            string: "old-value",
            stableString: "B",
            stableArray: ["B"],
          },
          downstream: [],
          bindings: [],
        },
      }),
    },
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "hello",
        });
        yield* TestResource("B", {
          string: A.string,
        });
      }).pipe(makePlan);

      expect(plan.resources.A.action).toBe("create");
      expect(plan.resources.B.action).toBe("update");
    }),
  );
});
