import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as iam from "@distilled.cloud/aws/iam";
import type { CreateFunctionRequest } from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Region } from "@distilled.cloud/aws/Region";
import type * as lambda from "aws-lambda";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import type { LogLine, LogsInput } from "../../Provider.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import * as Serverless from "../../Serverless/index.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, createTagsList, hasTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import { Account } from "../Account.ts";
import { Assets } from "../Assets.ts";
import * as IAM from "../IAM/index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { makeFunctionHttpHandler } from "./HttpServer.ts";

export const FunctionTypeId = "AWS.Lambda.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

export class HandlerContext extends Context.Service<
  HandlerContext,
  lambda.Context
>()("AWS.Lambda.HandlerContext") {}

export const isFunction = (value: any): value is Function => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.Lambda.Function"
  );
};

export interface FunctionBuildOptions {
  readonly input?: Partial<rolldown.InputOptions>;
  readonly output?: Partial<rolldown.OutputOptions>;
}

export interface FunctionProps extends PlatformProps {
  /**
   * Entry module for the bundled Lambda function.
   */
  main: string;
  /**
   * Exported handler symbol inside the bundled module.
   * @default "handler"
   */
  handler?: string;
  /**
   * Whether to create a public Lambda function URL.
   * @default false
   */
  url?: boolean;
  functionName?: string;
  // TODO(sam): use a Layer instead so we can manage Effect platform?
  runtime?: "nodejs22.x" | "nodejs24.x";
  build?: FunctionBuildOptions;
  uploadSourceMap?: boolean;
  env?: Record<string, any>;
  exports?: string[];
  /**
   * Attach the function to a VPC for private AWS connectivity such as Aurora.
   */
  vpc?: {
    subnetIds: string[];
    securityGroupIds: string[];
  };
}

export interface Function extends Resource<
  FunctionTypeId,
  FunctionProps,
  {
    functionArn: string;
    functionName: string;
    functionUrl: string | undefined;
    roleName: string;
    roleArn: string;
    code: {
      hash: string;
    };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  }
> {}

export type FunctionServices = Credentials | Region;

export type FunctionShape = Main<FunctionServices>;

/**
 * An AWS Lambda host resource that combines code bundling, IAM role
 * provisioning, and runtime binding collection.
 *
 * `Function` is the canonical runtime host for AWS. Resource bindings attach
 * environment variables and IAM statements during deployment, while the runtime
 * execution context collects listeners and exports from the Effect program.
 *
 * @section Creating Functions
 * @example Basic Function
 * ```typescript
 * const func = yield* Function("OrdersFunction", {
 *   main: "./src/orders.ts",
 * });
 * ```
 *
 * @example Function with URL
 * ```typescript
 * const func = yield* Function("ApiFunction", {
 *   main: "./src/api.ts",
 *   url: true,
 * });
 * ```
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  Serverless.FunctionContext
> = Platform(FunctionTypeId, {
  createExecutionContext: (id: string): Serverless.FunctionContext => {
    const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
    const env: Record<string, any> = {};

    const ctx = {
      Type: FunctionTypeId,
      id,
      env,
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
          env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
          return key;
        }),
      get: <T>(key: string) =>
        Config.string(key)
          .asEffect()
          .pipe(
            Effect.flatMap((val) =>
              Effect.try({
                try: () => JSON.parse(val) as T,
                catch: () => val, // assume it's just a string
              }),
            ),
            Effect.catch((cause) =>
              Effect.die(
                new Error(`Failed to get environment variable: ${key}`, {
                  cause,
                }),
              ),
            ),
          ),
      serve: (handler: HttpEffect) =>
        ctx.listen(makeFunctionHttpHandler(handler)),
      listen: ((
        handler:
          | Serverless.FunctionListener
          | Effect.Effect<Serverless.FunctionListener>,
      ) =>
        Effect.sync(() =>
          Effect.isEffect(handler)
            ? listeners.push(handler)
            : listeners.push(Effect.succeed(handler)),
        )) as any as Serverless.FunctionContext["listen"],
      exports: Effect.sync(() => ({
        // construct an Effect that produces the Function's entrypoint
        // Effect<(event, context) => Promise<any>>
        handler: Effect.map(
          Effect.all(listeners, {
            concurrency: "unbounded",
          }),
          (handlers) =>
            async (event: any, context: lambda.Context): Promise<any> => {
              console.log({ event, handlers });
              for (const handler of handlers) {
                const eff = handler(event);
                if (Effect.isEffect(eff)) {
                  return await eff.pipe(
                    Effect.provideService(HandlerContext, context),
                    Effect.tap(Effect.logDebug),
                    Effect.runPromise,
                  );
                }
              }
              throw new Error("No event handler found");
            },
        ),
      })),
    };
    return ctx;
  },
});

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const accountId = yield* Account;
      const region = yield* Region;
      const fs = yield* FileSystem.FileSystem;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const createFunctionName = (
        id: string,
        functionName: string | undefined,
      ) =>
        Effect.gen(function* () {
          return (
            functionName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
          );
        });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const createPolicyName = (id: string) =>
        createPhysicalName({ id, maxLength: 128 });

      const hashBundle = (code: Uint8Array<ArrayBufferLike>) => sha256(code);

      const createNames = (id: string, functionName: string | undefined) =>
        Effect.gen(function* () {
          const roleName = yield* createRoleName(id);
          const policyName = yield* createPolicyName(id);
          const fn = yield* createFunctionName(id, functionName);
          return {
            roleName,
            policyName,
            functionName: fn,
            roleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
            functionArn: `arn:aws:lambda:${region}:${accountId}:function:${fn}`,
          };
        });

      const attachBindings = Effect.fnUntraced(function* ({
        roleName,
        policyName,
        // functionArn,
        // functionName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        functionArn: string;
        functionName: string;
        bindings: ResourceBinding<Function["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<Function["Binding"]> & { action?: string },
          ) => binding.action !== "delete",
        );
        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, env) => ({ ...acc, ...env }), {});
        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map(
              (stmt: IAM.PolicyStatement) => ({
                ...stmt,
                Sid: stmt.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
              }),
            ) ?? [],
        );

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            } satisfies IAM.PolicyDocument),
          });
        } else {
          yield* iam
            .deleteRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return env;
      });

      const createRoleIfNotExists = Effect.fnUntraced(function* ({
        id,
        roleName,
        vpc,
      }: {
        id: string;
        roleName: string;
        vpc?: FunctionProps["vpc"];
      }) {
        yield* Effect.logDebug(`creating role ${id}`);
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "lambda.amazonaws.com",
                  },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam
                .getRole({
                  RoleName: roleName,
                })
                .pipe(
                  Effect.filterOrFail(
                    (role) => hasTags(tags, role.Role?.Tags),
                    () =>
                      new Error(
                        `Role ${roleName} exists but has incorrect tags`,
                      ),
                  ),
                ),
            ),
          );

        yield* Effect.logDebug(`attaching policy ${id}`);
        yield* iam
          .attachRolePolicy({
            RoleName: roleName,
            PolicyArn:
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          })
          .pipe(Effect.tapError(Effect.logDebug), Effect.tap(Effect.logDebug));

        if (vpc) {
          yield* iam
            .attachRolePolicy({
              RoleName: roleName,
              PolicyArn:
                "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.tap(Effect.logDebug),
            );
        }

        yield* Effect.logDebug(`attached policy ${id}`);
        return role;
      });

      const bundleCode = Effect.fnUntraced(function* (
        id: string,
        props: FunctionProps,
      ) {
        const handler = props.handler ?? "default";
        const sourcemap = props.build?.output?.sourcemap ?? true;
        const uploadSourceMap = props.uploadSourceMap ?? true;

        const realMain = yield* fs.realPath(props.main);
        const cwd = yield* TempRoot.findCwdForBundle(realMain);

        const rolldownSourcemap = sourcemap;

        const buildBundle = Effect.fnUntraced(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              ...props.build?.input,
              input: entry,
              cwd,
              external: [
                /^@aws-sdk\//,
                /^@smithy\//,
                ...((props.build?.input?.external as string[]) ?? []),
              ],
              platform: "node",
              plugins: [props.build?.input?.plugins, plugins],
            },
            {
              ...props.build?.output,
              format: "esm",
              sourcemap: rolldownSourcemap,
              minify: props.build?.output?.minify ?? true,
              entryFileNames: "index.js",
            },
          );
        });

        const bundleOutput = props.isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import { MinimumLogLevel } from "effect/References";

import { ${handler} as layer } from "${importPath}";

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const tag = Context.Service("${FunctionTypeId}<${id}>")

const stack = Layer.effect(
  Stack,
  Effect.all([
    Config.string("ALCHEMY_STACK_NAME").asEffect(),
    Config.string("ALCHEMY_STAGE").asEffect()
  ]).pipe(
    Effect.map(([name, stage]) => ({
      name,
      stage,
      bindings: {},
      resources: {}
    }))
  )
);

const handlerEffect = tag.asEffect().pipe(
  Effect.flatMap(func => func.ExecutionContext.exports.handler),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          process.env.DEBUG ? "Debug" : "Info",
        )
      ),
    )
  ),
  Effect.scoped
);

export default await Effect.runPromise(handlerEffect)
`,
              ),
            );

        const mainFile = bundleOutput.files[0];
        const code =
          typeof mainFile.content === "string"
            ? new TextEncoder().encode(mainFile.content)
            : mainFile.content;

        const sourceMapFile =
          uploadSourceMap && (sourcemap === true || sourcemap === "hidden")
            ? bundleOutput.files.find((f: Bundle.BundleFile) =>
                f.path.endsWith(".map"),
              )
            : undefined;

        const archive = yield* zipCode(
          code,
          sourceMapFile
            ? [
                {
                  path: sourceMapFile.path,
                  content: sourceMapFile.content,
                },
              ]
            : undefined,
        );
        return {
          archive,
          code,
          hash: bundleOutput.hash,
        };
      });

      const withNodeSourceMaps = (
        env: Record<string, string> | undefined,
        props: FunctionProps,
      ) => {
        const sourcemap = props.build?.output?.sourcemap ?? true;
        const uploadSourceMap = props.uploadSourceMap ?? true;
        const shouldEnableSourceMaps =
          sourcemap === "inline" ||
          (uploadSourceMap && (sourcemap === true || sourcemap === "hidden"));

        if (!shouldEnableSourceMaps) {
          return env;
        }

        const current = env?.NODE_OPTIONS;
        if (current?.split(/\s+/).includes("--enable-source-maps")) {
          return env;
        }

        return {
          ...env,
          NODE_OPTIONS: current
            ? `${current} --enable-source-maps`
            : "--enable-source-maps",
        };
      };

      const createOrUpdateFunction = Effect.fnUntraced(function* ({
        id,
        news,
        roleArn,
        archive,
        hash,
        env,
        functionName,
        preferUpdate,
        session,
      }: {
        id: string;
        news: FunctionProps;
        roleArn: string;
        archive: Uint8Array<ArrayBufferLike>;
        hash: string;
        env: Record<string, string> | undefined;
        functionName: string;
        preferUpdate?: boolean;
        session: { note: (note: string) => Effect.Effect<void> };
      }) {
        yield* Effect.logDebug(`creating function ${id}`);
        const waitStartedAt = Date.now();

        const isRolePropagationError = <
          E extends Lambda.UpdateFunctionCodeError | Lambda.CreateFunctionError,
        >(
          e: E,
        ) =>
          e._tag === "InvalidParameterValueException" &&
          (e.message?.includes("cannot be assumed by Lambda") ||
            (e.message?.includes("KMS key is invalid for CreateGrant") &&
              e.message?.includes("ARN does not refer to a valid principal")));

        const noteRolePropagationWait = () =>
          session.note(
            `Waiting for Lambda execution role to become assumable: ${functionName} (${Math.ceil((Date.now() - waitStartedAt) / 1000)}s)`,
          );

        const tags = yield* createInternalTags(id);

        // Try to use S3 if assets bucket is available, otherwise fall back to inline ZipFile
        const assets = (yield* Effect.serviceOption(Assets)).pipe(
          Option.getOrUndefined,
        );

        const codeLocation = yield* Effect.gen(function* () {
          if (assets) {
            const key = yield* assets.uploadAsset(hash, archive);
            yield* Effect.logDebug(
              `Using S3 for code: s3://${assets.bucketName}/${key}`,
            );
            return {
              S3Bucket: assets.bucketName,
              S3Key: key,
            } as const;
          } else {
            return { ZipFile: archive } as const;
          }
        });
        const runtimeEnv = withNodeSourceMaps(env, news);

        const createFunctionRequest: CreateFunctionRequest = {
          FunctionName: functionName,
          Handler: `index.${news.handler ?? "default"}`,
          Role: roleArn,
          Code: codeLocation,
          Runtime: news.runtime ?? "nodejs22.x",
          Environment: runtimeEnv
            ? {
                Variables: {
                  ...runtimeEnv,
                  ...alchemyEnv,
                },
              }
            : undefined,
          Tags: tags,
          VpcConfig: news.vpc
            ? {
                SubnetIds: news.vpc.subnetIds,
                SecurityGroupIds: news.vpc.securityGroupIds,
              }
            : undefined,
        };

        const getAndUpdate = Lambda.getFunction({
          FunctionName: functionName,
        }).pipe(
          Effect.filterOrFail(
            // if it exists and contains these tags, we will assume it was created by alchemy
            // but state was lost, so if it exists, let's adopt it
            (f) => hasTags(tags, f.Tags),
            () =>
              // TODO(sam): add custom
              new Error("Function tags do not match expected values"),
          ),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              yield* Effect.logDebug(`updating function code ${id}`);
              yield* Lambda.updateFunctionCode({
                FunctionName: createFunctionRequest.FunctionName,
                Architectures: createFunctionRequest.Architectures,
                // Use S3 or ZipFile based on what was used for create
                ...("S3Bucket" in codeLocation
                  ? {
                      S3Bucket: codeLocation.S3Bucket,
                      S3Key: codeLocation.S3Key,
                    }
                  : { ZipFile: codeLocation.ZipFile }),
              }).pipe(
                Effect.tapError((e) =>
                  isRolePropagationError(e)
                    ? noteRolePropagationWait()
                    : Effect.void,
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "ResourceConflictException" ||
                    isRolePropagationError(e),
                  schedule: Schedule.exponential(100),
                }),
              );
              yield* Effect.logDebug(`updated function code ${id}`);
              yield* Lambda.updateFunctionConfiguration({
                FunctionName: createFunctionRequest.FunctionName,
                DeadLetterConfig: createFunctionRequest.DeadLetterConfig,
                Description: createFunctionRequest.Description,
                Environment: createFunctionRequest.Environment,
                EphemeralStorage: createFunctionRequest.EphemeralStorage,
                FileSystemConfigs: createFunctionRequest.FileSystemConfigs,
                Handler: createFunctionRequest.Handler,
                ImageConfig: createFunctionRequest.ImageConfig,
                KMSKeyArn: createFunctionRequest.KMSKeyArn,
                Layers: createFunctionRequest.Layers,
                LoggingConfig: createFunctionRequest.LoggingConfig,
                MemorySize: createFunctionRequest.MemorySize,
                // RevisionId: "???"
                Role: createFunctionRequest.Role,
                Runtime: createFunctionRequest.Runtime,
                SnapStart: createFunctionRequest.SnapStart,
                Timeout: createFunctionRequest.Timeout,
                TracingConfig: createFunctionRequest.TracingConfig,
                VpcConfig: createFunctionRequest.VpcConfig,
              }).pipe(
                Effect.tapError((e) =>
                  isRolePropagationError(e)
                    ? noteRolePropagationWait()
                    : Effect.void,
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "ResourceConflictException" ||
                    isRolePropagationError(e),
                  schedule: Schedule.exponential(100),
                }),
              );
              yield* Effect.logDebug(`updated function configuration ${id}`);
            }),
          ),
        );

        const create = Lambda.createFunction(createFunctionRequest).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(e);
            }),
          ),
          Effect.retry({
            while: (e) => isRolePropagationError(e),
            schedule: Schedule.fixed(1000).pipe(
              Schedule.tapOutput(() => noteRolePropagationWait()),
            ),
          }),
          Effect.catchTags({
            ResourceConflictException: () => getAndUpdate,
          }),
        );

        if (preferUpdate) {
          yield* getAndUpdate.pipe(
            Effect.catchTags({
              ResourceNotFoundException: () => create,
            }),
          );
        } else {
          yield* create;
        }
      });

      const createOrUpdateFunctionUrl = Effect.fnUntraced(function* ({
        functionName,
        url = true,
        oldUrl,
      }: {
        functionName: string;
        url: FunctionProps["url"];
        oldUrl?: FunctionProps["url"];
      }) {
        // TODO(sam): support AWS_IAM
        const authType = "NONE";
        yield* Effect.logDebug(`creating function url config ${functionName}`);
        if (url) {
          const config = {
            FunctionName: functionName,
            AuthType: authType, // | AWS_IAM
            // Cors: {
            //   AllowCredentials: true,
            //   AllowHeaders: ["*"],
            //   AllowMethods: ["*"],
            //   AllowOrigins: ["*"],
            //   ExposeHeaders: ["*"],
            //   MaxAge: 86400,
            // },
            InvokeMode: "BUFFERED", // | RESPONSE_STREAM
            // Qualifier: "$LATEST"
          } satisfies
            | Lambda.CreateFunctionUrlConfigRequest
            | Lambda.UpdateFunctionUrlConfigRequest;
          const urlPermission = {
            FunctionName: functionName,
            StatementId: "FunctionURLAllowPublicAccess",
            Action: "lambda:InvokeFunctionUrl",
            Principal: "*",
            FunctionUrlAuthType: "NONE",
          } as const;
          const invokePermission = {
            FunctionName: functionName,
            StatementId: "FunctionURLAllowPublicInvoke",
            Action: "lambda:InvokeFunction",
            Principal: "*",
          } as const;
          const upsertPermission = (permission: Lambda.AddPermissionRequest) =>
            Lambda.addPermission(permission).pipe(
              Effect.catchTag("ResourceConflictException", () =>
                Effect.gen(function* () {
                  yield* Lambda.removePermission({
                    FunctionName: functionName,
                    StatementId: permission.StatementId,
                  });
                  yield* Lambda.addPermission(permission);
                }),
              ),
            );
          const [{ FunctionUrl }] = yield* Effect.all([
            Lambda.createFunctionUrlConfig(config).pipe(
              Effect.catchTag("ResourceConflictException", () =>
                Lambda.updateFunctionUrlConfig(config),
              ),
            ),
            authType === "NONE"
              ? Effect.all([
                  upsertPermission(urlPermission),
                  upsertPermission(invokePermission),
                ])
              : // TODO(sam): support AWS_IAM
                Effect.void,
          ]);
          yield* Effect.logDebug(`created function url config ${functionName}`);
          return FunctionUrl;
        } else if (oldUrl) {
          yield* Effect.logDebug(
            `deleting function url config ${functionName}`,
          );
          yield* Effect.all([
            Lambda.deleteFunctionUrlConfig({
              FunctionName: functionName,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: "FunctionURLAllowPublicAccess",
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: "FunctionURLAllowPublicInvoke",
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
          ]);
          yield* Effect.logDebug(`deleted function url config ${functionName}`);
        }
        return undefined;
      });

      const summary = ({ code }: { code: Uint8Array<ArrayBufferLike> }) =>
        `${
          code.length >= 1024 * 1024
            ? `${(code.length / (1024 * 1024)).toFixed(2)}MB`
            : code.length >= 1024
              ? `${(code.length / 1024).toFixed(2)}KB`
              : `${code.length}B`
        }`;

      return {
        stables: ["functionArn", "functionName", "roleName"],
        diff: Effect.fnUntraced(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          // If output is undefined (resource in creating state), defer to default diff
          if (!output) {
            return undefined;
          }
          if (
            // function name changed
            output.functionName !==
              (yield* createFunctionName(id, news.functionName)) ||
            // url changed
            (olds.url ?? true) !== news.url
          ) {
            return { action: "replace" };
          }
          if (
            output.code.hash !==
            (yield* bundleCode(id, {
              main: news.main,
              handler: news.handler,
              build: news.build,
              uploadSourceMap: news.uploadSourceMap,
            })).hash
          ) {
            // code changed
            return { action: "update" };
          }
        }),
        read: Effect.fnUntraced(function* ({ id, output }) {
          if (output) {
            yield* Effect.logDebug(`reading function ${id}`);
            // example: refresh the function URL from the API
            return {
              ...output,
              functionUrl: (yield* Lambda.getFunctionUrlConfig({
                FunctionName: yield* createFunctionName(
                  id,
                  output.functionName,
                ),
              }).pipe(
                Effect.map((f) => f.FunctionUrl),
                Effect.retry({
                  // TODO(sam): did we lose this error? Is it missing for a good
                  while: (e: any) => e._tag === "ResourceConflictException",
                  schedule: Schedule.exponential(100),
                }),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              )) as any,
            };
          }
          return output;
        }),

        precreate: Effect.fnUntraced(function* ({ id, news, session }) {
          const { roleName, functionName, roleArn } = yield* createNames(
            id,
            news.functionName,
          );

          const role = yield* createRoleIfNotExists({
            id,
            roleName,
            vpc: news.vpc,
          });

          // mock code
          const code = new TextEncoder().encode("export default () => {}");
          const archive = yield* zipCode(code);
          const hash = yield* hashBundle(code);
          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: role.Role.Arn,
            archive,
            hash,
            functionName,
            env: alchemyEnv,
            session,
          });

          return {
            functionArn: `arn:aws:lambda:${region}:${accountId}:function:${functionName}`,
            functionName,
            functionUrl: undefined,
            roleName,
            code: {
              hash,
            },
            roleArn,
          };
        }),
        create: Effect.fnUntraced(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const { roleName, policyName, functionName, functionArn } =
            yield* createNames(id, news.functionName);

          const roleArn =
            output?.roleArn ??
            (yield* createRoleIfNotExists({ id, roleName, vpc: news.vpc })).Role
              .Arn;

          const env = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          const { archive, code, hash } = yield* bundleCode(id, news);

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn,
            archive,
            hash,
            env: {
              ...env,
              ...news.env,
            },
            functionName,
            preferUpdate: output !== undefined,
            session,
          });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.url,
          });

          yield* session.note(summary({ code }));

          return {
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn,
            code: {
              hash,
            },
          };
        }),
        update: Effect.fnUntraced(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          const { roleName, policyName, functionName, functionArn } =
            yield* createNames(id, news.functionName);

          const env = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          const { archive, code, hash } = yield* bundleCode(id, news);

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: output.roleArn,
            archive,
            hash,
            env: {
              ...env,
              ...news.env,
            },
            functionName,
            session,
          });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.url,
            oldUrl: olds.url,
          });

          yield* session.note(summary({ code }));

          return {
            ...output,
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn: output.roleArn,
            code: {
              hash,
            },
          };
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* iam
            .listRolePolicies({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.PolicyNames ?? []).map((policyName) =>
                    iam.deleteRolePolicy({
                      RoleName: output.roleName,
                      PolicyName: policyName,
                    }),
                  ),
                ),
              ),
            );

          yield* iam
            .listAttachedRolePolicies({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.AttachedPolicies ?? []).map((policy) =>
                    iam
                      .detachRolePolicy({
                        RoleName: output.roleName,
                        PolicyArn: policy.PolicyArn!,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
            );

          yield* Lambda.deleteFunction({
            FunctionName: output.functionName,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          yield* iam
            .deleteRole({
              RoleName: output.roleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
          return null as any;
        }),
        tail: ({ output }) => {
          const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${output.functionName}`;

          const runTailSession = Effect.gen(function* () {
            const response = yield* logs.startLiveTail({
              logGroupIdentifiers: [logGroupArn],
            });

            if (!response.responseStream) {
              return Stream.empty as Stream.Stream<LogLine>;
            }

            return response.responseStream.pipe(
              Stream.flatMap((event) => {
                if ("sessionUpdate" in event && event.sessionUpdate) {
                  const lines: LogLine[] = (
                    event.sessionUpdate.sessionResults ?? []
                  ).flatMap((result) => {
                    if (!result.message) return [];
                    return [
                      {
                        timestamp: new Date(result.timestamp ?? Date.now()),
                        message: result.message.trimEnd(),
                      },
                    ];
                  });
                  return Stream.fromIterable(lines);
                }
                return Stream.empty;
              }),
            );
          });

          return Stream.unwrap(runTailSession).pipe(
            Stream.retry(Schedule.spaced("1 second")),
          );
        },
        logs: ({
          output,
          options,
        }: {
          output: Function["Attributes"];
          options: LogsInput;
        }) =>
          logs
            .filterLogEvents({
              logGroupName: `/aws/lambda/${output.functionName}`,
              startTime: options.since?.getTime(),
              limit: options.limit ?? 100,
            })
            .pipe(
              Effect.map((response) =>
                (response.events ?? []).flatMap((event): LogLine[] => {
                  if (!event.message) return [];
                  return [
                    {
                      timestamp: new Date(event.timestamp ?? Date.now()),
                      message: event.message.trimEnd(),
                    },
                  ];
                }),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([] as LogLine[]),
              ),
            ),
      };
    }),
  );
