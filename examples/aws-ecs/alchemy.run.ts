import * as AWS from "alchemy-effect/AWS";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import { Stage } from "alchemy-effect/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import QueueConsumerTask from "./src/QueueConsumerTask.ts";
import ApiTask from "./src/Task.ts";

const awsConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const stage = yield* Stage;

    if (stage === "prod") {
      return {
        account: "123456789012",
        region: "us-west-2",
      };
    }

    return yield* AWS.loadDefaultStageConfig();
  }).pipe(Effect.orDie),
);

const aws = AWS.providers().pipe(Layer.provide(awsConfig));

const stack = Effect.gen(function* () {
  const network = yield* AWS.EC2.Network("ExampleNetwork", {
    cidrBlock: "10.42.0.0/16",
    availabilityZones: 2,
  });

  const serviceSecurityGroup = yield* AWS.EC2.SecurityGroup(
    "ExampleServiceSecurityGroup",
    {
      vpcId: network.vpcId,
      description: "Security group for the ECS example services",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrIpv4: "0.0.0.0/0",
        },
        {
          ipProtocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrIpv4: "0.0.0.0/0",
        },
      ],
    },
  );

  const queue = yield* AWS.SQS.Queue("ExampleJobsQueue", {
    receiveMessageWaitTimeSeconds: 20,
    visibilityTimeout: 60,
  });

  const cluster = yield* AWS.ECS.Cluster("ExampleCluster", {});
  const apiTask = yield* ApiTask;
  const queuePollerTask = yield* QueueConsumerTask;

  const apiService = yield* AWS.ECS.Service("ExampleApiService", {
    cluster,
    task: apiTask,
    vpcId: network.vpcId,
    subnets: network.publicSubnetIds,
    securityGroups: [serviceSecurityGroup.groupId],
    assignPublicIp: true,
    public: true,
    healthCheckPath: "/",
  });

  yield* AWS.ECS.Service("ExampleQueuePollerService", {
    cluster,
    task: queuePollerTask,
    vpcId: network.vpcId,
    subnets: network.publicSubnetIds,
    securityGroups: [serviceSecurityGroup.groupId],
    assignPublicIp: true,
    desiredCount: 1,
  });

  return {
    url: apiService.url,
    queueUrl: queue.queueUrl,
    enqueueExample: Output.interpolate`${apiService.url}/enqueue?message=hello`,
  };
});

export default stack.pipe(Stack.make("AwsEcsExample", aws));
