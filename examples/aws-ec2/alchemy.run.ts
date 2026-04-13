import * as AWS from "alchemy-effect/AWS";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NetworkLive } from "./src/Network.ts";
import Server from "./src/Server.ts";

const aws = AWS.providers().pipe(Layer.provide(AWS.DefaultStageConfig));

const stack = Effect.gen(function* () {
  const instance = yield* Server;

  return {
    instanceId: instance.instanceId,
    publicIpAddress: instance.publicIpAddress,
    instanceUrl: Output.interpolate`http://${instance.publicIpAddress}:3000`,
    enqueueExample: Output.interpolate`http://${instance.publicIpAddress}:3000/enqueue?message=hello`,
  };
}).pipe(Effect.provide(NetworkLive));

export default stack.pipe(Stack.make("AwsEc2Example", aws));
